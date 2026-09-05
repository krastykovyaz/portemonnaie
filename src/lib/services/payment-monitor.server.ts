import { db } from "@/lib/db/client";
import { paymentObserve } from "@/lib/db/procedures/payments";
import { resolveRuntime } from "../providers/registry.server";
import { isFulfillable, type PaymentStatus } from "../orders/state-machine";
import { fulfillAndDeliver } from "./delivery.server";
import { orderLog, releaseExpiredReservations } from "./order.server";

type PaymentRow = {
  id: string;
  order_id: string;
  address: string;
  required_amount: number;
  required_confirmations: number;
  status: PaymentStatus;
};

const OPEN_STATUSES: PaymentStatus[] = ["WAITING", "DETECTED", "CONFIRMING"];

/**
 * Idempotent monitor pass over one payment request: read chain transfers, record
 * each one (duplicates are ignored by a unique tx-hash constraint) and fulfil
 * the order as soon as the payment is confirmed.
 */
export async function checkPayment(paymentId: string) {
  const runtime = resolveRuntime();
  const payment = db
    .query(
      `SELECT id, order_id, address, required_amount, required_confirmations, status FROM payment_requests WHERE id = ?`,
    )
    .get(paymentId) as PaymentRow | null;
  if (!payment) return { ok: false as const, error: "NOT_FOUND" };

  const transfers = await runtime.gateway.getIncomingTransfers(payment.address);
  let status: PaymentStatus = payment.status;

  for (const transfer of transfers) {
    const confirmations = Math.max(
      transfer.confirmations,
      await runtime.gateway.getConfirmations(transfer.txHash),
    );
    const observed = paymentObserve({
      paymentId: payment.id,
      txHash: transfer.txHash,
      amount: transfer.amount,
      confirmations,
      fromAddress: transfer.fromAddress,
    });
    if (observed.ok && observed.status) status = observed.status;
    orderLog("payment.observed", {
      paymentId: payment.id,
      txHash: transfer.txHash,
      amount: transfer.amount,
      confirmations,
      status,
    });
  }

  if (isFulfillable(status)) {
    const fulfilment = await fulfillAndDeliver(payment.order_id);
    return { ok: true as const, status, orderId: payment.order_id, fulfilment };
  }
  return { ok: true as const, status, orderId: payment.order_id, fulfilment: null };
}

/** Recovery worker: sweeps every open payment plus expired reservations. */
export async function runPaymentSweep(input: { limit?: number } = {}) {
  const rows = db
    .query(
      `SELECT id FROM payment_requests WHERE status IN (${OPEN_STATUSES.map(() => "?").join(",")}) ORDER BY created_at LIMIT ?`,
    )
    .all(...OPEN_STATUSES, input.limit ?? 25) as Array<{ id: string }>;

  let confirmed = 0;
  let stillOpen = 0;
  const problems: { paymentId: string; error: string }[] = [];
  // The plaintext code is only ever returned once, at the moment of delivery.
  // A sweep can be the thing that delivers an order (real on-chain payments
  // are only ever detected here, never via the customer-facing simulate
  // button), so codes generated during this pass must be surfaced to the
  // admin who triggered it — otherwise they're gone for good.
  const delivered: { publicOrderId: string; voucherPublicId: string; code: string }[] = [];

  for (const row of rows) {
    try {
      const outcome = await checkPayment(row.id);
      if (outcome.ok && isFulfillable(outcome.status)) {
        confirmed += 1;
        if (outcome.fulfilment?.ok && !outcome.fulfilment.replayed) {
          const orderRow = db
            .query(`SELECT public_order_id FROM orders WHERE id = ?`)
            .get(outcome.orderId) as { public_order_id: string } | null;
          delivered.push({
            publicOrderId: orderRow?.public_order_id ?? outcome.orderId,
            voucherPublicId: outcome.fulfilment.voucherPublicId,
            code: outcome.fulfilment.code,
          });
        }
      } else stillOpen += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "SWEEP_ERROR";
      problems.push({ paymentId: row.id, error: message });
      orderLog("payment.sweep_error", { paymentId: row.id, error: message });
    }
  }

  const released = await releaseExpiredReservations();
  return { checked: rows.length, confirmed, stillOpen, problems, delivered, ...released };
}

/**
 * DEMO-only helper: pretend a customer sent USDT. Only available while the
 * simulated gateway is active, so it can never fabricate real transfers.
 */
export async function simulateCustomerPayment(input: {
  paymentId: string;
  amount?: number;
  confirmations?: number;
}) {
  const runtime = resolveRuntime();
  if (!runtime.gateway.simulated || runtime.gateway.id !== "mock-payment-gateway") {
    return { ok: false as const, error: "SIMULATION_DISABLED" };
  }
  const data = db
    .query(
      `SELECT id, address, required_amount, required_confirmations FROM payment_requests WHERE id = ?`,
    )
    .get(input.paymentId) as {
    id: string;
    address: string;
    required_amount: number;
    required_confirmations: number;
  } | null;
  if (!data) return { ok: false as const, error: "NOT_FOUND" };

  const { mockPaymentGateway } = await import("../providers/mock-payment-gateway");
  const required = Number(data.required_amount);
  mockPaymentGateway.simulateTransfer({
    toAddress: String(data.address),
    amount: input.amount ?? required,
    confirmations: input.confirmations ?? Number(data.required_confirmations),
    targetConfirmations: Number(data.required_confirmations),
  });
  return { ok: true as const, outcome: await checkPayment(input.paymentId) };
}
