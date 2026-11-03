import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraphError } from '../src/graph.js';
import { hashText, SendGuard, SendGuardError } from '../src/sendguard.js';
import { isMessagingBlocked } from '../src/watchguard.js';
import { testCtx } from './helpers.js';

// The owner-approved defaults (src/config.ts).
const LIMITS = { perMessage: 2, perMinute: 4, sameTextPerDay: 2, pauseHours: 6 };
const T0 = Date.parse('2026-11-03T10:00:00Z');
const dir = () => mkdtempSync(path.join(tmpdir(), 'guard-'));

/** A guard plus a fake clock and a count of real sends. */
function rig(limits = LIMITS) {
  const d = dir();
  const g = new SendGuard(d, limits);
  let t = T0;
  let sends = 0;
  const send = (text: string, opts: { who?: string; followUp?: boolean; fail?: unknown } = {}) =>
    g.send(opts.who === undefined ? 'p1' : opts.who, text, !!opts.followUp, async () => {
      if (opts.fail) throw opts.fail;
      sends++;
      return { ok: true };
    }, () => t);
  return { d, g, send, tick: (ms: number) => (t += ms), now: () => t, sends: () => sends };
}

const rule = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'sent';
  } catch (e) {
    return e instanceof SendGuardError ? e.rule : `other: ${(e as Error).message}`;
  }
};

