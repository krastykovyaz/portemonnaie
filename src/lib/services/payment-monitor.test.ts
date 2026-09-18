import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOWN_NILE_USDT_CONTRACT } from "../providers/tron-testnet-signer.server";
import { resolveRuntime } from "../providers/registry.server";
import { simulateCustomerPayment } from "./payment-monitor.server";

const ENV_KEYS = [
  "CHAIN_MODE",
  "PAYOUT_SIGNER",
  "TRON_NETWORK",
  "CUSTODY_KEY_REF",
  "USDT_CONTRACT_ADDRESS",
  "TREASURY_ADDRESS",
  "TRON_API_URL",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

describe("simulateCustomerPayment — DEMO-only gate", () => {
  it("is reachable in DEMO (gets past the gate to the payment lookup)", async () => {
    setEnv({ CHAIN_MODE: "DEMO" });
    const result = await simulateCustomerPayment({ paymentId: "does-not-exist" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("NOT_FOUND"); // past the gate, no such payment
  });

  it("refuses in TESTNET even when payment detection has degraded to the mock gateway", async () => {
    // Misconfigured detection (no TREASURY_ADDRESS) -> mock gateway is active.
    // Previously that alone re-enabled simulation; it must not.
    setEnv({
      CHAIN_MODE: "TESTNET",
      USDT_CONTRACT_ADDRESS: KNOWN_NILE_USDT_CONTRACT,
      TREASURY_ADDRESS: "",
    });
    expect(resolveRuntime().gateway.id).toBe("mock-payment-gateway");

    const result = await simulateCustomerPayment({ paymentId: "does-not-exist" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("SIMULATION_DISABLED");
  });

  it("refuses in TESTNET with a fully configured real gateway", async () => {
    setEnv({
      CHAIN_MODE: "TESTNET",
      USDT_CONTRACT_ADDRESS: KNOWN_NILE_USDT_CONTRACT,
      TREASURY_ADDRESS: "TXLGad17PxfSqzqrMY2jm6Bc6n1eWNRHdp",
    });
    const result = await simulateCustomerPayment({ paymentId: "does-not-exist" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("SIMULATION_DISABLED");
  });
});
