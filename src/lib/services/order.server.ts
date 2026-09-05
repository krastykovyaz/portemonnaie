import { db } from "@/lib/db/client";
import {
  orderCreate,
  orderSetStatus,
  releaseExpiredReservations as releaseExpired,
} from "@/lib/db/procedures/orders";
import { resolveRuntime } from "../providers/registry.server";
import type { OrderStatus, PaymentStatus } from "../orders/state-machine";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "../orders/state-machine";

export type OrderRow = {
  id: string;
  public_order_id: string;
  customer_id: string | null;
  voucher_id: string | null;
  denomination: number;
  amount: number;
  required_amount: number;
  received_amount: number;
  amount_difference: number;
  payment_asset: string;
  payment_network: string;
  payment_address: string | null;
  payment_tx_hash: string | null;
  payment_status: PaymentStatus;
  order_status: OrderStatus;
  mode: string;
  customer_email: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type OrderView = OrderRow & {
  order_status_label: string;
  payment_status_label: string;
  voucher_public_id: string | null;
  delivery_status: string | null;
  required_confirmations: number;
  confirmations: number;
};

export function orderLog(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ scope: "order", event, at: new Date().toISOString(), ...fields }));
}

const ORDER_SELECT = `
  SELECT o.*,
    v.public_id AS voucher_public_id,
    p.confirmations AS payment_confirmations,
    p.required_confirmations AS payment_required_confirmations,
    d.status AS delivery_status
  FROM orders o
  LEFT JOIN vouchers v ON v.id = o.voucher_id
  LEFT JOIN payment_requests p ON p.order_id = o.id
  LEFT JOIN voucher_deliveries d ON d.order_id = o.id
`;

function toView(row: Record<string, unknown>): OrderView {
  const orderStatus = row["order_status"] as OrderStatus;
  const paymentStatus = row["payment_status"] as PaymentStatus;
  return {
    id: String(row["id"]),
    public_order_id: String(row["public_order_id"]),
    customer_id: (row["customer_id"] as string | null) ?? null,
    voucher_id: (row["voucher_id"] as string | null) ?? null,
    denomination: Number(row["denomination"]),
    amount: Number(row["amount"]),
    required_amount: Number(row["required_amount"]),
    received_amount: Number(row["received_amount"]),
    amount_difference: Number(row["amount_difference"]),
    payment_asset: String(row["payment_asset"]),
    payment_network: String(row["payment_network"]),
    payment_address: (row["payment_address"] as string | null) ?? null,
    payment_tx_hash: (row["payment_tx_hash"] as string | null) ?? null,
    payment_status: paymentStatus,
    order_status: orderStatus,
    mode: String(row["mode"]),
    customer_email: (row["customer_email"] as string | null) ?? null,
    expires_at: String(row["expires_at"]),
    created_at: String(row["created_at"]),
    updated_at: String(row["updated_at"]),
    order_status_label: ORDER_STATUS_LABELS[orderStatus] ?? orderStatus,
    payment_status_label: PAYMENT_STATUS_LABELS[paymentStatus] ?? paymentStatus,
    voucher_public_id: (row["voucher_public_id"] as string | null) ?? null,
    delivery_status: (row["delivery_status"] as string | null) ?? null,
    confirmations: Number(row["payment_confirmations"] ?? 0),
    required_confirmations: Number(row["payment_required_confirmations"] ?? 3),
  };
}

/** Create an order. The voucher is reserved atomically and the same idempotency key always returns the same order. */
export async function createOrder(input: {
  denomination: number;
  idempotencyKey: string;
  customerId?: string | null;
  customerEmail?: string | null;
}) {
  const runtime = resolveRuntime();
  if (runtime.blockers.length > 0 && runtime.descriptor.mode === "MAINNET") {
    return { ok: false as const, error: "MODE_NOT_READY", detail: runtime.blockers };
  }

  const deposit = await runtime.gateway.getDepositAddress(input.idempotencyKey);

  const result = orderCreate({
    denomination: input.denomination,
    idempotencyKey: input.idempotencyKey,
    paymentAddress: deposit.address,
    asset: deposit.asset,
    network: deposit.network,
    requiredAmount: input.denomination,
    ttlMinutes: runtime.paymentTtlMinutes,
    requiredConfirmations: runtime.requiredConfirmations,
    mode: runtime.descriptor.mode,
    customerId: input.customerId ?? null,
    customerEmail: input.customerEmail ?? null,
    contractAddress: deposit.contractAddress ?? null,
  });
  if (!result.ok) return { ok: false as const, error: result.error };

  orderLog(result.replayed ? "created.replayed" : "created", {
    orderId: result.order_id,
    publicOrderId: result.public_order_id,
    denomination: input.denomination,
    mode: runtime.descriptor.mode,
  });

  return {
    ok: true as const,
    replayed: result.replayed,
    orderId: result.order_id,
    publicOrderId: result.public_order_id,
    paymentId: result.payment_id,
    requiredAmount: result.required_amount,
    expiresAt: result.expires_at,
    deposit,
    mode: runtime.descriptor.mode,
    memo: deposit.memo,
  };
}

