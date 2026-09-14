import { afterEach, describe, expect, it, vi } from "vitest";
import { db, newId, nowIso } from "../client";
import { startRedemption } from "./redemption";
import { createPayoutForRedemption, payoutConfirm, payoutMarkBroadcast } from "./payouts";
import { createPendingRental, markRentalActive } from "./energy-rentals";

function insertSoldVoucher(denomination = 25): { publicId: string; codeHash: string; voucherId: string } {
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

function ledgerIsBalanced(transactionId: string): boolean {
  const rows = db
    .query(`SELECT direction, SUM(amount) AS total FROM ledger_entries WHERE transaction_id = ? GROUP BY direction`)
    .all(transactionId) as Array<{ direction: string; total: number }>;
  const debit = rows.find((r) => r.direction === "DEBIT")?.total ?? 0;
  const credit = rows.find((r) => r.direction === "CREDIT")?.total ?? 0;
  return Math.round(debit * 100) === Math.round(credit * 100);
}

describe("RENTED payout confirmation — cost folding + ledger integrity", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("folds the rental's price_usd into provider_cost/total_network_cost on top of the actual on-chain burn, and the ledger stays balanced", async () => {
    const { publicId, codeHash } = insertSoldVoucher(25);
    const start = startRedemption({ publicId, codeHash, destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF" });
    if (!start.ok) throw new Error("fixture setup failed");

    const { rental } = createPendingRental({
      provider: "mock-energy-rental",
      treasuryAddress: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF",
      requestedEnergy: 14650,
      duration: "1h",
      idempotencyKey: `rental:${start.redemption_id}`,
    });
    markRentalActive(rental.id, {
      providerOrderId: "999",
      delegatedEnergy: 65000,
      priceTrx: 9.75,
      priceUsd: 1.4625,
      startedAt: nowIso(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      txHash: "mock_tx_rental",
    });

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
      resourceSource: "RENTED",
      energyRentalId: rental.id,
    });
    payoutMarkBroadcast(payoutId, `fake_tx_rented_${newId()}`);

    // Delegated energy fully covers the transfer -- the on-chain receipt
    // shows zero energy_fee, i.e. no additional TRX was burned on top of the
    // rental itself. net_fee still burns a little for bandwidth.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "irrelevant",
          receipt: { energy_usage_total: 14650, net_usage: 345, net_fee: 345_000, energy_fee: 0 },
        }),
      })),
    );

    const result = await payoutConfirm(payoutId, 20);
    expect(result.ok).toBe(true);

    const row = db
      .query(`SELECT provider_cost, total_network_cost, trx_cost_usd FROM payouts WHERE id = ?`)
      .get(payoutId) as { provider_cost: number; total_network_cost: number; trx_cost_usd: number };

    const expectedBurnUsd = (345_000 / 1_000_000) * 0.15; // net_fee sun -> TRX -> USD at the default TRX_USD_PRICE
    expect(row.trx_cost_usd).toBeCloseTo(expectedBurnUsd, 6);
    expect(row.provider_cost).toBeCloseTo(1.4625, 6); // the rental cost, not the (much smaller) burn cost
    expect(row.total_network_cost).toBeCloseTo(expectedBurnUsd + 1.4625, 6);

    expect(ledgerIsBalanced(start.transaction_id)).toBe(true);
  });

  it("a BURN/STAKED payout with no energy_rental_id is completely unaffected (provider_cost still equals trx_cost_usd)", async () => {
    const { publicId, codeHash } = insertSoldVoucher(25);
    const start = startRedemption({ publicId, codeHash, destination: "TQ5NMqJjMkPmVFHnFrnhVLQTf8rgLu6cwF" });
    if (!start.ok) throw new Error("fixture setup failed");

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
      resourceSource: "BURN",
    });
    payoutMarkBroadcast(payoutId, `fake_tx_burn_${newId()}`);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "irrelevant",
          receipt: { energy_usage_total: 14650, net_usage: 345, net_fee: 0, energy_fee: 3_075_000 },
        }),
      })),
    );

    const result = await payoutConfirm(payoutId, 20);
    expect(result.ok).toBe(true);

    const row = db
      .query(`SELECT provider_cost, total_network_cost, trx_cost_usd FROM payouts WHERE id = ?`)
      .get(payoutId) as { provider_cost: number; total_network_cost: number; trx_cost_usd: number };
    expect(row.provider_cost).toBeCloseTo(row.trx_cost_usd, 8);
    expect(row.total_network_cost).toBeCloseTo(row.trx_cost_usd, 8);
    expect(ledgerIsBalanced(start.transaction_id)).toBe(true);
  });
});
