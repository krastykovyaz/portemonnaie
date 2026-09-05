import type { Ctx } from "../context";
import { reply } from "../context";
import { DENOMINATIONS } from "@/lib/domain/types";
import { money, shortDate, code } from "../format";

function orderText(
  header: string,
  order: {
    order_status_label: string;
    payment_status_label: string;
    required_amount: number;
    received_amount: number;
    payment_address: string | null;
    expires_at: string;
    voucher_public_id: string | null;
    delivery_status: string | null;
  },
): string {
  const lines = [
    header,
    `Status: <b>${order.order_status_label}</b> / payment ${order.payment_status_label}`,
    `Amount due: ${money(order.required_amount)} (received ${money(order.received_amount)})`,
  ];
  if (order.payment_address) lines.push(`Deposit address: ${code(order.payment_address)}`);
  lines.push(`Expires: ${shortDate(order.expires_at)}`);
  if (order.voucher_public_id)
    lines.push(`Voucher: ${code(order.voucher_public_id)} (${order.delivery_status ?? "PENDING"})`);
  return lines.join("\n");
}

export async function handleBuy(ctx: Ctx): Promise<void> {
  const { getInventoryAvailability } = await import("@/lib/services/order.server");
  const { runtimeSummary } = await import("@/lib/providers/registry.server");
  const [availability, runtime] = await Promise.all([getInventoryAvailability(), runtimeSummary()]);
  const stock = new Map(availability.map((a) => [a.denomination, a.available]));

  const buttons = DENOMINATIONS.filter((d) => (stock.get(d) ?? 0) > 0).map((d) => ({
    text: `${d} USDT (${stock.get(d) ?? 0} in stock)`,
    callback_data: `buy:denom:${d}`,
  }));

  if (buttons.length === 0) {
    await reply(ctx, "No vouchers in stock right now. Try again later.");
    return;
  }

  await ctx.tg.sendMessage(
    ctx.chatId,
    `<b>${runtime.label}</b>\n${runtime.banner}\n\nPick a denomination:`,
    { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } },
  );
}

export async function handleBuyDenom(ctx: Ctx, denomination: number): Promise<void> {
  const { createOrder } = await import("@/lib/services/order.server");
  const idempotencyKey = `tg-${ctx.chatId}-${Date.now()}`;
  const result = await createOrder({ denomination, idempotencyKey });
  if (!result.ok) {
    await reply(ctx, `Could not create order: ${result.error}`);
    return;
  }

  ctx.session.activeOrder = { publicOrderId: result.publicOrderId, paymentId: result.paymentId };

  const simulated = result.mode === "DEMO";
  const buttons = simulated
    ? [[{ text: "✅ I've paid (simulate)", callback_data: "buy:pay" }]]
    : [];
  buttons.push([{ text: "🔄 Check status", callback_data: "buy:check" }]);

  await ctx.tg.sendMessage(
    ctx.chatId,
    [
      `Order <b>${result.publicOrderId}</b> created.`,
      `Send ${money(result.requiredAmount)} to:`,
      code(result.deposit.address),
      `Network: ${result.deposit.network} — expires ${shortDate(result.expiresAt)}`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: buttons } },
  );
}

export async function handleBuyPay(ctx: Ctx): Promise<void> {
  const active = ctx.session.activeOrder;
  if (!active) {
    await reply(ctx, "No active order in this chat. Run /buy first.");
    return;
  }
  const { simulateCustomerPayment } = await import("@/lib/services/payment-monitor.server");
  const outcome = await simulateCustomerPayment({ paymentId: active.paymentId });
  if (!outcome.ok) {
    await reply(ctx, `Simulation unavailable: ${outcome.error}`);
    return;
  }
  await reportOrderStatus(ctx, active.publicOrderId);
}

export async function handleBuyCheck(ctx: Ctx): Promise<void> {
  const active = ctx.session.activeOrder;
  if (!active) {
    await reply(ctx, "No active order in this chat. Run /buy first.");
    return;
  }
  const { checkPayment } = await import("@/lib/services/payment-monitor.server");
  await checkPayment(active.paymentId);
  await reportOrderStatus(ctx, active.publicOrderId);
}

export async function reportOrderStatus(ctx: Ctx, publicOrderId: string): Promise<void> {
  const { getOrderByPublicId } = await import("@/lib/services/order.server");
  const order = await getOrderByPublicId(publicOrderId);
  if (!order) {
    await reply(ctx, `Order ${publicOrderId} not found.`);
    return;
  }
  await reply(ctx, orderText(`Order ${code(order.public_order_id)}`, order));
  if (order.delivery_status === "DELIVERED" && order.voucher_public_id) {
    await reply(
      ctx,
      `Voucher delivered — redeem it with /redeem when you're ready. Voucher id: ${code(order.voucher_public_id)}`,
    );
  }
}

export async function handleOrderLookup(ctx: Ctx, publicOrderId: string): Promise<void> {
  await reportOrderStatus(ctx, publicOrderId.toUpperCase());
}
