const DEFAULT_TIMEOUT_MS = 10_000;

export function upstreamTimeoutMs(): number {
  const raw = Number(process.env["UPSTREAM_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * `fetch` with a hard deadline. Every upstream call (TronGrid, a rental
 * marketplace) goes through here so a hung provider can never pin a
 * redemption request or an SSR worker open indefinitely. A caller-supplied
 * signal is honored too — whichever aborts first wins.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = upstreamTimeoutMs(),
): Promise<Response> {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (init.signal) signals.push(init.signal);
  const signal = typeof AbortSignal.any === "function" ? AbortSignal.any(signals) : signals[0]!;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`UPSTREAM_TIMEOUT: ${new URL(url).host} did not respond within ${timeoutMs}ms`);
    }
    throw error;
  }
}
