// Stops double posts/replies/messages when Claude retries a write with the same key.
// Concurrent calls with the same key share one in-flight request.
type Entry = { promise: Promise<unknown>; expires: number; fingerprint: string };

export class IdempotencyStore {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** `fingerprint` names the action; reusing a key for a different action is refused, not skipped. */
  async run<T>(key: string | undefined, fn: () => Promise<T>, fingerprint = ''): Promise<{ result: T; replayed: boolean }> {
    if (!key) return { result: await fn(), replayed: false };
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expires <= t) this.entries.delete(k);

    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error('This idempotency_key was already used for a different action. Use a new key.');
      }
      return { result: (await existing.promise) as T, replayed: true };
    }

    const promise = fn();
    this.entries.set(key, { promise, expires: t + this.ttlMs, fingerprint });
    try {
      return { result: await promise, replayed: false };
    } catch (err) {
      // A failed write may be retried with the same key, unless it may have gone through
      // (timeout mid-request): then the key keeps failing so a retry cannot post twice.
      if (!(err as { uncertain?: boolean })?.uncertain) this.entries.delete(key);
      throw err;
    }
  }
}
