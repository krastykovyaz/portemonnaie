import { describe, expect, it } from "vitest";
import { MockBlockchainProvider, scenarioForAddress } from "./mock-blockchain";

const VALID = "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF";
const OK_ADDRESS = VALID.slice(0, -1) + "a";
const FAIL_ADDRESS = VALID.slice(0, -1) + "f";
const TIMEOUT_ADDRESS = VALID.slice(0, -1) + "t";
const LOST_ADDRESS = VALID.slice(0, -1) + "x";

function request(destination: string, key: string) {
  return {
    idempotencyKey: key,
    destinationAddress: destination,
    amount: 50,
    asset: "USDT",
    network: "TRON_TESTNET",
    reference: "test",
  };
}

describe("mock blockchain provider", () => {
  it("derives scenarios from the destination suffix", () => {
    expect(scenarioForAddress(FAIL_ADDRESS)).toBe("FAIL");
    expect(scenarioForAddress(TIMEOUT_ADDRESS)).toBe("TIMEOUT");
    expect(scenarioForAddress(OK_ADDRESS)).toBe("SUCCESS");
  });

  it("rejects invalid addresses and amounts", async () => {
    const provider = new MockBlockchainProvider();
    await expect(provider.createPayout(request("nope", "k1"))).rejects.toThrow("INVALID_ADDRESS");
    await expect(
      provider.createPayout({ ...request(OK_ADDRESS, "k2"), amount: 0 }),
    ).rejects.toThrow("INVALID_AMOUNT");
  });

  it("is idempotent — a double click never broadcasts twice", async () => {
    const provider = new MockBlockchainProvider();
    const first = await provider.createPayout(request(OK_ADDRESS, "same-key"));
    const second = await provider.createPayout(request(OK_ADDRESS, "same-key"));
    expect(second.txHash).toBe(first.txHash);
    expect(second.deduplicated).toBe(true);
  });

  it("simulates a broadcast failure", async () => {
    const provider = new MockBlockchainProvider();
    await expect(provider.createPayout(request(FAIL_ADDRESS, "k3"))).rejects.toThrow(
      /PROVIDER_REJECTED/,
    );
  });

  it("confirms a successful payout after polling", async () => {
    const provider = new MockBlockchainProvider();
    const tx = await provider.createPayout(request(OK_ADDRESS, "k4"));
    expect(await provider.getConfirmations(tx.txHash)).toBeGreaterThanOrEqual(3);
    const status = await provider.getTransactionStatus(tx.txHash);
    expect(status?.status).toBe("CONFIRMED");
  });

  it("leaves timeout scenarios confirming until the worker keeps polling", async () => {
    const provider = new MockBlockchainProvider();
    const tx = await provider.createPayout(request(TIMEOUT_ADDRESS, "k5"));
    expect(await provider.getConfirmations(tx.txHash)).toBe(1);
    expect((await provider.getTransactionStatus(tx.txHash))?.status).toBe("CONFIRMING");
    await provider.getConfirmations(tx.txHash);
    await provider.getConfirmations(tx.txHash);
    expect((await provider.getTransactionStatus(tx.txHash))?.status).toBe("CONFIRMED");
  });

  it("loses transactions so reconciliation has a case to detect", async () => {
    const provider = new MockBlockchainProvider();
    const tx = await provider.createPayout(request(LOST_ADDRESS, "k6"));
    expect(await provider.getTransactionStatus(tx.txHash)).toBeNull();
  });

  it("forgets in-flight state on reset, mimicking a server crash", async () => {
    const provider = new MockBlockchainProvider();
    const tx = await provider.createPayout(request(OK_ADDRESS, "k7"));
    provider.reset();
    expect(await provider.getTransactionStatus(tx.txHash)).toBeNull();
    const reissued = await provider.createPayout(request(OK_ADDRESS, "k7"));
    expect(reissued.txHash).not.toBe(tx.txHash);
  });
});