describe('send guard', () => {
  it('Nov 3 replay: a loop sending 50 messages to one person with no reply from them gets only 2 through', async () => {
    const r = rig();
    await r.g.noteIncoming('p1', T0 - 1000);
    for (let i = 0; i < 50; i++) {
      await rule(r.send(`Message number ${i}`));
      r.tick(5_000);
    }
    expect(r.sends()).toBe(2);
  });

  it('at most 2 Page messages per message from them; their next message opens 2 more', async () => {
    const r = rig();
    await r.g.noteIncoming('p1', T0 - 1);
    expect(await rule(r.send('a'))).toBe('sent');
    expect(await rule(r.send('b'))).toBe('sent');
    expect(await rule(r.send('c'))).toBe('per_message');
    r.tick(30_000);
    await r.g.noteIncoming('p1', r.now());
    r.tick(1);
    expect(await rule(r.send('c'))).toBe('sent');
    // Another person has their own allowance.
    expect(await rule(r.send('x', { who: 'p2' }))).toBe('sent');
  });

  it('a reminder (follow-up) is exempt from the per-message cap but not from the per-minute cap', async () => {
    const r = rig();
    await r.g.noteIncoming('p1', T0 - 1);
    await r.send('a');
    await r.send('b');
    expect(await rule(r.send('reminder', { followUp: true }))).toBe('sent');
    const fast = rig({ ...LIMITS, perMessage: 5 });
    await fast.g.noteIncoming('p1', T0 - 1);
    for (const t of ['1', '2', '3', '4']) await fast.send(t);
    expect(await rule(fast.send('reminder', { followUp: true }))).toBe('per_minute');
  });

  it('at most 4 a minute to one person; a minute later it may send again', async () => {
    const r = rig({ ...LIMITS, perMessage: 5 });
    await r.g.noteIncoming('p1', T0 - 1);
    for (const t of ['1', '2', '3', '4']) expect(await rule(r.send(t))).toBe('sent');
    expect(await rule(r.send('5'))).toBe('per_minute');
    r.tick(60_000);
    expect(await rule(r.send('5'))).toBe('sent');
  });

  it('the same text at most twice a day per person, even with new messages from them (spacing and case ignored)', async () => {
    const r = rig();
    for (const text of ['Hi! Welcome to CARD MAX', 'hi!  welcome to card max ']) {
      await r.g.noteIncoming('p1', r.now());
      r.tick(1);
      expect(await rule(r.send(text))).toBe('sent');
      r.tick(120_000);
    }
    await r.g.noteIncoming('p1', r.now());
    r.tick(1);
    expect(await rule(r.send('Hi! Welcome to CARD MAX'))).toBe('same_text');
    r.tick(86_400_000);
    await r.g.noteIncoming('p1', r.now());
    r.tick(1);
    expect(await rule(r.send('Hi! Welcome to CARD MAX'))).toBe('sent');
    expect(hashText('A  b')).toBe(hashText('a b'));
  });

  it("Meta's restriction pauses every sender for 6 hours; nothing reaches Meta meanwhile", async () => {
    const r = rig();
    await r.g.noteIncoming('p1', T0 - 1);
    const restricted = new GraphError('restricted', 10, 1893063, 400);
    expect(await rule(r.send('a', { fail: restricted }))).toMatch(/^other/);
    expect(await r.g.pausedUntil(r.now())).toBe(T0 + 6 * 3_600_000);
    // A second process (another Claude run) sees the same pause.
    const other = new SendGuard(r.d, LIMITS);
    const err = await other.send('p9', 'b', false, async () => 'x', r.now).catch((e) => e);
    expect(err).toBeInstanceOf(SendGuardError);
    expect(isMessagingBlocked(err)).toBe(true); // the watcher stops on it like on Meta's own error
    expect(await rule(r.send('c', { who: '' }))).toBe('paused'); // comment private replies too
    expect(r.sends()).toBe(0);
    r.tick(6 * 3_600_000);
    expect(await rule(r.send('d'))).toBe('sent');
    for (const code of [2022, 368]) {
      const q = rig();
      await q.send('a', { fail: new GraphError('x', code) }).catch(() => undefined);
      expect(await q.g.pausedUntil(q.now())).toBeDefined();
    }
  });

  it('other send errors do not pause; a maybe-sent message counts as sent', async () => {
    const r = rig();
    await r.g.noteIncoming('p1', T0 - 1);
    await r.send('a', { fail: new GraphError('down', 2) }).catch(() => undefined);
    expect(await r.g.pausedUntil(r.now())).toBeUndefined();
    await r.send('b', { fail: new GraphError('maybe', undefined, undefined, undefined, true) }).catch(() => undefined);
    await r.send('c');
    expect(await rule(r.send('d'))).toBe('per_message'); // b (maybe sent) + c
  });

  it('two processes sending at the same moment cannot both pass a cap', async () => {
    const r = rig({ ...LIMITS, perMessage: 5 });
    await r.g.noteIncoming('p1', T0 - 1);
    const a = new SendGuard(r.d, { ...LIMITS, perMessage: 5 });
    const b = new SendGuard(r.d, { ...LIMITS, perMessage: 5 });
    let sends = 0;
    const one = (g: SendGuard, i: number) => rule(g.send('p1', `m${i}`, false, async () => void sends++, r.now));
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => one(i % 2 ? a : b, i)));
    expect(sends).toBe(4);
    expect(out.filter((x) => x === 'per_minute')).toHaveLength(6);
  });

  it('a broken guard file starts fresh; the file keeps no message text', async () => {
    const r = rig();
    await r.g.noteIncoming('p1', T0 - 1);
    await r.send('My secret answer 0917');
    const raw = readFileSync(path.join(r.d, 'send-guard.json'), 'utf8');
    expect(raw).not.toMatch(/secret|0917/);
    writeFileSync(path.join(r.d, 'send-guard.json'), '{oops');
    expect(await rule(r.send('again'))).toBe('sent');
    expect(existsSync(path.join(r.d, 'send-guard.lock'))).toBe(false);
  });

  it('every Messenger message through the Graph client passes the guard; "typing" and posts do not count', async () => {
    const { ctx, calls } = testCtx({ FB_SEND_MAX_PER_MESSAGE: '2', FB_SEND_MAX_PER_MIN: '4', FB_SEND_SAME_TEXT_PER_DAY: '2' });
    const msg = (text: string) => ({ recipient: JSON.stringify({ id: '555' }), message: JSON.stringify({ text }), messaging_type: 'RESPONSE' });
    const sentToMeta = () => calls.filter((c) => c.url.pathname.endsWith('/111/messages')).length;
    await ctx.graph.messages.noteIncoming('555', Date.now() - 1000);
    await ctx.graph.post('111', '111/messages', { recipient: JSON.stringify({ id: '555' }), sender_action: 'typing_on' });
    await ctx.graph.post('111', '111/messages', msg('one'));
    await ctx.graph.post('111', '111/messages', msg('two'));
    await expect(ctx.graph.post('111', '111/messages', msg('three'))).rejects.toThrow(/^Not sent: already 2 messages since their last message/);
    expect(sentToMeta()).toBe(3); // typing + two messages
    await ctx.graph.post('111', '111/feed', { message: 'A Page post is not a Messenger message' });
    await ctx.graph.post('111', '111/messages', msg('Reminder'), undefined, { followUp: true });
    expect(sentToMeta()).toBe(4);
  });
});
