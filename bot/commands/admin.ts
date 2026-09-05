import type { Ctx } from "../context";
import { reply } from "../context";
import { money, shortDate, bulletList, code } from "../format";

function requireAdmin(ctx: Ctx): boolean {
  return ctx.identity.role === "admin";
}

export async function handleOverview(ctx: Ctx): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  const { getAdminOverview } = await import("@/lib/services/dashboard.server");
  const overview = await getAdminOverview();
  const k = overview.kpis;
  await reply(
    ctx,
    [
      "<b>Overview</b>",
      `Vouchers: ${k.totalVouchers} total, ${k.activeVouchers} active, ${k.soldVouchers} sold, ${k.redeemedVouchers} redeemed`,
      `Value: ${money(k.totalValue)} issued, ${money(k.redeemedValue)} redeemed`,
      `Liability: ${money(k.outstandingLiability)} · Treasury: ${money(k.treasury)} · Fees: ${money(k.fees)}`,
      `Ledger balanced: ${overview.balanced ? "yes" : "⚠️ NO"}`,
    ].join("\n"),
  );
}

export async function handleVouchers(ctx: Ctx, status?: string): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  const { listVouchers } = await import("@/lib/services/voucher.server");
  const vouchers = await listVouchers({
    status: (status?.toUpperCase() ?? "ALL") as never,
    limit: 20,
  });
  await reply(
    ctx,
    [
      `<b>Vouchers</b>${status ? ` (${status.toUpperCase()})` : ""} — showing up to 20`,
      bulletList(
        vouchers.map((v) => `${code(v.public_id)} — ${v.status} — ${money(v.denomination)}`),
      ) || "None found.",
    ].join("\n"),
  );
}

export async function handlePayouts(ctx: Ctx, status?: string): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  const { listPayouts, getPayoutStats } = await import("@/lib/services/payout.server");
  const [payouts, stats] = await Promise.all([
    listPayouts(status ? { status: status.toUpperCase() } : {}),
    getPayoutStats(),
  ]);
  await reply(
    ctx,
    [
      `<b>Payouts</b> — ${stats.inFlight} in flight, ${stats.failed} failed, ${stats.manualReview} in manual review`,
      bulletList(
        payouts
          .slice(0, 15)
          .map(
            (p) =>
              `${code(p.id)} — ${p.status_label} — ${money(p.amount)} — ${p.voucher_public_id ?? "—"}`,
          ),
      ) || "None found.",
    ].join("\n"),
  );
}

export async function handleLedger(ctx: Ctx): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  const { getLedgerBalances, getReconciliation } = await import("@/lib/services/ledger.server");
  const [balances, reconciliation] = await Promise.all([getLedgerBalances(), getReconciliation()]);
  await reply(
    ctx,
    [
      `<b>Ledger</b> — balanced: ${reconciliation.balanced ? "yes" : "⚠️ NO"}`,
      bulletList(balances.map((b) => `${b.code} (${b.account_type}) — ${money(b.balance)}`)),
    ].join("\n"),
  );
}

export async function handleAudit(ctx: Ctx): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  const { listAudit } = await import("@/lib/services/audit.server");
  const entries = await listAudit(15);
  await reply(
    ctx,
    [
      "<b>Recent audit entries</b>",
      bulletList(
        entries.map(
          (e) =>
            `${shortDate(e.created_at)} — ${e.action} — ${e.entity} — ${e.actor_label ?? "system"}`,
        ),
      ) || "None yet.",
    ].join("\n"),
  );
}

export async function handleAgentsList(ctx: Ctx): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  const { listAgents } = await import("@/lib/services/agent.server");
  const agents = await listAgents();
  await reply(
    ctx,
    [
      "<b>Agents</b>",
      bulletList(
        agents.map(
          (a) =>
            `${a.name} (${a.agent_ref}) — inventory ${a.inventory}, sold ${a.sold}, commission ${money(a.commission)}`,
        ),
      ) || "None yet.",
    ].join("\n"),
  );
}

