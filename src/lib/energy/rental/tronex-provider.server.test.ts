import { afterEach, describe, expect, it, vi } from "vitest";
import { TronexEnergyRentalProvider } from "./tronex-provider.server";
import type { EnergyRentalProvider } from "./types";

/**
 * Verifies the adapter against exact response shapes taken from Tronex's
 * published OpenAPI 3.0.3 spec (https://api.tronex.energy/api/v1/openapi.json,
 * fetched 2026-09-07) -- these are not invented example payloads.
 */
describe("TronexEnergyRentalProvider", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  const provider = new TronexEnergyRentalProvider({ apiKey: "test-key", apiUrl: "https://api.tronex.energy" });

  it("getQuote posts to /api/v1/precountOrder with the X-API-KEY header and parses the documented response", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.tronex.energy/api/v1/precountOrder");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["X-API-KEY"]).toBe("test-key");
      expect(JSON.parse(init!.body as string)).toEqual({ days: "1h", volume: 65000 });
      return {
        ok: true,
        json: async () => ({ duration: "1h", volume: 65000, price: 100, summa: 6.5 }),
      };
    });
    vi.stubGlobal("fetch", fetchSpy);

    const quote = await provider.getQuote({
      targetAddress: "TVVX6svz6vXGVACeH9jNMk5M3dH5SvcT71",
      requiredEnergy: 20000, // below the 65,000 minimum -- must be rounded up
      duration: "1h",
    });

    expect(quote.quotedEnergy).toBe(65000);
    expect(quote.priceTrx).toBe(6.5);
    expect(quote.currency).toBe("TRX");
  });

  it("getQuote clamps a request above the 2,000,000 maximum down to the documented ceiling", async () => {
    let sentVolume = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentVolume = JSON.parse(init!.body as string).volume;
        return { ok: true, json: async () => ({ duration: "1h", volume: sentVolume, price: 100, summa: 300 }) };
      }),
    );
    await provider.getQuote({ targetAddress: "T...", requiredEnergy: 5_000_000, duration: "1h" });
    expect(sentVolume).toBe(2_000_000);
  });

  it("rentEnergy posts to /api/v1/buyenergy with target and maps a Filled order to ACTIVE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.tronex.energy/api/v1/buyenergy");
        return {
          ok: true,
          json: async () => ({
            days: "1h",
            volume: 65000,
            price: 100,
            summa: 6.5,
            target: "TVVX6svz6vXGVACeH9jNMk5M3dH5SvcT71",
            order_id: 123456,
            status: "Filled",
            txid: "8a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z7a8b9c0d1e2f3",
          }),
        };
      }),
    );

    const result = await provider.rentEnergy({
      targetAddress: "TVVX6svz6vXGVACeH9jNMk5M3dH5SvcT71",
      energy: 65000,
      duration: "1h",
      idempotencyKey: "test-key-1",
    });

    expect(result.rentalId).toBe("123456");
    expect(result.status).toBe("ACTIVE");
    expect(result.delegatedEnergy).toBe(65000);
    expect(result.priceTrx).toBe(6.5);
    expect(result.txHash).toBe("8a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z7a8b9c0d1e2f3");
  });

  it("rentEnergy maps a Pending order to PENDING (not yet confirmed on-chain)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          days: "1h",
          volume: 65000,
          price: 100,
          summa: 6.5,
          target: "T...",
          order_id: 1,
          status: "Pending",
          txid: null,
        }),
      })),
    );
    const result = await provider.rentEnergy({
      targetAddress: "T...",
      energy: 65000,
      duration: "1h",
      idempotencyKey: "k",
    });
    expect(result.status).toBe("PENDING");
    expect(result.txHash).toBeNull();
  });

  it("getRentalStatus GETs /api/v1/status/{id} and returns null on a documented 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.tronex.energy/api/v1/status/123456");
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    const status = await provider.getRentalStatus("123456");
    expect(status).toBeNull();
  });

  it("throws (never silently succeeds) on a non-2xx, non-404 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    await expect(
      provider.rentEnergy({ targetAddress: "T...", energy: 65000, duration: "1h", idempotencyKey: "k" }),
    ).rejects.toThrow(/401/);
  });

  it("has no cancelRental method -- Tronex's documented API has no cancellation endpoint", () => {
    const asInterface: EnergyRentalProvider = provider;
    expect(asInterface.cancelRental).toBeUndefined();
  });
});
