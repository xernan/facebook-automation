import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { advance, newPerson, parseYesNo, type Person } from '../src/flow.js';
import { FlowStore, loadFlow } from '../src/flowstore.js';
import { callTool, tools } from '../src/tools.js';
import { param, testCtx, type Call } from './helpers.js';

const EXAMPLE = path.resolve('flow.example.json');
const flow = loadFlow(EXAMPLE);
const NOW = new Date('2026-10-25T12:00:00Z');
const run = (p: Person, text: string, image_url?: string, now = NOW) => advance(flow, p, { text, image_url }, now, 180);

/** Walk a person through the script; returns the final result. */
function walk(...answers: (string | { image: string })[]) {
  let r = run(newPerson(NOW), 'hi');
  for (const a of answers) r = typeof a === 'string' ? run(r.person, a) : run(r.person, '', a.image);
  return r;
}

describe('parseYesNo (old bot bug: substring "no" rejected real yeses)', () => {
  it.each([
    ['Oo, meron ako noon', 'yes'],
    ['meron po', 'yes'],
    ['YES', 'yes'],
    ['Opo', 'yes'],
    ['wala pa', 'no'],
    ['hindi pa po', 'no'],
    ['No', 'no'],
  ])('%s -> %s', (t, want) => expect(parseYesNo(t)).toBe(want));

  it.each(['Oo, wala pang 1 year', 'Yes, no annual fee yung akin', 'magkano po?', ''])(
    'unclear "%s" is asked again, never read as no',
    (t) => expect(parseYesNo(t)).toBeUndefined(),
  );
});

describe('advance (script)', () => {
  it('first message sends greeting + consent', () => {
    const r = run(newPerson(NOW), 'hello');
    expect(r.reply).toContain(flow.greeting);
    expect(r.reply).toContain(flow.consent.prompt);
    expect(r.person.stage).toBe('consent');
  });

  it('declined consent stores nothing and stops', () => {
    const r = walk('hindi');
    expect(r.person.stage).toBe('declined');
    expect(r.person.consent_at).toBeUndefined();
    expect(r.reply).toBe(flow.consent.decline_reply);
  });

  it('unclear answer repeats the question and does not move on', () => {
    const r = walk('yes', 'Oo, wala pang 1 year');
    expect(r.person.stage).toBe('carded');
    expect(r.reply).toContain(flow.carded.prompt);
  });

  it('no credit card -> reject with 180-day cooldown, silent during cooldown, restarts after', () => {
    const r = walk('yes', 'wala pa');
    expect(r.person.stage).toBe('rejected');
    expect(r.reply).toBe(flow.carded.reject_reply);
    expect(new Date(r.person.cooldown_until!).getTime() - NOW.getTime()).toBe(180 * 86_400_000);

    const during = run(r.person, 'hello ulit', undefined, new Date(NOW.getTime() + 179 * 86_400_000));
    expect(during.reply).toBeUndefined();
    expect(during.person.stage).toBe('rejected');

    const after = run(r.person, 'hello ulit', undefined, new Date(NOW.getTime() + 181 * 86_400_000));
    expect(after.person.stage).toBe('consent');
    expect(after.reply).toContain(flow.consent.prompt);
  });

  it('cards from all 4 excluded banks -> excluded', () => {
    const r = walk('yes', 'oo', 'BPI, Metro Bank, RCBC at East West');
    expect(r.person.stage).toBe('excluded');
    expect(r.reply).toBe(flow.banks.excluded_reply);
  });

  it('3 of the 4 banks -> continues', () => {
    const r = walk('yes', 'oo', 'BPI, Metrobank, RCBC');
    expect(r.person.stage).toBe('steps');
    expect(r.reply).toBe(flow.steps[0]!.prompt);
  });

  it('no bank named -> asks again', () => {
    const r = walk('yes', 'oo', 'marami po');
    expect(r.person.stage).toBe('banks');
    expect(r.reply).toBe(flow.banks.unknown_reply);
  });

  it('single applicant skips spouse; ID must be a photo; completes', () => {
    let r = walk('yes', 'oo', 'BDO', 'Juan Cruz, single', '09171234567');
    expect(r.person.stage).toBe('id_photo');
    r = run(r.person, 'eto po ID number ko 123');
    expect(r.reply).toBe(flow.id_photo.need_image_reply);
    r = run(r.person, '', 'https://scontent.fbcdn.net/x.jpg');
    expect(r.completed).toBe(true);
    expect(r.person.stage).toBe('done');
    expect(r.person.answers).toEqual({ personal: 'Juan Cruz, single', contact: '09171234567' });
  });

  it('married applicant gets the spouse question', () => {
    const r = walk('yes', 'oo', 'BDO', 'Juan Cruz, married', '09171234567');
    expect(r.person.stage).toBe('steps');
    expect(r.reply).toBe(flow.steps[2]!.prompt);
  });

  it('after done, the script stays quiet (Claude answers)', () => {
    const r = walk('yes', 'oo', 'BDO', 'single', '0917', { image: 'https://x.fbcdn.net/a.jpg' });
    expect(run(r.person, 'salamat').reply).toBeUndefined();
  });
});