export async function getOrderByPublicId(publicOrderId: string): Promise<OrderView | null> {
  const row = db
    .query(`${ORDER_SELECT} WHERE o.public_order_id = ?`)
    .get(publicOrderId.toUpperCase()) as Record<string, unknown> | null;
  return row ? toView(row) : null;
}

export async function getOrderById(orderId: string): Promise<OrderView | null> {
  const row = db.query(`${ORDER_SELECT} WHERE o.id = ?`).get(orderId) as Record<
    string,
    unknown
  > | null;
  return row ? toView(row) : null;
}

export async function listOrders(filter: { status?: string; limit?: number } = {}) {
  const status = filter.status && filter.status !== "ALL" ? filter.status : null;
  const rows = db
    .query(
      `${ORDER_SELECT} ${status ? "WHERE o.order_status = ?" : ""} ORDER BY o.created_at DESC LIMIT ?`,
    )
    .all(...(status ? [status, filter.limit ?? 200] : [filter.limit ?? 200])) as Array<
    Record<string, unknown>
  >;
  return rows.map(toView);
}

export async function getOrderStats() {
  const rows = db.query(`SELECT order_status, amount FROM orders`).all() as Array<{
    order_status: OrderStatus;
    amount: number;
  }>;
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.order_status] = (byStatus[row.order_status] ?? 0) + 1;
  const completed = rows.filter((r) => r.order_status === "COMPLETED");
  return {
    total: rows.length,
    completed: completed.length,
    completedValue: completed.reduce((sum, r) => sum + Number(r.amount), 0),
    awaitingPayment:
      (byStatus["PAYMENT_PENDING"] ?? 0) +
      (byStatus["PAYMENT_DETECTED"] ?? 0) +
      (byStatus["RESERVED"] ?? 0),
    needsAttention:
      (byStatus["PAYMENT_UNDERPAID"] ?? 0) +
      (byStatus["PAYMENT_OVERPAID"] ?? 0) +
      (byStatus["FULFILLMENT_FAILED"] ?? 0) +
      (byStatus["MANUAL_REVIEW"] ?? 0),
    expired: byStatus["PAYMENT_EXPIRED"] ?? 0,
    byStatus,
  };
}

export async function releaseExpiredReservations() {
  const result = releaseExpired();
  if (result.released) orderLog("reservations.released", { released: result.released });
  return result;
}

export async function setOrderStatus(input: {
  orderId: string;
  status: OrderStatus;
  reason?: string;
  actorId?: string | null;
  actorLabel?: string;
}) {
  return orderSetStatus({
    orderId: input.orderId,
    status: input.status,
    actorId: input.actorId ?? null,
  });
}

export async function getInventoryAvailability() {
  const rows = db
    .query(
      `SELECT denomination, status FROM vouchers WHERE status IN ('CREATED','ASSIGNED','RESERVED')`,
    )
    .all() as Array<{ denomination: number; status: string }>;
  const map = new Map<number, { available: number; reserved: number }>();
  for (const row of rows) {
    const denom = Number(row.denomination);
    const entry = map.get(denom) ?? { available: 0, reserved: 0 };
    if (row.status === "RESERVED") entry.reserved += 1;
    else entry.available += 1;
    map.set(denom, entry);
  }
  return [...map.entries()]
    .map(([denomination, counts]) => ({ denomination, ...counts }))
    .sort((a, b) => a.denomination - b.denomination);
}
