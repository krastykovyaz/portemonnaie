import { randomBytes } from "node:crypto";
import { TronWeb } from "tronweb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRuntime } from "./registry.server";
import { KNOWN_NILE_USDT_CONTRACT } from "./tron-testnet-signer.server";

const PAYOUT_ENV_KEYS = [
  "CHAIN_MODE",
  "PAYOUT_SIGNER",
  "TRON_NETWORK",
  "CUSTODY_KEY_REF",
  "USDT_CONTRACT_ADDRESS",
  "TREASURY_ADDRESS",
  "TRON_API_URL",
  "MAINNET_ACKNOWLEDGED",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of PAYOUT_ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of PAYOUT_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setEnv(overrides: Partial<Record<(typeof PAYOUT_ENV_KEYS)[number], string>>) {
  for (const key of PAYOUT_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

const VALID_KEY = randomBytes(32).toString("hex"); // throwaway, never funded
// TREASURY_ADDRESS must match whatever address VALID_KEY actually derives to
// (the registry cross-checks this and fails closed on a mismatch), so derive
// it the same way the signer itself does rather than hardcoding an address.
const VALID_KEY_ADDRESS = new TronWeb({ fullHost: "https://nile.trongrid.io" }).address.fromPrivateKey(
  VALID_KEY,
) as string;

const VALID_TESTNET_PAYOUT_ENV = {
  CHAIN_MODE: "TESTNET",
  PAYOUT_SIGNER: "TRON_TESTNET",
  TRON_NETWORK: "NILE",
  CUSTODY_KEY_REF: VALID_KEY,
  USDT_CONTRACT_ADDRESS: KNOWN_NILE_USDT_CONTRACT,
  TREASURY_ADDRESS: VALID_KEY_ADDRESS,
} as const;

describe("resolveRuntime — payout provider activation", () => {
  it("DEMO mode always uses the simulated payout provider", () => {
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, CHAIN_MODE: "DEMO" });
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.simulated).toBe(true);
    expect(runtime.payoutBlockers).toEqual([]);
  });

  it("MAINNET mode never activates the real testnet signer, regardless of config", () => {
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, CHAIN_MODE: "MAINNET" });
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.simulated).toBe(true);
    expect(runtime.payoutBlockers).toEqual([]);
  });

  it("TESTNET without PAYOUT_SIGNER opt-in keeps payouts simulated (preserves prior behavior)", () => {
    setEnv({
      CHAIN_MODE: "TESTNET",
      TRON_NETWORK: "NILE",
      CUSTODY_KEY_REF: VALID_KEY,
      USDT_CONTRACT_ADDRESS: KNOWN_NILE_USDT_CONTRACT,
      TREASURY_ADDRESS: "TXLGad17PxfSqzqrMY2jm6Bc6n1eWNRHdp",
      // PAYOUT_SIGNER intentionally omitted
    });
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.simulated).toBe(true);
    expect(runtime.payoutBlockers).toEqual([]);
  });

  it("TESTNET + PAYOUT_SIGNER=TRON_TESTNET + fully valid config activates the real signer", () => {
    setEnv(VALID_TESTNET_PAYOUT_ENV);
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.simulated).toBe(false);
    expect(runtime.payoutProvider.id).toBe("tron-testnet-signer");
    expect(runtime.payoutBlockers).toEqual([]);
  });

  it("fails closed (never falls back to mock) when TRON_NETWORK is not NILE", () => {
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, TRON_NETWORK: "MAINNET" });
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.simulated).toBe(false); // not the mock
    expect(runtime.payoutProvider.id).not.toBe("mock-tron-testnet");
    expect(runtime.payoutBlockers.length).toBeGreaterThan(0);
    expect(runtime.payoutBlockers.join(" ")).toMatch(/TRON_NETWORK/);
  });

  it("fails closed when CUSTODY_KEY_REF is missing", () => {
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, CUSTODY_KEY_REF: "" });
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.id).not.toBe("mock-tron-testnet");
    expect(runtime.payoutBlockers.join(" ")).toMatch(/CUSTODY_KEY_REF/);
  });

  it("fails closed when USDT_CONTRACT_ADDRESS is not the known Nile contract", () => {
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, USDT_CONTRACT_ADDRESS: "TSomeUnknownContract11111111" });
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.id).not.toBe("mock-tron-testnet");
    expect(runtime.payoutBlockers.join(" ")).toMatch(/USDT_CONTRACT_ADDRESS/);
  });

  it("fails closed when TRON_API_URL does not point at a Nile host", () => {
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, TRON_API_URL: "https://api.trongrid.io" });
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.id).not.toBe("mock-tron-testnet");
    expect(runtime.payoutBlockers.join(" ")).toMatch(/TRON_API_URL/);
  });

  it("a blocked real-signer request never simulates a payout — every call fails loudly", async () => {
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, CUSTODY_KEY_REF: "" });
    const runtime = resolveRuntime();
    await expect(
      runtime.payoutProvider.createPayout({
        idempotencyKey: "x",
        amount: 1,
        asset: "USDT",
        network: "TRON_TESTNET",
        destinationAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
        reference: "x",
      }),
    ).rejects.toThrow(/PAYOUT_SIGNER_UNAVAILABLE/);
  });

  it("fails closed when CUSTODY_KEY_REF derives an address that does not match TREASURY_ADDRESS", () => {
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, TREASURY_ADDRESS: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF" });
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.id).not.toBe("mock-tron-testnet");
    expect(runtime.payoutProvider.simulated).toBe(false);
    expect(runtime.payoutBlockers.join(" ")).toMatch(/does not match TREASURY_ADDRESS/);
  });

  it("fails closed when CUSTODY_KEY_REF is not a valid key format", () => {
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, CUSTODY_KEY_REF: "not-a-real-key" });
    const runtime = resolveRuntime();
    expect(runtime.payoutProvider.id).not.toBe("mock-tron-testnet");
    expect(runtime.payoutBlockers.length).toBeGreaterThan(0);
  });

  it("refuses a real payout signer while payment detection is misconfigured (gateway would be the mock)", () => {
    // A fully valid signer config, but no TREASURY_ADDRESS for payment
    // detection: the gateway degrades to the mock. Real transfers must not
    // run beside simulated incoming payments — that would be a free-USDT path.
    setEnv({ ...VALID_TESTNET_PAYOUT_ENV, TREASURY_ADDRESS: "" });
    const runtime = resolveRuntime();
    expect(runtime.gateway.id).toBe("mock-payment-gateway");
    expect(runtime.payoutProvider.id).toBe("payout-signer-unavailable");
    expect(runtime.payoutProvider.simulated).toBe(false);
    expect(runtime.payoutBlockers.join(" ")).toMatch(/payment detection is not configured/);
  });
});
