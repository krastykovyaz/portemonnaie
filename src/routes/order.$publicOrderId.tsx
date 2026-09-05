import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getOrderStatusFn, simulatePaymentFn } from "@/lib/api/order.functions";
import { money, shortDate, statusTone, truncateMiddle } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/order/$publicOrderId")({
  head: () => ({
    meta: [
      { title: "Order status — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Track a VoucherRail demo order: payment detection, confirmations and voucher delivery for a simulated USDT purchase.",
      },
      { property: "og:title", content: "Order status — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Live payment and delivery status for a simulated USDT voucher order.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: OrderPage,
  errorComponent: () => {
    const { t } = useI18n();
    return (
      <main className="grid-backdrop flex min-h-screen items-center justify-center p-8">
        <p className="text-muted-foreground">{t.orderStatus.couldNotLoad}</p>
      </main>
    );
  },
  notFoundComponent: () => {
    const { t } = useI18n();
    return (
      <main className="grid-backdrop flex min-h-screen items-center justify-center p-8">
        <p className="text-muted-foreground">{t.orderStatus.orderNotFound}</p>
      </main>
    );
  },
});

const OPEN_STATUSES = [
  "CREATED",
  "RESERVED",
  "PAYMENT_PENDING",
  "PAYMENT_DETECTED",
  "PAYMENT_CONFIRMED",
];

function OrderPage() {
  const { publicOrderId } = Route.useParams();
  const { t } = useI18n();
  const statusFn = useServerFn(getOrderStatusFn);
  const simulate = useServerFn(simulatePaymentFn);
  const [code, setCode] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["order", publicOrderId],
    queryFn: () => statusFn({ data: { publicOrderId } }),
    refetchInterval: (query) => {
      const result = query.state.data;
      if (result?.ok && OPEN_STATUSES.includes(result.order.order_status)) return 5000;
      return false;
    },
  });

  const pay = useMutation({
    mutationFn: (input: { amount?: number }) =>
      simulate({ data: { publicOrderId, ...(input.amount ? { amount: input.amount } : {}) } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(`Simulation unavailable: ${result.error}`);
        return;
      }
      if (result.code) setCode(result.code);
      await refetch();
    },
  });

  useEffect(() => {
    if (code) {
      const voucherId = data?.ok ? data.order.voucher_public_id : null;
      toast.success(t.orderStatus.voucherDelivered(voucherId ?? code));
    }
  }, [code]);

  if (isLoading) {
    return (
      <main className="grid-backdrop flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">{t.orderStatus.loadingOrder}</p>
      </main>
    );
  }

  if (!data?.ok) {
    return (
      <main className="grid-backdrop flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">{t.orderStatus.notFoundWithId(publicOrderId)}</p>
      </main>
    );
  }

  const order = data.order;
  const underpaid = order.order_status === "PAYMENT_UNDERPAID";
  const overpaid = order.order_status === "PAYMENT_OVERPAID";

  return (
    <main className="grid-backdrop min-h-screen px-6 py-16">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-2">
          <span className="mono-tag rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning">
            {order.mode} / SIMULATED
          </span>
          <h1 className="text-3xl font-semibold">Order {order.public_order_id}</h1>
          <p className={`text-sm ${statusTone(order.order_status)}`}>
            {order.order_status_label} · payment {order.payment_status_label}
          </p>
        </div>

        <div className="panel grid gap-4 p-6 sm:grid-cols-2">
          <Field label={t.orderStatus.amountDue} value={money(order.required_amount)} />
          <Field label={t.orderStatus.received} value={money(order.received_amount)} />
          <Field label={t.orderStatus.network} value={order.payment_network} />
          <Field
            label={t.orderStatus.confirmations}
            value={`${order.confirmations} / ${order.required_confirmations}`}
          />
          <Field label={t.orderStatus.payTo} value={truncateMiddle(order.payment_address, 10, 8)} />
          <Field label={t.orderStatus.reservationExpires} value={shortDate(order.expires_at)} />
        </div>

        {underpaid || overpaid ? (
          <div className="panel border-warning/40 p-6">
            <p className="text-sm text-warning">
              {underpaid
                ? `Underpaid by ${money(Math.abs(order.amount_difference))} ${order.payment_asset}. Send the difference or contact support — the order is held for manual review.`
                : `Overpaid by ${money(order.amount_difference)} ${order.payment_asset}. The voucher is issued and the surplus is queued for refund review.`}
            </p>
          </div>
        ) : null}

        {code ? (
          <div className="panel space-y-2 border-success/40 p-6">
            <p className="text-sm font-medium text-success">
              {t.orderStatus.voucherDelivered(order.voucher_public_id ?? code)}
            </p>
            <p className="mono-tag break-all text-lg">{code}</p>
            <p className="text-xs text-muted-foreground">{t.orderStatus.shownOnce}</p>
            <Button asChild variant="outline" size="sm">
              <a href={`/redeem/${order.voucher_public_id}`}>{t.orderStatus.openRedemption}</a>
            </Button>
          </div>
        ) : null}

        {OPEN_STATUSES.includes(order.order_status) && !code ? (
          <div className="panel space-y-3 p-6">
            <p className="text-sm text-muted-foreground">{t.orderStatus.demoToolsDesc}</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={pay.isPending} onClick={() => pay.mutate({})}>
                {t.orderStatus.payExact}
              </Button>
              <Button
                variant="outline"
                disabled={pay.isPending}
                onClick={() => pay.mutate({ amount: order.required_amount / 2 })}
              >
                {t.orderStatus.underpay}
              </Button>
              <Button
                variant="outline"
                disabled={pay.isPending}
                onClick={() => pay.mutate({ amount: order.required_amount * 1.1 })}
              >
                {t.orderStatus.overpay}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mono-tag text-sm">{value}</p>
    </div>
  );
}
