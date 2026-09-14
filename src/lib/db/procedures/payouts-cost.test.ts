import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, newId, nowIso } from "../client";
import { startRedemption } from "./redemption";
import {
  createPayoutForRedemption,
  payoutConfirm,
  payoutManualReview,
  payoutMarkBroadcast,
} from "./payouts";

/**
 * These exercise the cost-accounting columns and the manual-review escalation
 * against the real (test) SQLite database -- ledger_accounts are seeded in
 * schema.ts, so postJournal() works exactly as it does in production.
 */

function insertSoldVoucher(denomination = 25): {
  voucherId: string;
  publicId: string;
  codeHash: string;
} {
  const id = newId();
  const publicId = `TESTV${id.slice(0, 10)}`;
  const codeHash = `hash_${id}`;
  const now = nowIso();
  db.query(
    `INSERT INTO vouchers (id, public_id, code_hash, asset, network, denomination, status, created_at, expires_at, updated_at)
     VALUES (?, ?, ?, 'USDT', 'TRON_TESTNET', ?, 'SOLD', ?, ?, ?)`,
  ).run(id, publicId, codeHash, denomination, now, new Date(Date.now() + 3_600_000).toISOString(), now);
  return { voucherId: id, publicId, codeHash };
}

function startFixtureRedemption(denomination = 25) {
  const { publicId, codeHash } = insertSoldVoucher(denomination);
  const start = startRedemption({
    publicId,
    codeHash,
    destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
  });
  if (!start.ok) throw new Error(`fixture setup failed: ${start.error}`);
  return start;
}

function journalCount(transactionId: string): number {
  const row = db
    .query(`SELECT COUNT(DISTINCT journal_id) AS n FROM ledger_entries WHERE transaction_id = ?`)
    .get(transactionId) as { n: number };
  return row.n;
}

function ledgerIsBalanced(transactionId: string): boolean {
  const rows = db
    .query(`SELECT direction, SUM(amount) AS total FROM ledger_entries WHERE transaction_id = ? GROUP BY direction`)
    .all(transactionId) as Array<{ direction: string; total: number }>;
  const debit = rows.find((r) => r.direction === "DEBIT")?.total ?? 0;
  const credit = rows.find((r) => r.direction === "CREDIT")?.total ?? 0;
  return Math.round(debit * 100) === Math.round(credit * 100);
}

