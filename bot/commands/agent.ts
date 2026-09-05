import type { Ctx } from "../context";
import { reply } from "../context";
import { money, bulletList, code } from "../format";

export async function handleMyAgent(ctx: Ctx): Promise<void> {
  const { getAgentWorkspaceByTelegramId } = await import("@/lib/services/agent.server");
  const workspace = await getAgentWorkspaceByTelegramId(ctx.user.id);
  if (!workspace.agent || !workspace.stats) {
    await reply(ctx, "No agent profile is linked to this Telegram account.");
    return;
  }
  const { agent, stats } = workspace;
  await reply(
    ctx,
    [
      `<b>${agent.name}</b> (${agent.agent_ref})`,
      `Inventory: ${stats.inventory} · Available: ${stats.available}`,
      `Sold: ${stats.sold} · Redeemed: ${stats.redeemed}`,
      `Sales value: ${money(stats.salesValue)} · Commission: ${money(stats.commission)}`,
      "",
      "Recent vouchers:",
      bulletList(
        workspace.vouchers
          .slice(0, 10)
          .map((v) => `${code(v.public_id)} — ${v.status} — ${money(v.denomination)}`),
      ) || "None yet.",
    ].join("\n"),
  );
}

export async function handleSell(ctx: Ctx, publicId: string): Promise<void> {
  if (ctx.identity.role !== "agent") {
    await reply(ctx, "Only a linked agent can sell vouchers.");
    return;
  }
  const { getVoucherIdByPublicId } = await import("../lookups");
  const voucher = await getVoucherIdByPublicId(publicId);
  if (!voucher) {
    await reply(ctx, `Voucher ${publicId} not found.`);
    return;
  }
  const { markVoucherSold } = await import("@/lib/services/voucher.server");
  try {
    const sold = await markVoucherSold({
      voucherId: voucher.id,
      agentId: ctx.identity.agent.id,
      actorId: null,
      actorLabel: ctx.identity.label,
    });
    await reply(ctx, `Marked ${code(sold.public_id)} as sold.`);
  } catch (err) {
    await reply(
      ctx,
      `Could not mark as sold: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}
