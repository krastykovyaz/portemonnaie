import type { Ctx } from "../context";
import { reply } from "../context";
import { clearFlow } from "../session";
import { money, shortDate, code } from "../format";

export async function handleRedeemStart(ctx: Ctx): Promise<void> {
  ctx.session.redeem = { step: "AWAIT_PUBLIC_ID" };
  await reply(ctx, "Send the voucher's public ID (looks like VPQ48KD2N9). Send /cancel to stop.");
}

export async function handleRedeemText(ctx: Ctx, text: string): Promise<boolean> {
  const flow = ctx.session.redeem;
  if (!flow) return false;

  if (text.trim().toLowerCase() === "/cancel") {
    clearFlow(ctx.chatId);
    await reply(ctx, "Redemption cancelled.");
    return true;
  }

  if (flow.step === "AWAIT_PUBLIC_ID") {
    const publicId = text.trim().toUpperCase();
    ctx.session.redeem = { step: "AWAIT_CODE", publicId };
    await reply(ctx, "Now send the voucher code (looks like VCH-XXXX-XXXX-XXXX).");
    return true;
  }

  if (flow.step === "AWAIT_CODE") {
    const voucherCode = text.trim();
    const { previewVoucher, explainError } = await import("@/lib/services/redemption.server");
    const preview = await previewVoucher(flow.publicId, voucherCode);
    if (!preview.ok) {
      await reply(ctx, explainError(preview.error, preview.status));
      clearFlow(ctx.chatId);
      return true;
    }
    ctx.session.redeem = { step: "AWAIT_DESTINATION", publicId: flow.publicId, code: voucherCode };
    await reply(
      ctx,
      [
        `Voucher confirmed: ${money(preview.denomination)}, expires ${shortDate(preview.expires_at)}.`,
        "Send the TRON destination address to receive the payout.",
      ].join("\n"),
    );
    return true;
  }

  if (flow.step === "AWAIT_DESTINATION") {
    const destination = text.trim();
    const { redeemVoucher } = await import("@/lib/services/redemption.server");
    const outcome = await redeemVoucher({ publicId: flow.publicId, code: flow.code, destination });
    clearFlow(ctx.chatId);
    if (!outcome.ok) {
      await reply(ctx, outcome.error);
      return true;
    }
    const r = outcome.result;
    await reply(
      ctx,
      [
        "✅ Redeemed.",
        `Amount: ${money(r.amount)} (fee ${money(r.fee)})`,
        `Tx: ${code(r.tx_hash)}`,
        `Confirmations: ${r.confirmations}`,
        `Confirmed: ${shortDate(r.confirmed_at)}`,
      ].join("\n"),
    );
    return true;
  }

  return false;
}