// ---- tools against a fake Graph API ----------------------------------------
const PSID = '999';
const tool = (name: string) => tools.find((t) => t.name === name)!;

function setup(messages: Record<string, { text?: string; from?: string; image?: string; time?: string }>, opts: { failSend?: 'error' | 'uncertain' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flow-'));
  const env = { FB_WRITE_ENABLED: 'true', FB_FLOW_FILE: EXAMPLE, FB_FLOW_DIR: dir };
  const sent: string[] = [];
  const msg = (mid: string) => {
    const m = messages[mid]!;
    return {
      id: mid,
      message: m.text ?? '',
      from: { id: m.from ?? PSID },
      created_time: m.time ?? new Date().toISOString(),
      attachments: m.image ? { data: [{ mime_type: 'image/jpeg', image_data: { url: m.image } }] } : undefined,
    };
  };
  const { ctx, calls } = testCtx(env, (c: Call) => {
    const p = c.url.pathname;
    if (p.endsWith('/111/messages')) {
      if (opts.failSend === 'error') return { status: 500, json: { error: { code: 2, message: 'down' } } };
      sent.push(JSON.parse(param(c, 'message')!).text);
      return { json: { message_id: 'm_out' } };
    }
    if (p.endsWith('/111/conversations')) {
      return {
        json: {
          data: [
            {
              updated_time: new Date().toISOString(),
              participants: { data: [{ id: PSID, name: 'Tester' }, { id: '111', name: 'Page' }] },
              messages: { data: Object.keys(messages).reverse().map(msg) },
            },
          ],
        },
      };
    }
    const mid = p.split('/').pop()!;
    if (messages[mid]) return { json: msg(mid) };
    return { json: {} };
  });
  if (opts.failSend === 'uncertain') {
    const orig = ctx.graph.post.bind(ctx.graph);
    ctx.graph.post = (async (...a: Parameters<typeof orig>) => {
      if (String(a[1]).endsWith('/messages')) throw Object.assign(new Error('maybe'), { uncertain: true });
      return orig(...a);
    }) as typeof ctx.graph.post;
  }
  return { ctx, calls, sent, dir };
}

const answer = (ctx: any, ids: string[], kind: 'answer' | 'question' = 'answer') =>
  callTool(tool('fb_flow_answer'), { page_id: '111', psid: PSID, message_ids: ids, kind }, ctx) as Promise<any>;

describe('flow tools', () => {
  it('pending lists only unhandled messages from the person, oldest first', async () => {
    const { ctx } = setup({ m_1: { text: 'hi' }, m_2: { text: 'page reply', from: '111' }, m_3: { text: 'hello?' } });
    const out: any = await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].messages.map((m: any) => m.id)).toEqual(['m_1', 'm_3']);
    expect(out[0].stage).toBe('new');
    expect(out[0].can_reply).toBe(true);
  });

  it('ignores messages older than the first run (never replies to old chats)', async () => {
    const { ctx } = setup({ m_old: { text: 'hi', time: '2020-01-01T00:00:00Z' } });
    expect(await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx)).toEqual([]);
  });

  it('answer sends the script reply once; the same message twice does nothing', async () => {
    const { ctx, sent } = setup({ m_1: { text: 'hi' } });
    const r = await answer(ctx, ['m_1']);
    expect(r.stage).toBe('consent');
    expect(sent).toHaveLength(1);
    expect((await answer(ctx, ['m_1'])).note).toBe('Already handled.');
    expect(sent).toHaveLength(1);
    expect(await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx)).toEqual([]);
  });

  it('refuses a message that is not from this person', async () => {
    const { ctx, sent } = setup({ m_x: { text: 'hi', from: '555' } });
    await expect(answer(ctx, ['m_x'])).rejects.toThrow(/not from this person/);
    expect(sent).toHaveLength(0);
  });

  it('kind=question marks handled without moving the script', async () => {
    const { ctx, sent } = setup({ m_1: { text: 'hi' }, m_2: { text: 'magkano annual fee?' } });
    await answer(ctx, ['m_1']);
    const r = await answer(ctx, ['m_2'], 'question');
    expect(r.stage).toBe('consent');
    expect(r.current_question).toContain('Do you agree');
    expect(sent).toHaveLength(1);
  });

  it('a failed send is saved and resent exactly once, without running the script twice', async () => {
    const s1 = setup({ m_1: { text: 'hi' } }, { failSend: 'error' });
    await expect(answer(s1.ctx, ['m_1'])).rejects.toThrow();
    const st = await new FlowStore(s1.dir).load(new Date());
    expect(st.people[PSID]!.outbox?.text).toContain('Do you agree');
    expect(st.people[PSID]!.stage).toBe('consent');

    // Network back: same dir, working send.
    const s2 = setup({ m_1: { text: 'hi' } });
    (s2.ctx.cfg as any).flowDir = s1.dir;
    const r = await answer(s2.ctx, ['m_1']);
    expect(r.resent_earlier_reply).toContain('Do you agree');
    expect(s2.sent).toHaveLength(1);
    expect((await new FlowStore(s1.dir).load(new Date())).people[PSID]!.stage).toBe('consent');
  });

  it('a maybe-sent reply is not sent again', async () => {
    const { ctx, sent, dir } = setup({ m_1: { text: 'hi' } }, { failSend: 'uncertain' });
    const r = await answer(ctx, ['m_1']);
    expect(r.note).toMatch(/may not have gone through/);
    const st = await new FlowStore(dir).load(new Date());
    expect(st.people[PSID]!.outbox).toBeUndefined();
    expect(st.handled).toContain('m_1');
    expect(sent).toHaveLength(0);
  });

  it('outside the reply window: nothing is sent', async () => {
    const { ctx, sent, dir } = setup({ m_1: { text: 'hi' } });
    await new FlowStore(dir).save({ version: 1, started_at: '2020-01-01T00:00:00Z', people: {}, handled: [] });
    const old = setup({ m_1: { text: 'hi', time: new Date(Date.now() - 30 * 3_600_000).toISOString() } });
    (old.ctx.cfg as any).flowDir = dir;
    const r = await answer(old.ctx, ['m_1']);
    expect(r.note).toMatch(/24-hour/);
    expect(sent.length + old.sent.length).toBe(0);
  });

  it('full application saves a lead file; ID from a non-Meta host is not downloaded', async () => {
    const msgs = {
      m_1: { text: 'hi' },
      m_2: { text: 'yes' },
      m_3: { text: 'oo' },
      m_4: { text: 'BDO' },
      m_5: { text: 'Juan, single' },
      m_6: { text: '09171234567' },
      m_7: { image: 'https://evil.example.com/id.jpg' },
    };
    const { ctx, dir } = setup(msgs);
    let r: any;
    for (const mid of Object.keys(msgs)) r = await answer(ctx, [mid]);
    expect(r.stage).toBe('done');
    expect(r.lead_saved).toMatch(/^lead-999-/);
    const lead = JSON.parse(readFileSync(path.join(dir, r.lead_saved), 'utf8'));
    expect(lead.banks).toEqual(['BDO']);
    expect(lead.answers.contact).toBe('09171234567');
    expect(lead.consent_at).toBeTruthy();
    expect(lead.id_image_file).toBeUndefined();
    expect(existsSync(path.join(dir, 'valid_ids'))).toBe(false);
  });

  it('status shows counts only, no personal details', async () => {
    const { ctx } = setup({ m_1: { text: 'hi' } });
    await answer(ctx, ['m_1']);
    const s: any = await callTool(tool('fb_flow_status'), {}, ctx);
    expect(s.stages).toEqual({ consent: 1 });
    expect(JSON.stringify(s)).not.toContain(PSID);
  });

  it('reset needs confirm and forgets the person', async () => {
    const { ctx, dir } = setup({ m_1: { text: 'hi' } });
    await answer(ctx, ['m_1']);
    await expect(callTool(tool('fb_flow_reset'), { psid: PSID }, ctx)).rejects.toThrow();
    expect(await callTool(tool('fb_flow_reset'), { psid: PSID, confirm: true }, ctx)).toEqual({ reset: true });
    expect((await new FlowStore(dir).load(new Date())).people[PSID]).toBeUndefined();
    expect(readdirSync(dir).some((f) => f.endsWith('.lock'))).toBe(false);
  });
});

