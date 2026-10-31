import type { ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Brakes for the watcher, so a problem never turns into a loop: Claude is not woken again and again for the
// same stuck chats (each run costs usage), replies stop while Meta has the Page restricted from messaging, and
// only one watcher runs at a time.

// Keeps only the "API Error" line of a failed Claude run: other output can quote chats, and logs must not.
export function claudeFailureReason(output: string): string {
  return /^API Error: .{1,300}/m.exec(output)?.[0] ?? 'no API error shown';
}

export function collectOutput(child: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null }): () => string {
  let text = '';
  const add = (d: unknown) => {
    text = (text + String(d)).slice(-8000);
  };
  child.stdout?.on('data', add);
  child.stderr?.on('data', add);
  return () => text;
}

// spawn can throw instead of emitting 'error' (e.g. while the program is being updated); both end as a failed run for ClaudeBrake.
export function runClaudeProcess(start: () => ChildProcess, timeoutMs: number, log: (m: string) => void): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = start();
    } catch (err) {
      log(`Could not start Claude: ${err instanceof Error ? err.message : String(err)}`);
      resolve(null);
      return;
    }
    const output = collectOutput(child);
    const timer = setTimeout(() => {
      log('Claude run took too long; stopped it.');
      child.kill();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      log(`Could not start Claude: ${err.message}`);
      resolve(null);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) log(`Claude failed: ${claudeFailureReason(output())}`);
      resolve(code);
    });
  });
}

/** Meta: the Page may not message people for now (2022) or the message looked like spam (368). */
export const isMessagingBlocked = (err: unknown) => {
  const e = err as { code?: number; message?: string } | undefined;
  return e?.code === 2022 || e?.code === 368 || /restricted from messaging/i.test(e?.message ?? '');
};

export class ClaudeBrake {
  private failures = 0;
  private until = 0;
  private lastKey = '';

  constructor(
    private readonly baseSec = 60,
    private readonly maxSec = 1800,
  ) {}

  /** May Claude be woken now for chats identified by `key`? */
  canRun(key: string, now = Date.now()): boolean {
    if (key !== this.lastKey) return true; // new messages: try right away
    return now >= this.until;
  }

  /**
   * After a run: a failed run, or one that left the very same chats waiting, waits 1, 2, 4 ... up to 30 minutes
   * before the next try for those chats. Returns the wait in seconds (0 = fine).
   */
  done(key: string, ok: boolean, keyAfter: string, now = Date.now()): number {
    const stuck = !ok || (keyAfter !== '' && keyAfter === key);
    if (!stuck) {
      this.failures = 0;
      this.until = 0;
      this.lastKey = '';
      return 0;
    }
    this.failures++;
    const wait = Math.min(this.baseSec * 2 ** (this.failures - 1), this.maxSec);
    this.until = now + wait * 1000;
    this.lastKey = keyAfter || key;
    return wait;
  }
}

/**
 * Reading all chats takes over a second, so the watcher first asks only when the newest chat changed. Meta's time has
 * whole seconds, so a second message in the same second could look like no change: it keeps reading for `settleMs`.
 */
export class ChatCheck {
  private seen: string | undefined;
  private changedAt = 0;
  private fullAt = 0;

  constructor(
    private readonly fullEveryMs: number,
    private readonly settleMs = 4000,
  ) {}

  needsFull(latest: string | undefined, force: boolean, now = Date.now()): boolean {
    if (latest !== this.seen) {
      this.seen = latest;
      this.changedAt = now;
    }
    if (!force && now - this.changedAt >= this.settleMs && now - this.fullAt < this.fullEveryMs) return false;
    this.fullAt = now;
    return true;
  }
}

/** One key for the chats waiting now: who, their newest unhandled message, and a waiting outbox. */
export function pendingKey(list: { psid: string; outbox_pending: boolean; needs_id_review?: boolean; messages: { id: string }[] }[]): string {
  return list
    .map((p) => `${p.psid}:${p.messages.at(-1)?.id ?? ''}:${p.outbox_pending ? 'o' : ''}${p.needs_id_review ? 'i' : ''}`)
    .sort()
    .join('|');
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
};

/** Only one watcher: takes <dir>/watch.lock, or throws when another live watcher holds it. */
export function takeLock(dir: string, pid = process.pid, name = 'watch.lock'): () => void {
  const file = path.join(dir, name);
  try {
    const other = Number(readFileSync(file, 'utf8').trim());
    if (other && other !== pid && alive(other)) throw new Error(`Another watcher is already running (process ${other}). Stop it first.`);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  writeFileSync(file, String(pid), 'utf8');
  return () => {
    try {
      if (readFileSync(file, 'utf8').trim() === String(pid)) rmSync(file);
    } catch {
      // already gone
    }
  };
}
