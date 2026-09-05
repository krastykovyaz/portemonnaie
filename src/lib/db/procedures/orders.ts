import { db, newId, nowIso, tx } from "../client";
import { canOrderTransition, type OrderStatus } from "@/lib/orders/state-machine";

function publicOrderId(): string {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `ORD-${stamp}-${suffix}`;
}

export type OrderCreateInput = {
  denomination: number;
  idempotencyKey: string;
  paymentAddress: string;
  asset: string;
  network: string;
  requiredAmount: number;
  ttlMinutes: number;
  requiredConfirmations: number;
  mode: string;
  customerId?: string | null;
  customerEmail?: string | null;
  contractAddress?: string | null;
};

export type OrderCreateResult =
  | {
      ok: true;
      replayed: boolean;
      order_id: string;
      public_order_id: string;
      payment_id: string;
      required_amount: number;
      expires_at: string;
    }
  | { ok: false; error: string };

/** Atomic inventory reservation + order + payment_request creation. Same idempotency key always replays the same order. */
export function orderCreate(input: OrderCreateInput): OrderCreateResult {
  return tx((): OrderCreateResult => {
    const existing = db
      .query(`SELECT * FROM orders WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as Record<string, unknown> | null;
    if (existing) {
      const payment = db
        .query(`SELECT id FROM payment_requests WHERE order_id = ?`)
        .get(existing["id"] as string) as { id: string } | null;
      return {
        ok: true,
        replayed: true,
        order_id: String(existing["id"]),
        public_order_id: String(existing["public_order_id"]),
        payment_id: String(payment?.id ?? ""),
        required_amount: Number(existing["required_amount"]),
        expires_at: String(existing["expires_at"]),
      };
    }

    const now = Date.now();
    const expires = new Date(now + Math.max(input.ttlMinutes, 1) * 60_000).toISOString();

    const voucher = db
      .query(
        `SELECT * FROM vouchers
         WHERE denomination = ? AND status IN ('CREATED','ASSIGNED') AND expires_at > ?
         ORDER BY created_at LIMIT 1`,
      )
      .get(input.denomination, expires) as Record<string, unknown> | null;
    if (!voucher) return { ok: false, error: "NO_INVENTORY" };

    const orderId = newId();
    const publicId = publicOrderId();
    const nowStr = nowIso();
    const amount = input.requiredAmount;

    db.query(
      `INSERT INTO orders (id, public_order_id, customer_id, agent_id, voucher_id, idempotency_key,
        denomination, amount, currency, payment_asset, payment_network, payment_address,
        payment_status, voucher_status, order_status, required_amount, mode, customer_email,
        expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USDT', ?, ?, ?, 'WAITING', 'RESERVED', 'PAYMENT_PENDING', ?, ?, ?, ?, ?, ?)`,
    ).run(
      orderId,
      publicId,
      input.customerId ?? null,
      (voucher["assigned_agent_id"] as string | null) ?? null,
      voucher["id"] as string,
      input.idempotencyKey,
      input.denomination,
      amount,
      input.asset,
      input.network,
      input.paymentAddress,
      amount,
      input.mode,
      input.customerEmail ?? null,
      expires,
      nowStr,
      nowStr,
    );

    db.query(
      `UPDATE vouchers SET status = 'RESERVED', reserved_order_id = ?, reserved_until = ?, updated_at = ? WHERE id = ?`,
    ).run(orderId, expires, nowStr, voucher["id"] as string);

    const paymentId = newId();
    db.query(
      `INSERT INTO payment_requests (id, order_id, asset, network, contract_address, required_amount,
        address, status, required_confirmations, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING', ?, ?, ?, ?)`,
    ).run(
      paymentId,
      orderId,
      input.asset,
      input.network,
      input.contractAddress ?? null,
      amount,
      input.paymentAddress,
      Math.max(input.requiredConfirmations, 1),
      expires,
      nowStr,
      nowStr,
    );

    return {
      ok: true,
      replayed: false,
      order_id: orderId,
      public_order_id: publicId,
      payment_id: paymentId,
      required_amount: amount,
      expires_at: expires,
    };
  });
}

export type OrderSetStatusResult = { ok: boolean; error?: string; status?: OrderStatus };

export function orderSetStatus(input: {
  orderId: string;
  status: OrderStatus;
  actorId?: string | null;
}): OrderSetStatusResult {
  return tx((): OrderSetStatusResult => {
    const order = db.query(`SELECT order_status FROM orders WHERE id = ?`).get(input.orderId) as {
      order_status: OrderStatus;
    } | null;
    if (!order) return { ok: false, error: "NOT_FOUND" };
    if (!canOrderTransition(order.order_status, input.status)) {
      return { ok: false, error: "INVALID_TRANSITION" };
    }
    db.query(`UPDATE orders SET order_status = ?, updated_at = ? WHERE id = ?`).run(
      input.status,
      nowIso(),
      input.orderId,
    );
    return { ok: true, status: input.status };
  });
}

export function releaseExpiredReservations(): { released: number } {
  return tx(() => {
    const now = nowIso();
    const rows = db
      .query(
        `SELECT o.id AS order_id, o.voucher_id, p.id AS payment_id
         FROM orders o
         JOIN payment_requests p ON p.order_id = o.id
         LEFT JOIN vouchers v ON v.id = o.voucher_id
         WHERE o.expires_at < ?
           AND o.order_status IN ('CREATED','RESERVED','PAYMENT_PENDING','PAYMENT_DETECTED')
           AND p.status IN ('WAITING','DETECTED','CONFIRMING')`,
      )
      .all(now) as Array<{ order_id: string; voucher_id: string | null; payment_id: string }>;

    for (const row of rows) {
      db.query(
        `UPDATE payment_requests SET status = 'EXPIRED', failure_reason = 'PAYMENT_WINDOW_EXPIRED', updated_at = ? WHERE id = ?`,
      ).run(now, row.payment_id);
      db.query(
        `UPDATE orders SET order_status = 'PAYMENT_EXPIRED', payment_status = 'EXPIRED', voucher_status = NULL, updated_at = ? WHERE id = ?`,
      ).run(now, row.order_id);
      if (row.voucher_id) {
        db.query(
          `UPDATE vouchers
           SET status = CASE WHEN assigned_agent_id IS NULL THEN 'CREATED' ELSE 'ASSIGNED' END,
               reserved_order_id = NULL, reserved_until = NULL, updated_at = ?
           WHERE id = ? AND status = 'RESERVED' AND reserved_order_id = ?`,
        ).run(now, row.voucher_id, row.order_id);
      }
    }
    return { released: rows.length };
  });
}
