import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { flowSchema, type Flow, type Person } from './flow.js';

// Flow state and finished applications. Personal data (Data Privacy Act): it stays in FB_FLOW_DIR on
// this computer and is never committed or logged.

export interface Outbox {
  text: string;
  /** Message ids this reply answers; they count as handled once it is sent. */
  for_messages: string[];
}

export interface FlowState {
  version: 1;
  /** Messages older than this are ignored, so turning the flow on never replies to old chats. */
  started_at: string;
  people: Record<string, Person & { outbox?: Outbox }>;
  /** Handled inbound message ids, oldest first. */
  handled: string[];
}

const HANDLED_KEEP = 5000;

export function loadFlow(file: string): Flow {
  if (!existsSync(file)) {
    throw new Error(`Flow file not found: ${path.basename(file)}. Copy flow.example.json and set FB_FLOW_FILE.`);
  }
  const parsed = flowSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid flow file: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ')}`);
  }
  return parsed.data;
}

export class FlowStore {
  constructor(private readonly dir: string) {}

  private get file() {
    return path.join(this.dir, 'state.json');
  }

  async exists(): Promise<boolean> {
    return fs.access(this.file).then(
      () => true,
      () => false,
    );
  }

  async load(now: Date): Promise<FlowState> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as FlowState;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw new Error('Flow state file is unreadable; fix or move state.json.');
      return { version: 1, started_at: now.toISOString(), people: {}, handled: [] };
    }
  }

  /** Atomic write: a crash mid-save never leaves half a file. */
  async save(state: FlowState): Promise<void> {
    state.handled = state.handled.slice(-HANDLED_KEEP);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `state.${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  /**
   * One writer at a time: Claude Desktop and the watcher's Claude each run their own server process.
   * A lock older than `staleMs` is from a crashed process and is taken over.
   */
  async withLock<T>(fn: () => Promise<T>, waitMs = 10_000, staleMs = 120_000): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true });
    const lock = path.join(this.dir, 'state.lock');
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        await (await fs.open(lock, 'wx')).close();
        break;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        const age = await fs
          .stat(lock)
          .then((s) => Date.now() - s.mtimeMs)
          .catch(() => 0);
        if (age > staleMs) {
          await fs.rm(lock, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error('Flow state is busy (another reply is being sent). Try again shortly.');
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lock, { force: true });
    }
  }

  /** Saves a finished application as its own file. Returns the file name. */
  async saveLead(psid: string, person: Person, idImage: string | undefined, now: Date): Promise<string> {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const name = `lead-${psid}-${stamp}.json`;
    await fs.mkdir(this.dir, { recursive: true });
    const lead = {
      psid,
      completed_at: now.toISOString(),
      consent_at: person.consent_at,
      banks: person.banks,
      married: person.married,
      flags: person.flags ?? [],
      answers: person.answers,
      id_image_file: idImage,
    };
    await fs.writeFile(path.join(this.dir, name), JSON.stringify(lead, null, 2), 'utf8');
    return name;
  }

  /** Downloads the ID photo from Meta's CDN into valid_ids/. Returns the file name, or undefined if it failed. */
  async saveIdImage(
    psid: string,
    url: string,
    now: Date,
    maxBytes: number,
    timeoutMs: number,
    fetchFn: typeof fetch = fetch,
  ): Promise<string | undefined> {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
    // Only Meta's own CDNs; an attachment url is data from a stranger.
    if (!/(^|\.)(fbcdn\.net|fbsbx\.com)$/.test(host)) return undefined;
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/^image\/(jpeg|png|webp)/.test(type)) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > maxBytes) return undefined;
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      const name = `${psid}-${now.toISOString().replace(/[:.]/g, '-')}.${ext}`;
      const dir = path.join(this.dir, 'valid_ids');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), buf);
      return `valid_ids/${name}`;
    } catch {
      return undefined;
    }
  }
}
