import { db, newId, nowIso, tx } from "../client";
import { writeAuditSync } from "@/lib/services/audit.server";
import { postJournal } from "./ledger";

type VoucherRow = {
  id: string;
  public_id: string;
  code_hash: string;
  denomination: number;
  asset: string;
  network: string;
  status: string;
  expires_at: string;
};

export type PreviewResult =
  | {
      ok: true;
      public_id: string;
      asset: string;
      network: string;
      denomination: number;
      status: string;
      expires_at: string;
    }
  | { ok: false; error: string; status?: string };

export function voucherPreview(publicId: string, codeHash: string): PreviewResult {
  return tx((): PreviewResult => {
    const v = db
      .query(`SELECT * FROM vouchers WHERE public_id = ?`)
      .get(publicId) as VoucherRow | null;
    if (!v) return { ok: false, error: "NOT_FOUND" };
    if (v.code_hash !== codeHash) return { ok: false, error: "INVALID_CODE" };
    if (v.expires_at < nowIso() && v.status !== "REDEEMED" && v.status !== "CANCELLED") {
      db.query(
        `UPDATE vouchers SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status <> 'EXPIRED'`,
      ).run(nowIso(), v.id);
      return { ok: false, error: "EXPIRED" };
    }
    if (v.status !== "SOLD") return { ok: false, error: "INVALID_STATUS", status: v.status };
    return {
      ok: true,
      public_id: v.public_id,
      asset: v.asset,
      network: v.network,
      denomination: v.denomination,
      status: v.status,
      expires_at: v.expires_at,
    };
  });
}

export type StartRedemptionResult =
  | {
      ok: true;
      redemption_id: string;
      transaction_id: string;
      voucher_id: string;
      amount: number;
      asset: string;
      network: string;
    }
  | { ok: false; error: string; status?: string };