describe('saveIdImage', () => {
  const ok = (type: string, size = 10) =>
    (async () => new Response(new Uint8Array(size), { headers: { 'content-type': type } })) as unknown as typeof fetch;

  it('saves a Meta CDN image', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'img-'));
    const f = await new FlowStore(dir).saveIdImage('9', 'https://scontent.fmnl4-1.fna.fbcdn.net/a.jpg', NOW, 1000, 1000, ok('image/jpeg'));
    expect(f).toMatch(/^valid_ids\/9-.*\.jpg$/);
    expect(existsSync(path.join(dir, f!))).toBe(true);
  });

  it.each([
    ['non-Meta host', 'https://fbcdn.net.evil.com/a.jpg', ok('image/jpeg')],
    ['not an image', 'https://x.fbcdn.net/a', ok('text/html')],
    ['too big', 'https://x.fbcdn.net/a.jpg', ok('image/jpeg', 2000)],
  ])('refuses %s', async (_n, url, fn) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'img-'));
    expect(await new FlowStore(dir).saveIdImage('9', url, NOW, 1000, 1000, fn)).toBeUndefined();
  });
});

describe('watcher prompt', () => {
  it('names the page, limits Claude to the flow, and forbids asking for card secrets', async () => {
    const { operatorPrompt } = await import('../src/watch.js');
    const p = operatorPrompt('123');
    expect(p).toContain('page_id 123');
    expect(p).toMatch(/Never ask for a card number, CVV, OTP, PIN/);
    expect(p).toMatch(/Never promise approval/);
  });
});
