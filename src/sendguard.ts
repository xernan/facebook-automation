import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { replaceFile } from './files.js';
import { isMessagingBlocked } from './watchguard.js';

// Brakes on every Messenger message the Page sends (bot script, Claude, reminders), so a loop can never flood one
// person again (Nov 3 2026: ~50 messages to one tester, Meta restricted the Page). One file shared by every process
// (the watcher and each Claude run's server):
//   - at most `perMessage` Page messages after each message from the person (a reminder or comment follow-up is exempt);
//   - at most `perMinute` messages a minute to one person;
//   - the same text at most `sameTextPerDay` times a day to one person;
//   - Meta's first "restricted from messaging" answer pauses all sending for `pauseHours`.
// The file holds only ids, times and text hashes: no message text.

export interface GuardLimits {
  perMessage: number;
  perMinute: number;
  sameTextPerDay: number;
  pauseHours: number;
}

export type GuardRule = 'paused' | 'per_message' | 'per_minute' | 'same_text';

interface Sent {
  at: number;
  h: string;
  follow_up?: boolean;
}
interface GuardState {
  paused_until?: number;
  paused_reason?: string;
  people: Record<string, { last_in?: number; sent: Sent[] }>;
}

const DAY = 86_400_000;
const FILE = 'send-guard.json';

/** Why a message was not sent. `rule` tells the caller whether to hold the reply or drop it. */
export class SendGuardError extends Error {
  constructor(
    readonly rule: GuardRule,
    message: string,
    readonly until?: number,
  ) {
    super(message);
    this.name = 'SendGuardError';
  }
}

export const hashText = (text: string) => createHash('sha256').update(text.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex').slice(0, 16);

async function load(dir: string, now: number): Promise<GuardState> {
  let s: GuardState;
  try {
    s = JSON.parse(await fs.readFile(path.join(dir, FILE), 'utf8'));
    if (!s || typeof s !== 'object' || typeof s.people !== 'object') s = { people: {} };
  } catch {
    s = { people: {} };
  }
  for (const [who, p] of Object.entries(s.people)) {
    p.sent = (p.sent ?? []).filter((x) => now - x.at < DAY);
    if (!p.sent.length && (p.last_in ?? 0) < now - DAY) delete s.people[who];
  }
  if (s.paused_until !== undefined && s.paused_until <= now) {
    delete s.paused_until;
    delete s.paused_reason;
  }
  return s;
}

async function save(dir: string, s: GuardState): Promise<void> {
  const tmp = path.join(dir, `${FILE}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(s), 'utf8');
  await replaceFile(tmp, path.join(dir, FILE));
}

/** One process at a time reads and writes the guard file; a lock left by a crashed process is taken over. */
async function locked<T>(dir: string, fn: () => Promise<T>, waitMs = 20_000, staleMs = 60_000): Promise<T> {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'send-guard.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await (await fs.open(lock, 'wx')).close();
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      const age = await fs.stat(lock).then((st) => Date.now() - st.mtimeMs).catch(() => 0);
      if (age > staleMs) {
        await fs.rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error('Another message is being sent. Try again shortly.');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/** The rule that stops this message now, if any. */
export function blockedBy(s: GuardState, who: string | undefined, h: string, followUp: boolean, lim: GuardLimits, now: number): SendGuardError | undefined {
  if (s.paused_until !== undefined && s.paused_until > now) {
    // Same words as Meta's restriction, so every caller already treats it as "stop all sending".
    return new SendGuardError('paused', `Sending paused: Meta restricted this Page from messaging. No messages until ${new Date(s.paused_until).toISOString()}.`, s.paused_until);
  }
  if (!who) return undefined;
  const p = s.people[who];
  if (!p) return undefined;
  const lastMinute = p.sent.filter((x) => now - x.at < 60_000);
  if (lastMinute.length >= lim.perMinute) {
    return new SendGuardError('per_minute', `Not sent: already ${lim.perMinute} messages to this person in the last minute. Wait a minute.`, lastMinute[0]!.at + 60_000);
  }
  if (p.sent.filter((x) => x.h === h).length >= lim.sameTextPerDay) {
    return new SendGuardError('same_text', `Not sent: they already got this exact message ${lim.sameTextPerDay} times today. Say it in other words, or wait for them.`);
  }
  if (!followUp) {
    const since = p.sent.filter((x) => !x.follow_up && x.at >= (p.last_in ?? 0));
    if (since.length >= lim.perMessage) {
      return new SendGuardError('per_message', `Not sent: already ${lim.perMessage} messages since their last message. Wait for them to reply.`);
    }
  }
  return undefined;
}

export class SendGuard {
  private readonly noted = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly lim: GuardLimits,
  ) {}

  /**
   * Checks the rules, sends, and records the message, all under one lock so two processes cannot both pass.
   * `who` is the person's id (undefined for a comment private reply: only the pause applies).
   */
  async send<T>(who: string | undefined, text: string, followUp: boolean, doSend: () => Promise<T>, now = Date.now): Promise<T> {
    return locked(this.dir, async () => {
      const s = await load(this.dir, now());
      const h = hashText(text);
      const stop = blockedBy(s, who, h, followUp, this.lim, now());
      if (stop) throw stop;
      const record = () => {
        if (!who) return;
        const p = (s.people[who] ??= { sent: [] });
        p.sent.push({ at: now(), h, ...(followUp ? { follow_up: true } : {}) });
      };
      try {
        const res = await doSend();
        record();
        await save(this.dir, s);
        return res;
      } catch (err: any) {
        if (isMessagingBlocked(err)) {
          s.paused_until = now() + this.lim.pauseHours * 3_600_000;
          s.paused_reason = 'Meta restricted this Page from messaging';
        } else if (err?.uncertain) record(); // may have reached the person: counts as sent
        await save(this.dir, s);
        throw err;
      }
    });
  }

  /** The person wrote to the Page at `at`: a new allowance of replies starts. */
  async noteIncoming(who: string, at: number): Promise<void> {
    if (!Number.isFinite(at) || (this.noted.get(who) ?? 0) >= at) return; // the watcher calls this every round
    this.noted.set(who, at);
    await locked(this.dir, async () => {
      const s = await load(this.dir, Date.now());
      const p = (s.people[who] ??= { sent: [] });
      if ((p.last_in ?? 0) >= at) return;
      p.last_in = at;
      await save(this.dir, s);
    });
  }

  /** When all sending is paused until (ms), or undefined. */
  async pausedUntil(now = Date.now()): Promise<number | undefined> {
    const s = await load(this.dir, now);
    return s.paused_until;
  }

  /** Why a reply to this person would be held right now (per-message or per-minute), so the watcher does not retry it every second. */
  async holding(who: string, now = Date.now()): Promise<GuardRule | undefined> {
    const s = await load(this.dir, now);
    const stop = blockedBy(s, who, '', false, this.lim, now);
    return stop && stop.rule !== 'same_text' ? stop.rule : undefined;
  }
}
