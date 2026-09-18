import { describe, expect, it } from "vitest";
import { drivePayout, type PayoutRecord, type PayoutStore } from "./orchestrator";
import type { BlockchainProvider, ChainTransaction, PayoutRequest } from "../providers/blockchain";

/**
 * A fully in-memory, network-free BlockchainProvider double. No real key, no
 * real chain — just enough to exercise the orchestrator's state machine and
 * double-payout protection under controlled failure modes.
 */
class FakeProvider implements BlockchainProvider {
  readonly id = "fake-provider";
  readonly network = "TRON_TESTNET";
  readonly simulated = true;

  createPayoutCalls = 0;
  private byHash = new Map<string, ChainTransaction>();
  private byKey = new Map<string, string>();

  constructor(
    private opts: {
      broadcastShouldFail?: boolean;
      confirmationsPerPoll?: number;
      revertOnConfirm?: boolean;
      reportUnknownForHash?: string;
    } = {},
  ) {}

  validateAddress(address: string): boolean {
    return address.startsWith("T");
  }

  async getBalance(): Promise<number> {
    return 1_000_000;
  }

  async createPayout(request: PayoutRequest): Promise<ChainTransaction> {
    this.createPayoutCalls += 1;

    const existingHash = this.byKey.get(request.idempotencyKey);
    if (existingHash) {
      const existing = this.byHash.get(existingHash);
      if (existing) return { ...existing, deduplicated: true };
    }

    if (this.opts.broadcastShouldFail) {
      throw new Error("BROADCAST_FAILED: simulated");
    }

    const tx: ChainTransaction = {
      txHash: `hash_${this.createPayoutCalls}_${request.idempotencyKey}`,
      status: "BROADCAST",
      confirmations: 0,
      amount: request.amount,
      asset: request.asset,
      network: this.network,
      destinationAddress: request.destinationAddress,
      createdAt: new Date().toISOString(),
    };
    this.byHash.set(tx.txHash, tx);
    this.byKey.set(request.idempotencyKey, tx.txHash);
    return { ...tx };
  }

  async getTransactionStatus(txHash: string): Promise<ChainTransaction | null> {
    if (this.opts.reportUnknownForHash === txHash) return null;
    const tx = this.byHash.get(txHash);
    if (!tx) return null;
    if (this.opts.revertOnConfirm && tx.confirmations > 0) {
      return { ...tx, status: "FAILED", failureReason: "CONTRACT_REVERT" };
    }
    return { ...tx };
  }

  async getConfirmations(txHash: string): Promise<number> {
    const tx = this.byHash.get(txHash);
    if (!tx) return 0;
    tx.confirmations += this.opts.confirmationsPerPoll ?? 3;
    this.byHash.set(txHash, tx);
    return tx.confirmations;
  }
}

/** In-memory PayoutStore double, mirroring the real SQLite-backed one's contract. */
function fakeStore(initial: PayoutRecord): { store: PayoutStore; get: () => PayoutRecord } {
  let record = { ...initial };
  const store: PayoutStore = {
    async load() {
      return { ...record };
    },
    async markBroadcast(_id, txHash, confirmations) {
      record = { ...record, status: "BROADCAST", txHash, confirmations, attemptCount: record.attemptCount + 1 };
    },
    async markConfirming(_id, confirmations) {
      record = { ...record, status: "CONFIRMING", confirmations };
    },
    async confirm(_id, confirmations) {
      record = { ...record, status: "CONFIRMED", confirmations };
      return { ok: true };
    },
    async fail(_id, reason, forceManual) {
      const status = forceManual || record.attemptCount >= record.maxAttempts ? "MANUAL_REVIEW" : "FAILED";
      record = { ...record, status, failureReason: reason };
      return { ok: true, status };
    },
  };
  return { store, get: () => record };
}

function baseRecord(overrides: Partial<PayoutRecord> = {}): PayoutRecord {
  return {
    id: "payout_1",
    redemptionId: "redemption_1",
    voucherId: "voucher_1",
    idempotencyKey: "idem_1",
    amount: 25,
    token: "USDT",
    network: "TRON_TESTNET",
    destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
    status: "PENDING",
    txHash: null,
    confirmations: 0,
    attemptCount: 0,
    maxAttempts: 3,
    failureReason: null,
    ...overrides,
  };
}

