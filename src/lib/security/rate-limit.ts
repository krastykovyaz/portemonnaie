/**
 * In-memory sliding-window limiter. This app is a single process (sql.js
 * already forces that), so per-process state is the real global state.
 */
export type LimitVerdict = { ok: true } | { ok: false; retryAfterMs: number };

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  private checksSincePrune = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): LimitVerdict {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, recent[0]! + this.windowMs - t) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (++this.checksSincePrune >= 1_000) this.prune(t);
    return { ok: true };
  }

  /** Drops keys with no hits inside the window so distinct IPs can't grow memory unbounded. */
  prune(now: number = this.now()): void {
    this.checksSincePrune = 0;
    const cutoff = now - this.windowMs;
    for (const [key, stamps] of this.hits) {
      if (!stamps.some((ts) => ts > cutoff)) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
