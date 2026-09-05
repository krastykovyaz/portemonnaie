import type { Ctx } from "../context";
import { reply } from "../context";

export async function handleStart(ctx: Ctx): Promise<void> {
  const lines = [
    "<b>VoucherRail — Telegram console</b>",
    "DEMO / TESTNET only — no real funds move here.",
    "",
    "<b>Buy &amp; redeem</b>",
    "/buy — buy a voucher",
    "/order &lt;id&gt; — check an order's status",
    "/redeem — redeem a voucher you hold",
    "/whoami — show your Telegram id and role",
  ];
  if (ctx.identity.role === "agent" || ctx.identity.role === "admin") {
    lines.push(
      "",
      "<b>Agent</b>",
      "/myagent — your workspace",
      "/sell &lt;voucher_id&gt; — mark a voucher sold",
    );
  }
  if (ctx.identity.role === "admin") {
    lines.push(
      "",
      "<b>Admin</b>",
      "/overview, /vouchers, /payouts, /ledger, /audit, /agents",
      "/linkagent &lt;agent_ref&gt; — link the next person who messages this bot",
      "/blockvoucher, /unblockvoucher, /cancelvoucher &lt;public_id&gt;",
      "/retrypayout, /reviewpayout, /releasevoucher &lt;payout_id&gt;",
      "/pausepayouts [reason], /resumepayouts",
    );
  }
  await reply(ctx, lines.join("\n"));
}

export async function handleWhoami(ctx: Ctx): Promise<void> {
  await reply(
    ctx,
    [
      `Telegram id: <code>${ctx.user.id}</code>`,
      ctx.user.username ? `Username: @${ctx.user.username}` : null,
      `Role: <b>${ctx.identity.role}</b>`,
      ctx.identity.role === "agent"
        ? `Agent: ${ctx.identity.agent.name} (${ctx.identity.agent.agent_ref})`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
