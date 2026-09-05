import { db, newId, nowIso, tx } from "../client";
import { writeAuditSync } from "@/lib/services/audit.server";
import { postJournal } from "./ledger";
import { manualReviewOpen } from "./reviews";
import { canOrderTransition, type OrderStatus } from "@/lib/orders/state-machine";

export type OrderFulfillResult =
  | {
      ok: true;
      replayed: boolean;
      delivery_id: string;
      voucher_id: string;
      voucher_public_id?: string;
      overpayment?: number;
    }
  | { ok: false; error: string; status?: string };

/** Atomic payment -> voucher fulfilment. Idempotent: a second call for the same order replays the first delivery row. */
export function orderFulfill(orderId: string): OrderFulfillResult {
  return tx((): OrderFulfillResult => {
    const order = db.query(`SELECT * FROM orders WHERE id = ?`).get(orderId) as {
      id: string;
      public_order_id: string;
      voucher_id: string;
      customer_id: string | null;
      order_status: OrderStatus;
      amount: number;
    } | null;
    if (!order) return { ok: false, error: "NOT_FOUND" };

    const existingDelivery = db
      .query(`SELECT id FROM voucher_deliveries WHERE order_id = ?`)
      .get(order.id) as { id: string } | null;
    if (existingDelivery) {
      return {
        ok: true,
        replayed: true,
        delivery_id: existingDelivery.id,
        voucher_id: order.voucher_id,
      };
    }

    const payment = db.query(`SELECT * FROM payment_requests WHERE order_id = ?`).get(order.id) as {
      id: string;
      status: string;
      detected_amount: number;
      required_amount: number;
    } | null;
    if (!payment) return { ok: false, error: "NO_PAYMENT" };
    if (payment.status !== "CONFIRMED" && payment.status !== "OVERPAID") {
      return { ok: false, error: "PAYMENT_NOT_CONFIRMED", status: payment.status };
    }

    const voucher = db.query(`SELECT * FROM vouchers WHERE id = ?`).get(order.voucher_id) as {
      id: string;
      public_id: string;
      status: string;
      reserved_order_id: string | null;
      denomination: number;
    } | null;
    if (!voucher) return { ok: false, error: "VOUCHER_MISSING" };
    if (voucher.status !== "RESERVED" || voucher.reserved_order_id !== order.id) {
      manualReviewOpen({
        kind: "RESERVATION_LOST",
        subjectType: "order",
        subjectId: order.public_order_id,
        detail: `Voucher ${voucher.public_id} is ${voucher.status} and no longer reserved for this paid order`,
        severity: "CRITICAL",
        orderId: order.id,
        paymentId: payment.id,
        voucherId: voucher.id,
        dedupeKey: `RESERVATION_LOST:${order.public_order_id}`,
      });
      db.query(
        `UPDATE orders SET order_status = 'FULFILLMENT_FAILED', updated_at = ? WHERE id = ?`,
      ).run(nowIso(), order.id);
      return { ok: false, error: "RESERVATION_LOST", status: voucher.status };
    }

    const now = nowIso();
    db.query(
      `UPDATE vouchers SET status = 'SOLD', sold_at = ?, sale_price = ?, reserved_until = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, order.amount, now, voucher.id);

    const excess = Math.max(
      Math.round((payment.detected_amount - payment.required_amount) * 100) / 100,
      0,
    );
    const lines = [
      {
        account: "CUSTOMER_PAYMENTS",
        direction: "DEBIT" as const,
        amount: payment.detected_amount,
      },
      {
        account: "VOUCHER_LIABILITY",
        direction: "CREDIT" as const,
        amount: payment.required_amount,
      },
    ];
    if (excess > 0)
      lines.push({
        account: "OVERPAYMENT_LIABILITY",
        direction: "CREDIT" as const,
        amount: excess,
      });
    postJournal(lines, voucher.id, null, `Voucher sale ${order.public_order_id}`);
    postJournal(
      [
        { account: "TREASURY_USDT", direction: "DEBIT", amount: payment.detected_amount },
        { account: "CUSTOMER_PAYMENTS", direction: "CREDIT", amount: payment.detected_amount },
      ],
      voucher.id,
      null,
      `Treasury sweep ${order.public_order_id}`,
    );

    const deliveryId = newId();
    db.query(
      `INSERT INTO voucher_deliveries (id, order_id, voucher_id, status, created_at, updated_at) VALUES (?, ?, ?, 'PENDING', ?, ?)`,
    ).run(deliveryId, order.id, voucher.id, now, now);

    const nextStatus: OrderStatus = canOrderTransition(order.order_status, "PAYMENT_CONFIRMED")
      ? "PAYMENT_CONFIRMED"
      : order.order_status;
    db.query(
      `UPDATE orders SET voucher_status = 'SOLD', order_status = ?, payment_status = 'CONFIRMED', updated_at = ? WHERE id = ?`,
    ).run(nextStatus, now, order.id);
    db.query(`UPDATE payment_requests SET status = 'CONFIRMED', updated_at = ? WHERE id = ?`).run(
      now,
      payment.id,
    );

    writeAuditSync({
      actorId: order.customer_id,
      actorLabel: order.customer_id ?? "anonymous_customer",
      action: "ORDER_FULFILLED",
      entity: "order",
      entityId: order.public_order_id,
      metadata: {
        voucher: voucher.public_id,
        amount: payment.detected_amount,
        overpayment: excess,
      },
    });

    return {
      ok: true,
      replayed: false,
      delivery_id: deliveryId,
      voucher_id: voucher.id,
      voucher_public_id: voucher.public_id,
      overpayment: excess,
    };
  });
}

export type DeliveryMarkResult = {
  ok: boolean;
  replayed?: boolean;
  status?: string;
  error?: string;
};

export function deliveryMark(
  deliveryId: string,
  status: "DELIVERED" | "FAILED" | "MANUAL_REVIEW",
  error?: string | null,
): DeliveryMarkResult {
  return tx((): DeliveryMarkResult => {
    const d = db.query(`SELECT * FROM voucher_deliveries WHERE id = ?`).get(deliveryId) as {
      id: string;
      order_id: string;
      voucher_id: string;
      status: string;
      attempts: number;
    } | null;
    if (!d) return { ok: false, error: "NOT_FOUND" };
    if (d.status === "DELIVERED") return { ok: true, replayed: true, status: d.status };

    const now = nowIso();
    db.query(
      `UPDATE voucher_deliveries SET status = ?, last_error = ?, attempts = attempts + 1, delivered_at = CASE WHEN ? = 'DELIVERED' THEN ? ELSE delivered_at END, updated_at = ? WHERE id = ?`,
    ).run(status, error ?? null, status, now, now, d.id);

    const order = db.query(`SELECT * FROM orders WHERE id = ?`).get(d.order_id) as {
      id: string;
      public_order_id: string;
      order_status: OrderStatus;
      customer_id: string | null;
    } | null;
    if (order) {
      if (status === "DELIVERED") {
        if (canOrderTransition(order.order_status, "VOUCHER_DELIVERED")) {
          db.query(
            `UPDATE orders SET order_status = 'VOUCHER_DELIVERED', updated_at = ? WHERE id = ?`,
          ).run(now, order.id);
          db.query(
            `UPDATE orders SET order_status = 'COMPLETED', updated_at = ? WHERE id = ? AND order_status = 'VOUCHER_DELIVERED'`,
          ).run(now, order.id);
        }
      } else {
        if (canOrderTransition(order.order_status, "FULFILLMENT_FAILED")) {
          db.query(
            `UPDATE orders SET order_status = 'FULFILLMENT_FAILED', updated_at = ? WHERE id = ?`,
          ).run(now, order.id);
        }
        manualReviewOpen({
          kind: "DELIVERY_FAILED",
          subjectType: "order",
          subjectId: order.public_order_id,
          detail: error ?? "Delivery failed",
          severity: "CRITICAL",
          orderId: order.id,
          voucherId: d.voucher_id,
          dedupeKey: `DELIVERY_FAILED:${order.public_order_id}`,
        });
      }
      writeAuditSync({
        actorId: order.customer_id,
        actorLabel: "delivery_worker",
        action: `DELIVERY_${status}`,
        entity: "order",
        entityId: order.public_order_id,
        metadata: { delivery_id: d.id, error: error ?? null },
      });
    }

    return { ok: true, replayed: false, status };
  });
}
