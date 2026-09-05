import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth.server";
import { DENOMINATIONS } from "../domain/types";

const createBatchSchema = z.object({
  denomination: z.number().refine((v) => (DENOMINATIONS as readonly number[]).includes(v), {
    message: "Unsupported denomination",
  }),
  quantity: z.number().int().min(1).max(500),
  expiresAt: z.string().min(4),
});

export const getAdminOverviewFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { getAdminOverview } = await import("../services/dashboard.server");
    return getAdminOverview();
  });

export const listVouchersFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { status?: string; agentId?: string; search?: string }) => input)
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { listVouchers } = await import("../services/voucher.server");
    return listVouchers({
      status: (data.status ?? "ALL") as never,
      agentId: data.agentId ?? null,
      search: data.search ?? "",
    });
  });

export const getVoucherDetailFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { voucherId: string }) => input)
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { getVoucherDetail } = await import("../services/voucher.server");
    return getVoucherDetail(data.voucherId);
  });

export const createBatchFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: unknown) => createBatchSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const { createBatch } = await import("../services/voucher.server");
    return createBatch({
      denomination: data.denomination,
      quantity: data.quantity,
      expiresAt: new Date(data.expiresAt).toISOString(),
      actorId: actor.userId,
      actorLabel: actor.label,
    });
  });

export const listBatchesFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { listBatches } = await import("../services/voucher.server");
    return listBatches();
  });

export const assignVouchersFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { voucherIds: string[]; agentId: string }) => input)
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const { assignVouchers } = await import("../services/voucher.server");
    return assignVouchers({
      voucherIds: data.voucherIds,
      agentId: data.agentId,
      actorId: actor.userId,
      actorLabel: actor.label,
    });
  });

export const voucherActionFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { voucherId: string; action: "BLOCK" | "CANCEL" | "UNBLOCK" }) => input)
  .handler(async ({ data, context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const service = await import("../services/voucher.server");
    if (data.action === "BLOCK")
      return service.blockVoucher(data.voucherId, actor.userId, actor.label);
    if (data.action === "CANCEL")
      return service.cancelVoucher(data.voucherId, actor.userId, actor.label);
    return service.unblockVoucher(data.voucherId, actor.userId, actor.label);
  });

export const listAgentsFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { listAgents } = await import("../services/agent.server");
    return listAgents();
  });

export const listTransactionsFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { listTransactions } = await import("../services/dashboard.server");
    return listTransactions();
  });

export const getLedgerFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { getReconciliation, listLedgerEntries } = await import("../services/ledger.server");
    const [reconciliation, entries] = await Promise.all([getReconciliation(), listLedgerEntries()]);
    return { reconciliation, entries };
  });

export const listAuditFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    await requireAdmin(context);
    const { listAudit } = await import("../services/audit.server");
    return listAudit();
  });

export const resetDemoDataFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAdmin } = await import("../services/guards.server");
    const actor = await requireAdmin(context);
    const { seedDemoData } = await import("@/lib/db/seed");
    await seedDemoData();
    const { writeAudit } = await import("../services/audit.server");
    await writeAudit({
      actorId: actor.userId,
      actorLabel: actor.label,
      action: "DEMO_DATA_RESET",
      entity: "system",
      entityId: "demo",
    });
    return { ok: true };
  });