describe("payout orchestrator — real-signer-shaped failure modes", () => {
  it("1. drives a valid payout to CONFIRMED", async () => {
    const provider = new FakeProvider({ confirmationsPerPoll: 3 });
    const { store } = fakeStore(baseRecord());
    const outcome = await drivePayout(baseRecord(), { provider, store, sleep: async () => {} });
    expect(outcome.status).toBe("CONFIRMED");
    expect(outcome.txHash).toBeTruthy();
    expect(provider.createPayoutCalls).toBe(1);
  });

  it("8. a broadcast failure escalates through FAILED toward MANUAL_REVIEW, never silently succeeding", async () => {
    const provider = new FakeProvider({ broadcastShouldFail: true });
    const { store, get } = fakeStore(baseRecord({ attemptCount: 2, maxAttempts: 3 }));
    const outcome = await drivePayout(baseRecord({ attemptCount: 2, maxAttempts: 3 }), {
      provider,
      store,
      sleep: async () => {},
    });
    expect(outcome.status).toBe("MANUAL_REVIEW");
    expect(get().status).toBe("MANUAL_REVIEW");
    expect(outcome.txHash).toBeNull();
  });

  it("9. a reverted on-chain transaction is reported FAILED, not CONFIRMED", async () => {
    const provider = new FakeProvider({ revertOnConfirm: true });
    // Broadcast once directly against the provider to get a real (fake) tx,
    // then poll confirmations once so the provider's revert condition
    // (confirmations > 0) is armed for the next status check.
    const broadcast = await provider.createPayout({
      idempotencyKey: "idem_1",
      amount: 25,
      asset: "USDT",
      network: "TRON_TESTNET",
      destinationAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      reference: "r",
    });
    await provider.getConfirmations(broadcast.txHash);

    // Now drive a payout record that already has this (now-reverted) tx hash
    // recorded, as the real flow would after a prior BROADCAST.
    const record = baseRecord({ status: "BROADCAST", txHash: broadcast.txHash, attemptCount: 1 });
    const { store, get } = fakeStore(record);
    const outcome = await drivePayout(record, { provider, store, sleep: async () => {} });

    // A reverted broadcast goes straight to MANUAL_REVIEW: it can't be retried
    // under the same idempotency key (the provider would return the reverted
    // hash again), and leaving it FAILED made the recovery sweep re-claim it
    // forever without ever escalating.
    expect(outcome.status).toBe("MANUAL_REVIEW");
    expect(outcome.failureReason).toBe("PROVIDER_REPORTED_FAILED");
    expect(outcome.txHash).toBe(broadcast.txHash);
    expect(get().status).toBe("MANUAL_REVIEW");
    // Critically: a revert must never re-broadcast a second transfer.
    expect(provider.createPayoutCalls).toBe(1);

    // And the next sweep pass must not touch it again.
    const reloaded = await store.load(get().id);
    const again = await drivePayout(reloaded!, { provider, store, sleep: async () => {} });
    expect(again.status).toBe("MANUAL_REVIEW");
    expect(provider.createPayoutCalls).toBe(1);
  });

  it("10. confirmation timeout leaves the payout CONFIRMING rather than falsely CONFIRMED or FAILED", async () => {
    const provider = new FakeProvider({ confirmationsPerPoll: 1 }); // needs 3 polls, only 2 allowed
    const { store } = fakeStore(baseRecord());
    const outcome = await drivePayout(baseRecord(), {
      provider,
      store,
      sleep: async () => {},
      maxPolls: 2,
    });
    expect(outcome.status).toBe("CONFIRMING");
    expect(outcome.confirmations).toBeLessThan(3);
  });

  it("11 & 13. duplicate redemption / process crash after broadcast never causes a second on-chain send", async () => {
    const provider = new FakeProvider({ confirmationsPerPoll: 3 });
    const { store, get } = fakeStore(baseRecord());
    // First drive: broadcasts and confirms.
    await drivePayout(baseRecord(), { provider, store, sleep: async () => {} });
    expect(provider.createPayoutCalls).toBe(1);
    expect(get().status).toBe("CONFIRMED");

    // Simulate a "process crash + retry": the caller reloads the payout from
    // the store (exactly as processPayout()/redeemVoucher() do) and drives
    // it again — mirroring a real retry after a restart.
    const reloaded = await store.load(get().id);
    const replay = await drivePayout(reloaded!, { provider, store, sleep: async () => {} });
    // The store already shows CONFIRMED, so drivePayout must short-circuit —
    // it must NEVER call provider.createPayout a second time for this key.
    expect(replay.status).toBe("CONFIRMED");
    expect(replay.replayed).toBe(true);
    expect(provider.createPayoutCalls).toBe(1);
  });

  it("12. retry after the provider reports a broadcast as unknown re-broadcasts exactly once via the same idempotency key", async () => {
    const provider = new FakeProvider({ confirmationsPerPoll: 3 });
    const { store } = fakeStore(baseRecord());
    const first = await provider.createPayout({
      idempotencyKey: "idem_1",
      amount: 25,
      asset: "USDT",
      network: "TRON_TESTNET",
      destinationAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      reference: "r",
    });
    const unknownProvider = new FakeProvider({
      confirmationsPerPoll: 3,
      reportUnknownForHash: first.txHash,
    });
    const record = baseRecord({ status: "BROADCAST", txHash: first.txHash, attemptCount: 1 });
    const outcome = await drivePayout(record, { provider: unknownProvider, store, sleep: async () => {} });
    // Provider genuinely has no record of it -> orchestrator is allowed to
    // re-broadcast under the SAME idempotency key (the provider's own
    // idempotency map is what prevents that becoming two real transfers).
    expect(unknownProvider.createPayoutCalls).toBe(1);
    expect(outcome.status).toBe("CONFIRMED");
  });

  it("14. DEMO-shaped mock provider still behaves as simulated (unaffected by this feature)", async () => {
    const provider = new FakeProvider({ confirmationsPerPoll: 3 });
    expect(provider.simulated).toBe(true);
    const { store } = fakeStore(baseRecord());
    const outcome = await drivePayout(baseRecord(), { provider, store, sleep: async () => {} });
    expect(outcome.status).toBe("CONFIRMED");
  });

  it("a MANUAL_REVIEW payout is never re-driven automatically", async () => {
    const provider = new FakeProvider();
    const { store } = fakeStore(baseRecord({ status: "MANUAL_REVIEW", failureReason: "x" }));
    const outcome = await drivePayout(baseRecord({ status: "MANUAL_REVIEW", failureReason: "x" }), {
      provider,
      store,
      sleep: async () => {},
    });
    expect(outcome.status).toBe("MANUAL_REVIEW");
    expect(provider.createPayoutCalls).toBe(0);
  });
});
