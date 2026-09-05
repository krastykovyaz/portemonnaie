import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KNOWN_NILE_USDT_CONTRACT, TronTestnetPayoutSigner } from "./tron-testnet-signer.server";

// A freshly random, never-funded, never-reused key — good enough to exercise
// address derivation and format validation without touching any real chain.
// This is deliberately NOT a real/funded testnet key.
function throwawayKey(): string {
  return randomBytes(32).toString("hex");
}

const NILE_URL = "https://nile.trongrid.io";

describe("TronTestnetPayoutSigner — construction & config validation", () => {
  it("constructs successfully with valid Nile config and derives a TRON address", () => {
    const signer = new TronTestnetPayoutSigner({
      privateKey: throwawayKey(),
      apiUrl: NILE_URL,
      contractAddress: KNOWN_NILE_USDT_CONTRACT,
    });
    expect(signer.custodyAddress).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(signer.simulated).toBe(false);
    expect(signer.network).toBe("TRON_TESTNET");
  });

  it("accepts a 0x-prefixed key the same as a bare hex key", () => {
    const key = throwawayKey();
    const a = new TronTestnetPayoutSigner({
      privateKey: key,
      apiUrl: NILE_URL,
      contractAddress: KNOWN_NILE_USDT_CONTRACT,
    });
    const b = new TronTestnetPayoutSigner({
      privateKey: `0x${key}`,
      apiUrl: NILE_URL,
      contractAddress: KNOWN_NILE_USDT_CONTRACT,
    });
    expect(b.custodyAddress).toBe(a.custodyAddress);
  });

  it("refuses a non-Nile RPC endpoint — never silently talks to mainnet", () => {
    expect(
      () =>
        new TronTestnetPayoutSigner({
          privateKey: throwawayKey(),
          apiUrl: "https://api.trongrid.io", // mainnet host, no "nile"
          contractAddress: KNOWN_NILE_USDT_CONTRACT,
        }),
    ).toThrow(/Nile testnet host/);
  });

  it("refuses any USDT contract other than this project's known Nile contract", () => {
    expect(
      () =>
        new TronTestnetPayoutSigner({
          privateKey: throwawayKey(),
          apiUrl: NILE_URL,
          contractAddress: "TSomeOtherContractAddressNotTrusted111",
        }),
    ).toThrow(/known Nile testnet contract/);
  });

  it("rejects a private key that is the wrong length", () => {
    expect(
      () =>
        new TronTestnetPayoutSigner({
          privateKey: "deadbeef",
          apiUrl: NILE_URL,
          contractAddress: KNOWN_NILE_USDT_CONTRACT,
        }),
    ).toThrow(/32-byte hex private key/);
  });

  it("rejects a private key with non-hex characters", () => {
    expect(
      () =>
        new TronTestnetPayoutSigner({
          privateKey: "z".repeat(64),
          apiUrl: NILE_URL,
          contractAddress: KNOWN_NILE_USDT_CONTRACT,
        }),
    ).toThrow(/32-byte hex private key/);
  });

  it("rejects an empty private key", () => {
    expect(
      () =>
        new TronTestnetPayoutSigner({
          privateKey: "",
          apiUrl: NILE_URL,
          contractAddress: KNOWN_NILE_USDT_CONTRACT,
        }),
    ).toThrow();
  });
});

describe("TronTestnetPayoutSigner — address validation", () => {
  const signer = new TronTestnetPayoutSigner({
    privateKey: throwawayKey(),
    apiUrl: NILE_URL,
    contractAddress: KNOWN_NILE_USDT_CONTRACT,
  });

  it("accepts a well-formed TRON address", () => {
    expect(signer.validateAddress("TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF")).toBe(true);
  });

  it("rejects a malformed address", () => {
    expect(signer.validateAddress("not-a-tron-address")).toBe(false);
    expect(signer.validateAddress("")).toBe(false);
    expect(signer.validateAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(false);
  });
});

describe("TronTestnetPayoutSigner — request-level guards (no network reached)", () => {
  const signer = new TronTestnetPayoutSigner({
    privateKey: throwawayKey(),
    apiUrl: NILE_URL,
    contractAddress: KNOWN_NILE_USDT_CONTRACT,
  });

  function request(overrides: Partial<Parameters<typeof signer.createPayout>[0]> = {}) {
    return {
      idempotencyKey: `test_${Math.random()}`,
      destinationAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      amount: 10,
      asset: "USDT",
      network: "TRON_TESTNET",
      reference: "test",
      ...overrides,
    };
  }

  it("rejects an invalid destination address before touching the network", async () => {
    await expect(
      signer.createPayout(request({ destinationAddress: "not-valid" })),
    ).rejects.toThrow("INVALID_ADDRESS");
  });

  it("rejects a zero amount before touching the network", async () => {
    await expect(signer.createPayout(request({ amount: 0 }))).rejects.toThrow("INVALID_AMOUNT");
  });

  it("rejects a negative amount before touching the network", async () => {
    await expect(signer.createPayout(request({ amount: -5 }))).rejects.toThrow("INVALID_AMOUNT");
  });
});