describe("payout cost accounting — recipient classification + manual review", () => {
  it("records recipientKind/estimatedEnergy/estimatedBandwidth as 'fresh' on the created payout row", () => {
    const start = startFixtureRedemption();
    const payoutId = createPayoutForRedemption({
      redemptionId: start.redemption_id,
      voucherId: start.voucher_id,
      transactionId: start.transaction_id,
      userId: null,
      amount: start.amount,
      network: start.network,
      token: start.asset,
      destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      idempotencyKey: start.redemption_id,
      recipientKind: "fresh",
      estimatedEnergy: 29650,
      estimatedBandwidth: 345,
      resourceSource: "BURN",
    });
    const row = db
      .query(`SELECT recipient_kind, estimated_energy, estimated_bandwidth, resource_source FROM payouts WHERE id = ?`)
      .get(payoutId) as {
      recipient_kind: string;
      estimated_energy: number;
      estimated_bandwidth: number;
      resource_source: string;
    };
    expect(row.recipient_kind).toBe("fresh");
    expect(row.estimated_energy).toBe(29650);
    expect(row.estimated_bandwidth).toBe(345);
    expect(row.resource_source).toBe("BURN");
  });

  it("records recipientKind 'existing' with the lower energy estimate", () => {
    const start = startFixtureRedemption();
    const payoutId = createPayoutForRedemption({
      redemptionId: start.redemption_id,
      voucherId: start.voucher_id,
      transactionId: start.transaction_id,
      userId: null,
      amount: start.amount,
      network: start.network,
      token: start.asset,
      destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      idempotencyKey: start.redemption_id,
      recipientKind: "existing",
      estimatedEnergy: 14650,
      estimatedBandwidth: 345,
      resourceSource: "BURN",
    });
    const row = db.query(`SELECT recipient_kind, estimated_energy FROM payouts WHERE id = ?`).get(payoutId) as {
      recipient_kind: string;
      estimated_energy: number;
    };
    expect(row.recipient_kind).toBe("existing");
    expect(row.estimated_energy).toBe(14650);
  });

  it("a cost-guard rejection moves the payout straight to MANUAL_REVIEW with the guard's reason recorded", () => {
    const start = startFixtureRedemption();
    const payoutId = createPayoutForRedemption({
      redemptionId: start.redemption_id,
      voucherId: start.voucher_id,
      transactionId: start.transaction_id,
      userId: null,
      amount: start.amount,
      network: start.network,
      token: start.asset,
      destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      idempotencyKey: start.redemption_id,
      recipientKind: "fresh",
      estimatedEnergy: 29650,
      estimatedBandwidth: 345,
      resourceSource: "BURN",
    });
    const result = payoutManualReview({
      payoutId,
      reason: "Estimated network cost $1.20 exceeds MAX_NETWORK_COST_USD ($1)",
      actorLabel: "cost-guard",
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("MANUAL_REVIEW");
    const row = db.query(`SELECT status, failure_reason FROM payouts WHERE id = ?`).get(payoutId) as {
      status: string;
      failure_reason: string;
    };
    expect(row.status).toBe("MANUAL_REVIEW");
    expect(row.failure_reason).toMatch(/MAX_NETWORK_COST_USD/);
    // The voucher must stay REDEEMING (not released back to SOLD) so a
    // customer can't redeem it a second time while the payout is under review.
    const voucher = db.query(`SELECT status FROM vouchers WHERE id = ?`).get(start.voucher_id) as {
      status: string;
    };
    expect(voucher.status).toBe("REDEEMING");
  });
});

describe("payout confirmation — actual resource usage + ledger integrity", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("records actual energy/bandwidth/TRX cost from the TronGrid receipt on confirmation", async () => {
    const start = startFixtureRedemption(25);
    const payoutId = createPayoutForRedemption({
      redemptionId: start.redemption_id,
      voucherId: start.voucher_id,
      transactionId: start.transaction_id,
      userId: null,
      amount: start.amount,
      network: start.network,
      token: start.asset,
      destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      idempotencyKey: start.redemption_id,
      provider: "tron-testnet-signer",
      recipientKind: "existing",
      estimatedEnergy: 14650,
      estimatedBandwidth: 345,
      resourceSource: "BURN",
    });
    payoutMarkBroadcast(payoutId, `fake_tx_hash_confirm_${newId()}`);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "fake_tx_hash_confirm_1",
          receipt: {
            energy_usage_total: 14650,
            net_usage: 345,
            net_fee: 0,
            energy_fee: 3_075_000, // sun
          },
        }),
      })),
    );

    const result = await payoutConfirm(payoutId, 20);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("CONFIRMED");

    const row = db
      .query(
        `SELECT actual_energy, actual_bandwidth, trx_burned, trx_cost_usd, total_network_cost FROM payouts WHERE id = ?`,
      )
      .get(payoutId) as {
      actual_energy: number;
      actual_bandwidth: number;
      trx_burned: number;
      trx_cost_usd: number;
      total_network_cost: number;
    };
    expect(row.actual_energy).toBe(14650);
    expect(row.actual_bandwidth).toBe(345);
    expect(row.trx_burned).toBeCloseTo(3.075, 6);
    // Default TRX_USD_PRICE is 0.15 unless overridden in the environment.
    expect(row.trx_cost_usd).toBeCloseTo(3.075 * Number(process.env["TRX_USD_PRICE"] ?? 0.15), 6);
    expect(row.total_network_cost).toBeCloseTo(row.trx_cost_usd, 6);
  });

  it("a mock-provider payout confirms without ever calling out for a real receipt", async () => {
    const start = startFixtureRedemption(25);
    const payoutId = createPayoutForRedemption({
      redemptionId: start.redemption_id,
      voucherId: start.voucher_id,
      transactionId: start.transaction_id,
      userId: null,
      amount: start.amount,
      network: start.network,
      token: start.asset,
      destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      idempotencyKey: start.redemption_id,
      // default provider is 'mock-tron-testnet'
    });
    payoutMarkBroadcast(payoutId, `mock_tx_hash_${newId()}`);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await payoutConfirm(payoutId, 20);
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = db.query(`SELECT actual_energy, trx_burned FROM payouts WHERE id = ?`).get(payoutId) as {
      actual_energy: number | null;
      trx_burned: number | null;
    };
    expect(row.actual_energy).toBeNull();
    expect(row.trx_burned).toBeNull();
  });

  it("idempotent retry: confirming an already-CONFIRMED payout a second time replays without re-fetching or double-posting the ledger", async () => {
    const start = startFixtureRedemption(25);
    const payoutId = createPayoutForRedemption({
      redemptionId: start.redemption_id,
      voucherId: start.voucher_id,
      transactionId: start.transaction_id,
      userId: null,
      amount: start.amount,
      network: start.network,
      token: start.asset,
      destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      idempotencyKey: start.redemption_id,
      provider: "tron-testnet-signer",
      recipientKind: "existing",
    });
    payoutMarkBroadcast(payoutId, `fake_tx_hash_retry_${newId()}`);

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "fake_tx_hash_retry_1",
        receipt: { energy_usage_total: 14650, net_usage: 345, net_fee: 0, energy_fee: 1_500_000 },
      }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = await payoutConfirm(payoutId, 20);
    expect(first.ok).toBe(true);
    expect(first.replayed).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await payoutConfirm(payoutId, 20);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    // A replay must never re-hit the network for a receipt it already has.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The ledger must show exactly one balanced journal, not two.
    expect(journalCount(start.transaction_id)).toBe(2); // liability->payout/fee split, then payout->treasury settlement
    expect(ledgerIsBalanced(start.transaction_id)).toBe(true);
  });

  it("the ledger remains balanced after a normal confirmation", async () => {
    const start = startFixtureRedemption(50);
    const payoutId = createPayoutForRedemption({
      redemptionId: start.redemption_id,
      voucherId: start.voucher_id,
      transactionId: start.transaction_id,
      userId: null,
      amount: start.amount,
      network: start.network,
      token: start.asset,
      destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      idempotencyKey: start.redemption_id,
    });
    payoutMarkBroadcast(payoutId, `mock_tx_hash_balance_${newId()}`);
    vi.stubGlobal("fetch", vi.fn());

    const result = await payoutConfirm(payoutId, 20);
    expect(result.ok).toBe(true);
    expect(ledgerIsBalanced(start.transaction_id)).toBe(true);
  });
});