export async function handleLinkAgent(
  ctx: Ctx,
  agentRef?: string,
  telegramId?: string,
): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  const id = Number(telegramId);
  if (!agentRef || !telegramId || !Number.isFinite(id)) {
    await reply(
      ctx,
      "Usage: /linkagent &lt;agent_ref&gt; &lt;telegram_id&gt;\nThe agent gets their id from /whoami.",
    );
    return;
  }
  const { linkAgentTelegram } = await import("@/lib/services/agent.server");
  const agent = await linkAgentTelegram(agentRef, id);
  if (!agent) {
    await reply(ctx, `No agent with ref ${agentRef}.`);
    return;
  }
  await reply(ctx, `Linked ${agent.name} (${agent.agent_ref}) to Telegram id ${id}.`);
}

async function voucherAction(
  ctx: Ctx,
  publicId: string | undefined,
  action: (
    voucherId: string,
    actorId: null,
    actorLabel: string,
  ) => Promise<{ public_id: string; status: string }>,
): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  if (!publicId) {
    await reply(ctx, "Usage: provide a voucher public id.");
    return;
  }
  const { getVoucherIdByPublicId } = await import("../lookups");
  const voucher = await getVoucherIdByPublicId(publicId);
  if (!voucher) {
    await reply(ctx, `Voucher ${publicId} not found.`);
    return;
  }
  try {
    const result = await action(voucher.id, null, ctx.identity.label);
    await reply(ctx, `${code(result.public_id)} is now ${result.status}.`);
  } catch (err) {
    await reply(ctx, `Failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

export async function handleBlockVoucher(ctx: Ctx, publicId?: string): Promise<void> {
  const { blockVoucher } = await import("@/lib/services/voucher.server");
  await voucherAction(ctx, publicId, blockVoucher);
}

export async function handleUnblockVoucher(ctx: Ctx, publicId?: string): Promise<void> {
  const { unblockVoucher } = await import("@/lib/services/voucher.server");
  await voucherAction(ctx, publicId, unblockVoucher);
}

export async function handleCancelVoucher(ctx: Ctx, publicId?: string): Promise<void> {
  const { cancelVoucher } = await import("@/lib/services/voucher.server");
  await voucherAction(ctx, publicId, cancelVoucher);
}

export async function handleRetryPayout(ctx: Ctx, payoutId?: string): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  if (!payoutId) return reply(ctx, "Usage: /retrypayout <payout_id>");
  const { retryPayout } = await import("@/lib/services/payout.server");
  const result = await retryPayout({ payoutId, actorId: null, actorLabel: ctx.identity.label });
  await reply(
    ctx,
    result.ok ? `Retry started: ${result.outcome.status}` : `Failed: ${result.message}`,
  );
}

export async function handleReviewPayout(
  ctx: Ctx,
  payoutId?: string,
  reason?: string,
): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  if (!payoutId) return reply(ctx, "Usage: /reviewpayout <payout_id> [reason]");
  const { flagManualReview } = await import("@/lib/services/payout.server");
  const result = await flagManualReview({
    payoutId,
    reason: reason ?? "Flagged via Telegram",
    actorId: null,
    actorLabel: ctx.identity.label,
  });
  await reply(ctx, result.ok ? "Flagged for manual review." : `Failed: ${result.message}`);
}

export async function handleReleaseVoucher(
  ctx: Ctx,
  payoutId?: string,
  reason?: string,
): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  if (!payoutId) return reply(ctx, "Usage: /releasevoucher <payout_id> [reason]");
  const { releaseStuckVoucher } = await import("@/lib/services/payout.server");
  const result = await releaseStuckVoucher({
    payoutId,
    reason: reason ?? "Released via Telegram",
    actorId: null,
    actorLabel: ctx.identity.label,
  });
  await reply(ctx, result.ok ? "Voucher released back to SOLD." : `Failed: ${result.message}`);
}

export async function handlePausePayouts(ctx: Ctx, reason?: string): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  const { setPayoutsEnabled } = await import("@/lib/services/payout.server");
  await setPayoutsEnabled({
    enabled: false,
    reason: reason ?? "Paused via Telegram",
    actorId: null,
    actorLabel: ctx.identity.label,
  });
  await reply(ctx, "Payouts paused.");
}

export async function handleResumePayouts(ctx: Ctx): Promise<void> {
  if (!requireAdmin(ctx)) return reply(ctx, "Admins only.");
  const { setPayoutsEnabled } = await import("@/lib/services/payout.server");
  await setPayoutsEnabled({ enabled: true, actorId: null, actorLabel: ctx.identity.label });
  await reply(ctx, "Payouts resumed.");
}
