import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { DENOMINATIONS } from "../domain/types";

const createOrderSchema = z.object({
  denomination: z.number().refine((v) => (DENOMINATIONS as readonly number[]).includes(v), {
    message: "Unsupported denomination",
  }),
  idempotencyKey: z.string().min(8).max(64),
  customerEmail: z.string().email().max(200).optional(),
});

/** Public: which denominations can actually be bought right now. */
export const getStorefrontFn = createServerFn({ method: "GET" }).handler(async () => {
  const { runtimeSummary } = await import("../providers/registry.server");
  const { getInventoryAvailability } = await import("../services/order.server");
  const [availability, runtime] = await Promise.all([
    getInventoryAvailability(),
    Promise.resolve(runtimeSummary()),
  ]);
  return {
    availability,
    mode: runtime.mode,
    label: runtime.label,
    banner: runtime.banner,
    asset: "USDT",
    network: runtime.network,
    requiredConfirmations: runtime.requiredConfirmations,
    paymentTtlMinutes: runtime.paymentTtlMinutes,
  };
});

/** Public: create an order. Idempotent — the same key returns the same order. */
export const createOrderFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createOrderSchema.parse(input))
  .handler(async ({ data }) => {
    const { createOrder } = await import("../services/order.server");
    const result = await createOrder({
      denomination: data.denomination,
      idempotencyKey: data.idempotencyKey,
      ...(data.customerEmail ? { customerEmail: data.customerEmail } : {}),
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      publicOrderId: result.publicOrderId,
      requiredAmount: result.requiredAmount,
      expiresAt: result.expiresAt,
      address: result.deposit.address,
      asset: result.deposit.asset,
      network: result.deposit.network,
      memo: result.memo,
      mode: result.mode,
    };
  });

/** Public: order status polling by public order id (no secrets exposed). */
export const getOrderStatusFn = createServerFn({ method: "POST" })
  .inputValidator((input: { publicOrderId: string }) => input)
  .handler(async ({ data }) => {
    const { getOrderByPublicId } = await import("../services/order.server");
    const order = await getOrderByPublicId(data.publicOrderId);
    if (!order) return { ok: false as const, error: "NOT_FOUND" };
    return {
      ok: true as const,
      order: {
        public_order_id: order.public_order_id,
        order_status: order.order_status,
        order_status_label: order.order_status_label,
        payment_status: order.payment_status,
        payment_status_label: order.payment_status_label,
        denomination: order.denomination,
        required_amount: order.required_amount,
        received_amount: order.received_amount,
        amount_difference: order.amount_difference,
        payment_address: order.payment_address,
        payment_asset: order.payment_asset,
        payment_network: order.payment_network,
        confirmations: order.confirmations,
        required_confirmations: order.required_confirmations,
        delivery_status: order.delivery_status,
        voucher_public_id: order.voucher_public_id,
        expires_at: order.expires_at,
        mode: order.mode,
      },
    };
  });

/**
 * DEMO-only: pretend the customer sent USDT. The service refuses unless the
 * simulated gateway is the active provider, so this can never fabricate a
 * real transfer.
 */
export const simulatePaymentFn = createServerFn({ method: "POST" })
  .inputValidator((input: { publicOrderId: string; amount?: number }) => input)
  .handler(async ({ data }) => {
    const { db } = await import("@/lib/db/client");
    const { getOrderByPublicId } = await import("../services/order.server");
    const order = await getOrderByPublicId(data.publicOrderId);
    if (!order) return { ok: false as const, error: "NOT_FOUND" };
    const payment = db
      .query(`SELECT id FROM payment_requests WHERE order_id = ?`)
      .get(order.id) as { id: string } | null;
    if (!payment) return { ok: false as const, error: "NO_PAYMENT" };

    const { simulateCustomerPayment } = await import("../services/payment-monitor.server");
    const outcome = await simulateCustomerPayment({
      paymentId: payment.id,
      ...(data.amount ? { amount: data.amount } : {}),
    });
    if (!outcome.ok) return { ok: false as const, error: outcome.error };

    const fulfilment =
      outcome.outcome.ok && outcome.outcome.fulfilment && outcome.outcome.fulfilment.ok
        ? outcome.outcome.fulfilment
        : null;
    return {
      ok: true as const,
      code: fulfilment && "code" in fulfilment ? fulfilment.code : null,
      voucherPublicId: fulfilment ? fulfilment.voucherPublicId : null,
    };
  });
