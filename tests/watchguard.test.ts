import { loadConfig } from '../src/config.js';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraphError, metaUsagePct } from '../src/graph.js';
import { ChatCheck, ClaudeBrake, claudeFailureReason, collectOutput, isMessagingBlocked, pendingKey, runClaudeProcess, takeLock } from '../src/watchguard.js';

describe('quick check before reading all chats', () => {
  const T = 1_000_000;

  it('reads all chats on a change and while it settles, then only every so often', () => {
    const c = new ChatCheck(30_000, 4000);
    expect(c.needsFull('a', false, T)).toBe(true);
    expect(c.needsFull('a', false, T + 1000)).toBe(true); // a second message can share the same second
    expect(c.needsFull('a', false, T + 5000)).toBe(false);
    expect(c.needsFull('b', false, T + 6000)).toBe(true);
    expect(c.needsFull('b', false, T + 11_000)).toBe(false);
    expect(c.needsFull('b', false, T + 40_000)).toBe(true); // the regular full read
  });

  it('work left from the last round forces a read', () => {
    const c = new ChatCheck(30_000, 4000);
    c.needsFull('a', false, T);
    expect(c.needsFull('a', true, T + 5000)).toBe(true);
  });
});

describe('Meta usage', () => {
  it('takes the highest number from either header', () => {
    expect(metaUsagePct('{"call_count":15,"total_cputime":0,"total_time":6}', '{"1":[{"call_count":80,"total_cputime":3,"total_time":1}]}')).toBe(80);
    expect(metaUsagePct('{"call_count":15}', null)).toBe(15);
  });

  it('no header or a broken one changes nothing', () => {
    expect(metaUsagePct(null, null)).toBeUndefined();
    expect(metaUsagePct('nope', null)).toBeUndefined();
  });
});

describe('watcher brakes', () => {
  it('a failing Claude run is not repeated every few seconds for the same chats (1, 2, 4 ... 30 min)', () => {
    const b = new ClaudeBrake(60, 1800);
    const t = 1_000_000;
    expect(b.canRun('k', t)).toBe(true);
    expect(b.done('k', false, 'k', t)).toBe(60);
    expect(b.canRun('k', t + 5_000)).toBe(false);
    expect(b.canRun('k', t + 60_000)).toBe(true);
    expect(b.done('k', false, 'k', t + 60_000)).toBe(120);
    for (let i = 0; i < 10; i++) b.done('k', false, 'k', t);
    expect(b.done('k', false, 'k', t)).toBe(1800);
  });

  it('a run that exits fine but leaves the same chats waiting also backs off; new messages try at once', () => {
    const b = new ClaudeBrake(60, 1800);
    expect(b.done('k', true, 'k', 0)).toBe(60);
    expect(b.canRun('k', 1000)).toBe(false);
    expect(b.canRun('k2', 1000)).toBe(true);
    expect(b.done('k2', true, '', 1000)).toBe(0);
    expect(b.canRun('k', 1000)).toBe(true);
  });

  it('pendingKey changes when a new message arrives', () => {
    const a = pendingKey([{ psid: '1', outbox_pending: true, messages: [{ id: 'm_1' }] }]);
    const b = pendingKey([{ psid: '1', outbox_pending: true, messages: [{ id: 'm_1' }, { id: 'm_2' }] }]);
    expect(a).not.toBe(b);
  });

  it('Meta messaging restriction (2022) and spam block (368) are recognised', () => {
    expect(isMessagingBlocked(new GraphError("(#2022) You're temporarily restricted from messaging users until November 21", 2022, 1404078))).toBe(true);
    expect(isMessagingBlocked(new GraphError('spam', 368))).toBe(true);
    expect(isMessagingBlocked(new GraphError('rate', 4))).toBe(false);
  });

  it('only one watcher runs at a time', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lock-'));
    const release = takeLock(dir);
    // This test process is alive, so a second watcher (another pid) is refused.
    expect(() => takeLock(dir, process.pid + 1_000_000)).toThrow(/already running/);
    release();
    expect(() => takeLock(dir, 123)()).not.toThrow();
    // A lock left by a dead process is taken over.
    writeFileSync(path.join(dir, 'watch.lock'), '999999999');
    expect(() => takeLock(dir)()).not.toThrow();
  });
});

describe('failed Claude runs', () => {
  it('logs the API error line and never other output', () => {
    expect(claudeFailureReason('chat text from a client\nAPI Error: 400 version too old\nmore chat')).toBe('API Error: 400 version too old');
    expect(claudeFailureReason('chat text from a client')).toBe('no API error shown');
  });

  it('collects both output streams', () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output = collectOutput({ stdout, stderr });
    stdout.emit('data', 'a');
    stderr.emit('data', 'b');
    expect(output()).toBe('ab');
  });
});

describe('starting Claude', () => {
  it('a spawn that throws is a failed run, so the brake still counts it', async () => {
    const logs: string[] = [];
    const code = await runClaudeProcess(
      () => {
        throw new Error('spawn UNKNOWN');
      },
      1000,
      (m) => logs.push(m),
    );
    expect(code).toBeNull();
    expect(logs).toEqual(['Could not start Claude: spawn UNKNOWN']);
  });
});

describe('watch timing defaults', () => {
  it('checks every 2 s when quiet and every 1 s while chatting', () => {
    const cfg = loadConfig({}, '.', { requireToken: false });
    expect([cfg.FB_WATCH_INTERVAL_SEC, cfg.FB_WATCH_ACTIVE_INTERVAL_SEC]).toEqual([2, 1]);
  });
});
