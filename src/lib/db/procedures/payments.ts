import { db, newId, nowIso, tx } from "../client";
import { writeAuditSync } from "@/lib/services/audit.server";
import { manualReviewOpen } from "./reviews";
import {
  classifyPayment,
  canOrderTransition,
  type OrderStatus,
  type PaymentStatus,
} from "@/lib/orders/state-machine";

export type PaymentObserveResult = {
  ok: true;
  replayed: boolean;
  duplicate: boolean;
  status: PaymentStatus;
  order_status?: OrderStatus;
  detected_amount: number;
  difference: number;
  order_id?: string;
  public_order_id?: string;
};

export function paymentObserve(input: {
  paymentId: string;
  txHash: string;
  amount: number;
  confirmations: number;
  fromAddress?: string | null;
  blockNumber?: number | null;
}): PaymentObserveResult | { ok: false; error: string } {
  return tx(() => {
    const pr = db.query(`SELECT * FROM payment_requests WHERE id = ?`).get(input.paymentId) as {
      id: string;
      order_id: string;
      address: string;
      contract_address: string | null;
      asset: string;
      network: string;
      required_amount: number;
      required_confirmations: number;
      status: PaymentStatus;
      tx_hash: string | null;
      confirmations: number;
    } | null;
    if (!pr) return { ok: false as const, error: "NOT_FOUND" };

    const order = db.query(`SELECT * FROM orders WHERE id = ?`).get(pr.order_id) as {
      id: string;
      public_order_id: string;
      order_status: OrderStatus;
      payment_tx_hash: string | null;
    } | null;

    const now = nowIso();
    const confirmations = Math.max(input.confirmations, 0);
    const dupe = db
      .query(`SELECT id, confirmations FROM payment_transactions WHERE tx_hash = ?`)
      .get(input.txHash) as { id: string; confirmations: number } | null;
    let duplicate = false;
    if (dupe) {
      duplicate = true;
      db.query(`UPDATE payment_transactions SET confirmations = ? WHERE tx_hash = ?`).run(
        Math.max(dupe.confirmations, confirmations),
        input.txHash,
      );
    } else {
      db.query(
        `INSERT INTO payment_transactions (id, payment_id, order_id, tx_hash, from_address, to_address, contract_address,
          asset, network, amount, confirmations, block_number, observed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(),
        pr.id,
        pr.order_id,
        input.txHash,
        input.fromAddress ?? null,
        pr.address,
        pr.contract_address,
        pr.asset,
        pr.network,
        input.amount,
        confirmations,
        input.blockNumber ?? null,
        now,
        now,
      );
    }

    const detected = (
      db
        .query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM payment_transactions WHERE payment_id = ?`,
        )
        .get(pr.id) as {
        total: number;
      }
    ).total;
    const difference = Math.round((detected - pr.required_amount) * 100) / 100;

    if (pr.status === "CONFIRMED") {
      db.query(
        `UPDATE payment_requests SET last_checked_at = ?, confirmations = ?, updated_at = ? WHERE id = ?`,
      ).run(now, Math.max(pr.confirmations, confirmations), now, pr.id);
      return {
        ok: true as const,
        replayed: true,
        duplicate,
        status: pr.status,
        detected_amount: detected,
        difference,
      };
    }

    const classified = classifyPayment({
      required: pr.required_amount,
      detected,
      confirmations,
      requiredConfirmations: pr.required_confirmations,
    });

    db.query(
      `UPDATE payment_requests SET status = ?, detected_amount = ?, amount_difference = ?, tx_hash = COALESCE(tx_hash, ?), confirmations = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
    ).run(classified.status, detected, difference, input.txHash, confirmations, now, now, pr.id);

    if (order) {
      const nextOrderStatus = canOrderTransition(order.order_status, classified.orderStatus)
        ? classified.orderStatus
        : order.order_status;
      db.query(
        `UPDATE orders SET payment_status = ?, received_amount = ?, amount_difference = ?, payment_tx_hash = COALESCE(payment_tx_hash, ?), order_status = ?, updated_at = ? WHERE id = ?`,
      ).run(classified.status, detected, difference, input.txHash, nextOrderStatus, now, order.id);

      if (classified.status === "UNDERPAID" || classified.status === "OVERPAID") {
        manualReviewOpen({
          kind: classified.status === "UNDERPAID" ? "PAYMENT_UNDERPAID" : "PAYMENT_OVERPAID",
          subjectType: "order",
          subjectId: order.public_order_id,
          detail: `Required ${pr.required_amount} ${pr.asset}, received ${detected} (difference ${difference})`,
          severity: classified.status === "UNDERPAID" ? "CRITICAL" : "WARNING",
          orderId: order.id,
          paymentId: pr.id,
          metadata: { required: pr.required_amount, received: detected, difference },
          dedupeKey: `${classified.status}:${order.public_order_id}`,
        });
      }

      writeAuditSync({
        actorId: null,
        actorLabel: "payment_monitor",
        action: "PAYMENT_OBSERVED",
        entity: "order",
        entityId: order.public_order_id,
        metadata: {
          tx_hash: input.txHash,
          amount: input.amount,
          confirmations,
          status: classified.status,
          duplicate,
        },
      });

      return {
        ok: true as const,
        replayed: false,
        duplicate,
        status: classified.status,
        order_status: nextOrderStatus,
        detected_amount: detected,
        difference,
        order_id: order.id,
        public_order_id: order.public_order_id,
      };
    }

    return {
      ok: true as const,
      replayed: false,
      duplicate,
      status: classified.status,
      detected_amount: detected,
      difference,
    };
  });
}
