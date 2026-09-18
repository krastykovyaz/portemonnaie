import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, upstreamTimeoutMs } from "./fetch-with-timeout";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["UPSTREAM_TIMEOUT_MS"];
  });

  it("rejects with UPSTREAM_TIMEOUT when the upstream never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = init.signal?.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError";
              reject(err);
            });
          }),
      ),
    );
    await expect(fetchWithTimeout("https://example.test/slow", {}, 20)).rejects.toThrow(
      /UPSTREAM_TIMEOUT: example.test did not respond within 20ms/,
    );
  });

  it("passes a fast response straight through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const res = await fetchWithTimeout("https://example.test/fast", {}, 1_000);
    expect(res.status).toBe(200);
  });

  it("always attaches an abort signal to the underlying fetch", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", spy);
    await fetchWithTimeout("https://example.test/x", { method: "POST" });
    const init = spy.mock.calls[0]![1]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("POST");
  });

  it("reads the deadline from UPSTREAM_TIMEOUT_MS with a sane fallback", () => {
    expect(upstreamTimeoutMs()).toBe(10_000);
    process.env["UPSTREAM_TIMEOUT_MS"] = "2500";
    expect(upstreamTimeoutMs()).toBe(2500);
    process.env["UPSTREAM_TIMEOUT_MS"] = "nope";
    expect(upstreamTimeoutMs()).toBe(10_000);
  });
});
