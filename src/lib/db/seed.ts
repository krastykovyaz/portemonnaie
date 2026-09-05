import { db, newId } from "./client";
import { hashVoucherCode } from "../voucher-codes";
import { postJournal } from "./procedures/ledger";
import { createPayoutForRedemption } from "./procedures/payouts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

/** Wipes and regenerates the demo dataset: 3 agents, 4 batches, 100 vouchers across every lifecycle state. */
export async function seedDemoData(): Promise<{
  ok: true;
  vouchers: number;
  agents: number;
  batches: number;
}> {
  db.exec(`DELETE FROM ledger_entries`);
  db.exec(`DELETE FROM payouts`);
  db.exec(`DELETE FROM transactions`);
  db.exec(`DELETE FROM voucher_redemptions`);
  db.exec(`DELETE FROM voucher_deliveries`);
  db.exec(`DELETE FROM payment_transactions`);
  db.exec(`DELETE FROM payment_requests`);
  db.exec(`DELETE FROM orders`);
  db.exec(`DELETE FROM manual_reviews`);
  db.exec(`DELETE FROM vouchers`);
  db.exec(`DELETE FROM voucher_batches`);
  db.exec(`DELETE FROM audit_logs`);

  const now = new Date().toISOString();
  const agentSeed = [
    { name: "Alina Kessler", ref: "AGT-A", email: "agent.a@demo.test", rate: 0.05 },
    { name: "Bruno Marchetti", ref: "AGT-B", email: "agent.b@demo.test", rate: 0.04 },
    { name: "Chidi Okonkwo", ref: "AGT-C", email: "agent.c@demo.test", rate: 0.06 },
  ];
  const agentIds: string[] = [];
  for (const a of agentSeed) {
    const existing = db.query(`SELECT id FROM agents WHERE agent_ref = ?`).get(a.ref) as {
      id: string;
    } | null;
    if (existing) {
      db.query(`UPDATE agents SET name = ?, email = ? WHERE id = ?`).run(
        a.name,
        a.email,
        existing.id,
      );
      agentIds.push(existing.id);
    } else {
      const id = newId();
      db.query(
        `INSERT INTO agents (id, name, agent_ref, email, commission_rate, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      ).run(id, a.name, a.ref, a.email, a.rate, now, now);
      agentIds.push(id);
    }
  }

  const batchSeed = [
    { ref: "BATCH-2601-050", denom: 50, expires: iso(300 * DAY), created: iso(-40 * DAY) },
    { ref: "BATCH-2602-025", denom: 25, expires: iso(300 * DAY), created: iso(-30 * DAY) },
    { ref: "BATCH-2603-100", denom: 100, expires: iso(300 * DAY), created: iso(-20 * DAY) },
    { ref: "BATCH-2604-010", denom: 10, expires: iso(300 * DAY), created: iso(-10 * DAY) },
  ];
  const batchIds: string[] = [];
  for (const b of batchSeed) {
    const id = newId();
    db.query(
      `INSERT INTO voucher_batches (id, batch_ref, denomination, quantity, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 25, ?, ?, ?)`,
    ).run(id, b.ref, b.denom, b.expires, b.created, b.created);
    batchIds.push(id);
  }

  const insertAudit = db.query(
    `INSERT INTO audit_logs (id, actor_label, action, entity, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (let n = 1; n <= 100; n += 1) {
    const publicId = `VDEMO${String(n).padStart(4, "0")}`;
    const code = `VCH-DEMO-${String(n).padStart(4, "0")}-TEST`;
    const codeHash = await hashVoucherCode(code);

    let denom: number;
    let batchId: string;
    if (n <= 25) {
      denom = 50;
      batchId = batchIds[0]!;
    } else if (n <= 50) {
      denom = 25;
      batchId = batchIds[1]!;
    } else if (n <= 75) {
      denom = 100;
      batchId = batchIds[2]!;
    } else {
      denom = 10;
      batchId = batchIds[3]!;
    }

    let status: string;
    let agentId: string | null;
    if (n <= 30) {
      status = "CREATED";
      agentId = null;
    } else if (n <= 60) {
      status = "ASSIGNED";
      agentId = agentIds[n % 3]!;
    } else if (n <= 85) {
      status = "SOLD";
      agentId = agentIds[n % 3]!;
    } else {
      status = "REDEEMED";
      agentId = agentIds[n % 3]!;
    }

    const createdAt = iso(-(100 - n) * HOUR - 5 * DAY);
    const soldAt =
      status === "SOLD" || status === "REDEEMED"
        ? new Date(new Date(createdAt).getTime() + 6 * HOUR).toISOString()
        : null;
    const redeemedAt =
      status === "REDEEMED"
        ? new Date(new Date(createdAt).getTime() + 30 * HOUR).toISOString()
        : null;
    const expiresAt = iso(300 * DAY);
    const voucherId = newId();

    db.query(
      `INSERT INTO vouchers (id, public_id, code_hash, denomination, status, batch_id, assigned_agent_id,
        created_at, sold_at, redeemed_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      voucherId,
      publicId,
      codeHash,
      denom,
      status,
      batchId,
      agentId,
      createdAt,
      soldAt,
      redeemedAt,
      expiresAt,
      createdAt,
    );

    insertAudit.run(
      newId(),
      "demo_admin",
      "VOUCHER_GENERATED",
      "voucher",
      publicId,
      JSON.stringify({ denomination: denom, batch_id: batchId }),
      createdAt,
    );

    if (status === "SOLD" || status === "REDEEMED") {
      postJournal(
        [
          { account: "TREASURY_USDT", direction: "DEBIT", amount: denom },
          { account: "VOUCHER_LIABILITY", direction: "CREDIT", amount: denom },
        ],
        voucherId,
        null,
        `Voucher sold ${publicId}`,
      );
      insertAudit.run(
        newId(),
        "demo_agent",
        "VOUCHER_SOLD",
        "voucher",
        publicId,
        JSON.stringify({ denomination: denom }),
        soldAt,
      );
    }

    if (status === "REDEEMED") {
      const destination = `T${publicId}DEMODEMODEMODEMODEMODEM`.slice(0, 34);
      const redemptionId = newId();
      const requestedAt = new Date(new Date(createdAt).getTime() + 29 * HOUR).toISOString();
      db.query(
        `INSERT INTO voucher_redemptions (id, voucher_id, destination_address, status, created_at, completed_at, updated_at)
         VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?)`,
      ).run(redemptionId, voucherId, destination, requestedAt, redeemedAt, redeemedAt);

      const txId = newId();
      const txHash = `0x${await hashVoucherCode(`${publicId}tx`)}`;
      db.query(
        `INSERT INTO transactions (id, voucher_id, redemption_id, amount, destination_address, tx_hash, status, confirmations, created_at, confirmed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', 20, ?, ?, ?)`,
      ).run(
        txId,
        voucherId,
        redemptionId,
        denom,
        destination,
        txHash,
        requestedAt,
        redeemedAt,
        redeemedAt,
      );

      const fee = Math.round(denom * 0.01 * 100) / 100;
      const net = Math.round((denom - fee) * 100) / 100;
      postJournal(
        [
          { account: "VOUCHER_LIABILITY", direction: "DEBIT", amount: denom },
          { account: "CUSTOMER_PAYOUT", direction: "CREDIT", amount: net },
          { account: "FEES", direction: "CREDIT", amount: fee },
        ],
        voucherId,
        txId,
        `Voucher redemption ${publicId}`,
      );
      postJournal(
        [
          { account: "CUSTOMER_PAYOUT", direction: "DEBIT", amount: net },
          { account: "TREASURY_USDT", direction: "CREDIT", amount: net },
        ],
        voucherId,
        txId,
        `Simulated payout settlement ${publicId}`,
      );

      createPayoutForRedemption({
        redemptionId,
        voucherId,
        transactionId: txId,
        userId: null,
        amount: denom,
        network: "TRON_TESTNET",
        token: "USDT",
        destination,
        idempotencyKey: `backfill:${redemptionId}`,
        status: "CONFIRMED",
        confirmations: 20,
        txHash,
        createdAt: requestedAt,
        broadcastAt: requestedAt,
        confirmedAt: redeemedAt,
      });

      insertAudit.run(
        newId(),
        "demo_customer",
        "REDEMPTION_APPROVED",
        "voucher",
        publicId,
        JSON.stringify({ amount: denom, fee }),
        redeemedAt,
      );
    }
  }

  return { ok: true, vouchers: 100, agents: agentSeed.length, batches: batchSeed.length };
}
