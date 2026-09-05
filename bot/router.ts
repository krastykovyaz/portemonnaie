import type { Ctx } from "./context";
import { reply } from "./context";
import { handleStart, handleWhoami } from "./commands/start";
import {
  handleBuy,
  handleBuyDenom,
  handleBuyPay,
  handleBuyCheck,
  handleOrderLookup,
} from "./commands/buy";
import { handleRedeemStart, handleRedeemText } from "./commands/redeem";
import { handleMyAgent, handleSell } from "./commands/agent";
import {
  handleOverview,
  handleVouchers,
  handlePayouts,
  handleLedger,
  handleAudit,
  handleAgentsList,
  handleLinkAgent,
  handleBlockVoucher,
  handleUnblockVoucher,
  handleCancelVoucher,
  handleRetryPayout,
  handleReviewPayout,
  handleReleaseVoucher,
  handlePausePayouts,
  handleResumePayouts,
} from "./commands/admin";

export async function routeMessage(ctx: Ctx, text: string): Promise<void> {
  if (!text.startsWith("/")) {
    const handledByFlow = await handleRedeemText(ctx, text);
    if (handledByFlow) return;
    await reply(ctx, "Not sure what to do with that. Send /start to see the menu.");
    return;
  }

  const [rawCommand, ...args] = text.trim().split(/\s+/);
  const command = (rawCommand ?? "").split("@")[0]!.toLowerCase();

  switch (command) {
    case "/start":
    case "/help":
      return handleStart(ctx);
    case "/whoami":
      return handleWhoami(ctx);
    case "/cancel":
      await handleRedeemText(ctx, "/cancel");
      return;
    case "/buy":
      return handleBuy(ctx);
    case "/order":
      return args[0]
        ? handleOrderLookup(ctx, args[0])
        : reply(ctx, "Usage: /order <public_order_id>");
    case "/redeem":
      return handleRedeemStart(ctx);
    case "/myagent":
      return handleMyAgent(ctx);
    case "/sell":
      return args[0] ? handleSell(ctx, args[0]) : reply(ctx, "Usage: /sell <voucher_public_id>");
    case "/overview":
      return handleOverview(ctx);
    case "/vouchers":
      return handleVouchers(ctx, args[0]);
    case "/payouts":
      return handlePayouts(ctx, args[0]);
    case "/ledger":
      return handleLedger(ctx);
    case "/audit":
      return handleAudit(ctx);
    case "/agents":
      return handleAgentsList(ctx);
    case "/linkagent":
      return handleLinkAgent(ctx, args[0], args[1]);
    case "/blockvoucher":
      return handleBlockVoucher(ctx, args[0]);
    case "/unblockvoucher":
      return handleUnblockVoucher(ctx, args[0]);
    case "/cancelvoucher":
      return handleCancelVoucher(ctx, args[0]);
    case "/retrypayout":
      return handleRetryPayout(ctx, args[0]);
    case "/reviewpayout":
      return handleReviewPayout(ctx, args[0], args.slice(1).join(" ") || undefined);
    case "/releasevoucher":
      return handleReleaseVoucher(ctx, args[0], args.slice(1).join(" ") || undefined);
    case "/pausepayouts":
      return handlePausePayouts(ctx, args.join(" ") || undefined);
    case "/resumepayouts":
      return handleResumePayouts(ctx);
    default:
      await reply(ctx, "Unknown command. Send /start to see the menu.");
  }
}

export async function routeCallback(ctx: Ctx, data: string): Promise<void> {
  const [scope, action, value] = data.split(":");
  if (scope === "buy") {
    if (action === "denom" && value) return handleBuyDenom(ctx, Number(value));
    if (action === "pay") return handleBuyPay(ctx);
    if (action === "check") return handleBuyCheck(ctx);
  }
}
