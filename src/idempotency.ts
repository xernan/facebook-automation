// Stops double posts/replies/messages when Claude retries a write with the same key.
// Concurrent calls with the same key share one in-flight request.
type Entry = { promise: Promise<unknown>; expires: number };

export class IdempotencyStore {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async run<T>(key: string | undefined, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    if (!key) return { result: await fn(), replayed: false };
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expires <= t) this.entries.delete(k);

    const existing = this.entries.get(key);
    if (existing) return { result: (await existing.promise) as T, replayed: true };

    const promise = fn();
    this.entries.set(key, { promise, expires: t + this.ttlMs });
    try {
      return { result: await promise, replayed: false };
    } catch (err) {
      // A failed write may be retried with the same key.
      this.entries.delete(key);
      throw err;
    }
  }
}
