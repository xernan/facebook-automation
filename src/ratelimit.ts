// Sliding-window limiter: at most `perMinute` calls in any 60s window.
export class RateLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when the call may proceed, otherwise ms to wait. */
  take(): number {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length >= this.perMinute) {
      return 60_000 - (t - this.stamps[0]!);
    }
    this.stamps.push(t);
    return 0;
  }
}
