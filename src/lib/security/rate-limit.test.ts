import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "./rate-limit";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit inside a window, then refuses with a retry hint", () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(3, 60_000, c.now);
    expect(limiter.check("ip1").ok).toBe(true);
    expect(limiter.check("ip1").ok).toBe(true);
    expect(limiter.check("ip1").ok).toBe(true);
    const fourth = limiter.check("ip1");
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.retryAfterMs).toBe(60_000);
  });

  it("keys are independent", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, clock().now);
    expect(limiter.check("a").ok).toBe(true);
    expect(limiter.check("b").ok).toBe(true);
    expect(limiter.check("a").ok).toBe(false);
  });

  it("slides: capacity returns as old hits age out", () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 10_000, c.now);
    limiter.check("k");
    c.advance(5_000);
    limiter.check("k");
    expect(limiter.check("k").ok).toBe(false);
    c.advance(5_001); // first hit is now outside the window
    expect(limiter.check("k").ok).toBe(true);
    expect(limiter.check("k").ok).toBe(false);
  });

  it("prune drops idle keys so memory doesn't grow with every IP ever seen", () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(5, 1_000, c.now);
    for (let i = 0; i < 50; i++) limiter.check(`ip${i}`);
    expect(limiter.size).toBe(50);
    c.advance(2_000);
    limiter.prune();
    expect(limiter.size).toBe(0);
  });
});
