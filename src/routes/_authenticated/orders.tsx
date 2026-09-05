import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { listOrdersFn, retryDeliveryFn, runPaymentSweepFn } from "@/lib/api/ops.functions";
import { money, shortDate, statusTone, truncateMiddle } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

const FILTERS = [
  "ALL",
  "PAYMENT_PENDING",
  "PAYMENT_DETECTED",
  "COMPLETED",
  "PAYMENT_UNDERPAID",
  "PAYMENT_OVERPAID",
  "PAYMENT_EXPIRED",
  "MANUAL_REVIEW",
] as const;

export const Route = createFileRoute("/_authenticated/orders")({
  head: () => ({
    meta: [
      { title: "Orders — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Admin view of the order lifecycle: reservations, payment detection, confirmations, fulfilment and delivery.",
      },
      { property: "og:title", content: "Orders — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Track every simulated USDT order from reservation to voucher delivery.",
      },
    ],
  }),
  component: OrdersPage,
});

type RevealedCode = { publicOrderId: string; voucherPublicId: string; code: string };

function OrdersPage() {
  const { t } = useI18n();
  const list = useServerFn(listOrdersFn);
  const sweep = useServerFn(runPaymentSweepFn);
  const reissue = useServerFn(retryDeliveryFn);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>("ALL");
  const [revealedCodes, setRevealedCodes] = useState<RevealedCode[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["orders", status],
    queryFn: () => list({ data: { status } }),
  });

  const sweepMutation = useMutation({
    mutationFn: () => sweep(),
    onSuccess: (result) => {
      toast.success(
        `Sweep done — ${result.checked} checked, ${result.confirmed} confirmed, ${result.released} reservations released.`,
      );
      if (result.delivered.length > 0) {
        setRevealedCodes((prev) => [...result.delivered, ...prev]);
        toast.message(`${result.delivered.length} voucher code(s) revealed below — copy them now.`);
      }
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: () => toast.error("Sweep failed."),
  });

  const reissueMutation = useMutation({
    mutationFn: (order: { id: string; public_order_id: string; voucher_public_id: string | null }) =>
      reissue({ data: { orderId: order.id } }).then((result) => ({ order, result })),
    onSuccess: ({ order, result }) => {
      if (!result.ok) {
        toast.error(`Could not reissue: ${result.error}`);
        return;
      }
      setRevealedCodes((prev) => [
        {
          publicOrderId: order.public_order_id,
          voucherPublicId: order.voucher_public_id ?? "—",
          code: result.code,
        },
        ...prev,
      ]);
      toast.success("New code issued — copy it below. The previous code no longer works.");
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: () => toast.error("Reissue failed."),
  });

  const stats = data?.stats;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t.admin.orders.title}</h1>
          <p className="text-sm text-muted-foreground">{t.admin.orders.subtitle}</p>
        </div>
        <Button
          variant="outline"
          disabled={sweepMutation.isPending}
          onClick={() => sweepMutation.mutate()}
        >
          {sweepMutation.isPending ? "Sweeping…" : "Run payment sweep"}
        </Button>
      </div>

      {revealedCodes.length > 0 ? (
        <div className="panel space-y-3 border-success/40 p-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium text-success">
              Voucher codes — shown once, copy now
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setRevealedCodes([])}>
              Dismiss
            </Button>
          </div>
          <ul className="space-y-2">
            {revealedCodes.map((entry) => (
              <li
                key={`${entry.publicOrderId}-${entry.code}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2"
              >
                <span className="mono-tag text-muted-foreground">
                  {entry.publicOrderId} · {entry.voucherPublicId}
                </span>
                <span className="mono-tag break-all text-sm font-semibold">{entry.code}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Orders" value={String(stats?.total ?? 0)} />
        <Stat label="Completed" value={String(stats?.completed ?? 0)} />
        <Stat label="Completed value" value={money(stats?.completedValue ?? 0)} />
        <Stat label="Awaiting payment" value={String(stats?.awaitingPayment ?? 0)} />
        <Stat label="Needs attention" value={String(stats?.needsAttention ?? 0)} />
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            onClick={() => setStatus(filter)}
            className={`mono-tag rounded-full border px-3 py-1 ${
              status === filter ? "border-primary bg-primary/10" : "border-border"
            }`}
          >
            {filter}
          </button>
        ))}
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Payment</th>
              <th className="px-4 py-3">Required</th>
              <th className="px-4 py-3">Received</th>
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Voucher</th>
              <th className="px-4 py-3">Delivery</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={10}>
                  Loading orders…
                </td>
              </tr>
            ) : (data?.orders.length ?? 0) === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={10}>
                  No orders yet. Create one from the public buy page.
                </td>
              </tr>
            ) : (
              data?.orders.map((order) => (
                <tr key={order.id} className="border-t border-border/60">
                  <td className="mono-tag px-4 py-3">{order.public_order_id}</td>
                  <td className={`px-4 py-3 ${statusTone(order.order_status)}`}>
                    {order.order_status_label}
                  </td>
                  <td className="px-4 py-3">
                    {order.payment_status_label} ({order.confirmations}/
                    {order.required_confirmations})
                  </td>
                  <td className="px-4 py-3">{money(order.required_amount)}</td>
                  <td className="px-4 py-3">{money(order.received_amount)}</td>
                  <td className="mono-tag px-4 py-3">
                    {truncateMiddle(order.payment_address, 6, 6)}
                  </td>
                  <td className="mono-tag px-4 py-3">{order.voucher_public_id ?? "—"}</td>
                  <td className="px-4 py-3">{order.delivery_status ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{shortDate(order.created_at)}</td>
                  <td className="px-4 py-3">
                    {order.voucher_public_id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={reissueMutation.isPending}
                        onClick={() => reissueMutation.mutate(order)}
                      >
                        Reissue code
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="panel p-5">
        <h2 className="mb-3 text-sm font-medium">Inventory availability</h2>
        <div className="flex flex-wrap gap-3">
          {(data?.availability ?? []).map((item) => (
            <div key={item.denomination} className="rounded-lg border border-border px-3 py-2">
              <p className="text-sm font-semibold">{money(item.denomination)}</p>
              <p className="mono-tag text-muted-foreground">
                {item.available} free · {item.reserved} reserved
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </div>
  );
}
