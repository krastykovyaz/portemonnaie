import { createMiddleware } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";
import { SlidingWindowLimiter } from "./rate-limit";

const limiters = new Map<string, SlidingWindowLimiter>();

function clientIp(): string {
  try {
    // Only trust X-Forwarded-For when explicitly told we sit behind a proxy
    // (nginx in production). Trusting it unconditionally lets any client
    // pick its own bucket; not trusting it behind a proxy puts every user
    // in nginx's bucket. Set TRUST_PROXY=true on the deployed box.
    return getRequestIP({ xForwardedFor: process.env["TRUST_PROXY"] === "true" }) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Per-IP limit for a public (unauthenticated) server function. Throws a
 * plain Error so the client sees a readable message; TanStack serializes it
 * as the server-function error.
 */
export function rateLimited(name: string, opts: { limit: number; windowMs: number }) {
  return createMiddleware({ type: "function" }).server(async ({ next }) => {
    if (process.env["RATE_LIMIT_DISABLED"] === "true") return next();
    let limiter = limiters.get(name);
    if (!limiter) {
      limiter = new SlidingWindowLimiter(opts.limit, opts.windowMs);
      limiters.set(name, limiter);
    }
    const verdict = limiter.check(`${name}:${clientIp()}`);
    if (!verdict.ok) {
      throw new Error(
        `Too many requests — please try again in ${Math.ceil(verdict.retryAfterMs / 1000)}s.`,
      );
    }
    return next();
  });
}