export function startRedemption(input: {
  publicId: string;
  codeHash: string;
  destination: string;
  userId?: string | null;
}): StartRedemptionResult {
  return tx((): StartRedemptionResult => {
    const v = db
      .query(`SELECT * FROM vouchers WHERE public_id = ?`)
      .get(input.publicId) as VoucherRow | null;
    if (!v) return { ok: false, error: "NOT_FOUND" };
    if (v.code_hash !== input.codeHash) return { ok: false, error: "INVALID_CODE" };
    if (v.expires_at < nowIso()) {
      db.query(
        `UPDATE vouchers SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status <> 'EXPIRED'`,
      ).run(nowIso(), v.id);
      return { ok: false, error: "EXPIRED" };
    }
    if (v.status !== "SOLD") return { ok: false, error: "INVALID_STATUS", status: v.status };

    const active = db
      .query(`SELECT 1 FROM voucher_redemptions WHERE voucher_id = ? AND status <> 'FAILED'`)
      .get(v.id);
    if (active) return { ok: false, error: "ALREADY_IN_PROGRESS" };

    const now = nowIso();
    const redemptionId = newId();
    db.query(
      `INSERT INTO voucher_redemptions (id, voucher_id, user_id, destination_address, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PROCESSING', ?, ?)`,
    ).run(redemptionId, v.id, input.userId ?? null, input.destination, now, now);

    const transactionId = newId();
    db.query(
      `INSERT INTO transactions (id, voucher_id, redemption_id, user_id, amount, asset, network, destination_address, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    ).run(
      transactionId,
      v.id,
      redemptionId,
      input.userId ?? null,
      v.denomination,
      v.asset,
      v.network,
      input.destination,
      now,
      now,
    );

    db.query(`UPDATE vouchers SET status = 'REDEEMING', updated_at = ? WHERE id = ?`).run(
      now,
      v.id,
    );

    writeAuditSync({
      actorId: input.userId ?? null,
      actorLabel: input.userId ?? "anonymous_customer",
      action: "REDEMPTION_REQUESTED",
      entity: "voucher",
      entityId: v.public_id,
      metadata: {
        redemption_id: redemptionId,
        transaction_id: transactionId,
        destination: input.destination,
      },
    });

    return {
      ok: true,
      redemption_id: redemptionId,
      transaction_id: transactionId,
      voucher_id: v.id,
      amount: v.denomination,
      asset: v.asset,
      network: v.network,
    };
  });
}

export type CompleteRedemptionResult =
  | {
      ok: true;
      tx_hash: string;
      amount: number;
      fee: number;
      asset: string;
      network: string;
      destination: string;
      confirmed_at: string;
      public_id: string;
    }
  | { ok: false; error: string };

export function completeRedemption(
  redemptionId: string,
  txHash: string,
  confirmations: number,
  feeRate: number,
): CompleteRedemptionResult {
  return tx((): CompleteRedemptionResult => {
    const r = db.query(`SELECT * FROM voucher_redemptions WHERE id = ?`).get(redemptionId) as {
      id: string;
      voucher_id: string;
      user_id: string | null;
      status: string;
      destination_address: string;
    } | null;
    if (!r) return { ok: false, error: "NOT_FOUND" };
    if (r.status === "COMPLETED") return { ok: false, error: "ALREADY_COMPLETED" };

    const v = db.query(`SELECT * FROM vouchers WHERE id = ?`).get(r.voucher_id) as VoucherRow;
    const txn = db
      .query(`SELECT id FROM transactions WHERE redemption_id = ? ORDER BY created_at LIMIT 1`)
      .get(r.id) as { id: string };

    const now = nowIso();
    db.query(
      `UPDATE transactions SET status = 'CONFIRMED', tx_hash = ?, confirmations = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(txHash, confirmations, now, now, txn.id);
    db.query(
      `UPDATE voucher_redemptions SET status = 'COMPLETED', completed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, r.id);
    db.query(
      `UPDATE vouchers SET status = 'REDEEMED', redeemed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, v.id);

    const fee = Math.round(v.denomination * feeRate * 100) / 100;
    const net = Math.round((v.denomination - fee) * 100) / 100;

    postJournal(
      [
        { account: "VOUCHER_LIABILITY", direction: "DEBIT", amount: v.denomination },
        { account: "CUSTOMER_PAYOUT", direction: "CREDIT", amount: net },
        { account: "FEES", direction: "CREDIT", amount: fee },
      ],
      v.id,
      txn.id,
      `Voucher redemption ${v.public_id}`,
    );
    postJournal(
      [
        { account: "CUSTOMER_PAYOUT", direction: "DEBIT", amount: net },
        { account: "TREASURY_USDT", direction: "CREDIT", amount: net },
      ],
      v.id,
      txn.id,
      `Simulated payout settlement ${v.public_id}`,
    );

    writeAuditSync({
      actorId: r.user_id,
      actorLabel: r.user_id ?? "anonymous_customer",
      action: "REDEMPTION_APPROVED",
      entity: "voucher",
      entityId: v.public_id,
      metadata: {
        tx_hash: txHash,
        amount: v.denomination,
        fee,
        destination: r.destination_address,
      },
    });

    return {
      ok: true,
      tx_hash: txHash,
      amount: v.denomination,
      fee,
      asset: v.asset,
      network: v.network,
      destination: r.destination_address,
      confirmed_at: now,
      public_id: v.public_id,
    };
  });
}

export function failRedemption(
  redemptionId: string,
  error: string,
): { ok: boolean; error?: string } {
  return tx(() => {
    const r = db.query(`SELECT * FROM voucher_redemptions WHERE id = ?`).get(redemptionId) as {
      id: string;
      voucher_id: string;
      user_id: string | null;
    } | null;
    if (!r) return { ok: false, error: "NOT_FOUND" };
    const now = nowIso();
    db.query(
      `UPDATE transactions SET status = 'FAILED', updated_at = ? WHERE redemption_id = ?`,
    ).run(now, r.id);
    db.query(
      `UPDATE voucher_redemptions SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ?`,
    ).run(error, now, r.id);
    db.query(
      `UPDATE vouchers SET status = 'SOLD', updated_at = ? WHERE id = ? AND status = 'REDEEMING'`,
    ).run(now, r.voucher_id);
    writeAuditSync({
      actorId: r.user_id,
      actorLabel: r.user_id ?? "anonymous_customer",
      action: "REDEMPTION_FAILED",
      entity: "voucher_redemption",
      entityId: r.id,
      metadata: { error },
    });
    return { ok: true };
  });
}
