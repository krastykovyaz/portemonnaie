import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/require-auth.server";

export const getOpsRuntimeFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { runtimeSummary } = await import("../providers/registry.server");
    const { getPayoutSettings } = await import("../services/payout.server");
    return { runtime: runtimeSummary(), payoutSettings: await getPayoutSettings() };
  });

export const listOrdersFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { status?: string }) => input)
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { listOrders, getOrderStats, getInventoryAvailability } =
      await import("../services/order.server");
    const [orders, stats, availability] = await Promise.all([
      listOrders({ status: data.status ?? "ALL" }),
      getOrderStats(),
      getInventoryAvailability(),
    ]);
    return { orders, stats, availability };
  });

export const runPaymentSweepFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const { runPaymentSweep } = await import("../services/payment-monitor.server");
    const result = await runPaymentSweep({ limit: 50 });
    const { auditOpsAction } = await import("../services/ops.server");
    await auditOpsAction({
      actorId: actor.userId,
      actorLabel: actor.label,
      action: "PAYMENT_SWEEP_RUN",
    });
    return result;
  });

export const listPayoutsFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { status?: string }) => input)
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { listPayouts, getPayoutStats, getPayoutSettings } =
      await import("../services/payout.server");
    const [payouts, stats, settings] = await Promise.all([
      listPayouts({ status: data.status ?? "ALL" }),
      getPayoutStats(),
      getPayoutSettings(),
    ]);
    return { payouts, stats, settings };
  });

export const payoutActionFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (input: { payoutId: string; action: "RETRY" | "MANUAL_REVIEW" | "RELEASE"; reason?: string }) =>
      input,
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const service = await import("../services/payout.server");
    const reason = data.reason?.slice(0, 500) ?? "admin action";
    if (data.action === "RETRY")
      return service.retryPayout({
        payoutId: data.payoutId,
        actorId: actor.userId,
        actorLabel: actor.label,
      });
    if (data.action === "MANUAL_REVIEW")
      return service.flagManualReview({
        payoutId: data.payoutId,
        reason,
        actorId: actor.userId,
        actorLabel: actor.label,
      });
    return service.releaseStuckVoucher({
      payoutId: data.payoutId,
      reason,
      actorId: actor.userId,
      actorLabel: actor.label,
    });
  });

export const setPayoutsEnabledFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { enabled: boolean; reason?: string }) => input)
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const { setPayoutsEnabled } = await import("../services/payout.server");
    return setPayoutsEnabled({
      enabled: data.enabled,
      actorId: actor.userId,
      actorLabel: actor.label,
      ...(data.reason ? { reason: data.reason } : {}),
    });
  });

export const runPayoutRecoveryFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const { runRecoverySweep } = await import("../services/payout.server");
    return runRecoverySweep({ worker: `admin:${actor.label}`, limit: 20 });
  });

export const getOpsQueuesFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { reviewStatus?: string }) => input)
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const ops = await import("../services/ops.server");
    const { listPendingDeliveries } = await import("../services/delivery.server");
    const [reviews, treasury, recon, deliveries] = await Promise.all([
      ops.listManualReviews(data.reviewStatus ?? "OPEN"),
      ops.listTreasury(),
      ops.listReconciliation(),
      listPendingDeliveries(25),
    ]);
    return { reviews, treasury, recon, deliveries };
  });

export const resolveReviewFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (input: { reviewId: string; resolution: string; status: "RESOLVED" | "REJECTED" }) => input,
  )
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const { resolveManualReview } = await import("../services/ops.server");
    return resolveManualReview({
      reviewId: data.reviewId,
      resolution: data.resolution.slice(0, 500),
      status: data.status,
      actorId: actor.userId,
      actorLabel: actor.label,
    });
  });

export const runOrderReconciliationFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const ops = await import("../services/ops.server");
    const result = await ops.reconcileOrders();
    await ops.auditOpsAction({
      actorId: actor.userId,
      actorLabel: actor.label,
      action: "ORDER_RECONCILIATION_RUN",
      entityId: result.runId,
    });
    return result;
  });

export const syncTreasuryFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { syncTreasury } = await import("../services/ops.server");
    return syncTreasury();
  });

export const retryDeliveryFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { orderId: string }) => input)
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { retryDelivery } = await import("../services/delivery.server");
    return retryDelivery(data.orderId);
  });
