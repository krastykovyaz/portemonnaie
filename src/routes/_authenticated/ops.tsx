import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  getOpsQueuesFn,
  getOpsRuntimeFn,
  getPayoutEconomicsFn,
  resolveReviewFn,
  retryDeliveryFn,
  runOrderReconciliationFn,
  syncTreasuryFn,
} from "@/lib/api/ops.functions";
import { money, shortDate, statusTone, truncateMiddle } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/_authenticated/ops")({
  head: () => ({
    meta: [
      { title: "Operations — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Manual review queue, treasury balances, order reconciliation and delivery retries for the VoucherRail demo.",
      },
      { property: "og:title", content: "Operations — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Reviews, treasury, reconciliation and delivery recovery in one operations console.",
      },
    ],
  }),
  component: OpsPage,
});

function OpsPage() {
  const { t } = useI18n();
  const runtimeFn = useServerFn(getOpsRuntimeFn);
  const queuesFn = useServerFn(getOpsQueuesFn);
  const economicsFn = useServerFn(getPayoutEconomicsFn);
  const resolveFn = useServerFn(resolveReviewFn);
  const reconFn = useServerFn(runOrderReconciliationFn);
  const treasuryFn = useServerFn(syncTreasuryFn);
  const deliveryFn = useServerFn(retryDeliveryFn);
  const queryClient = useQueryClient();

  const runtime = useQuery({ queryKey: ["ops-runtime"], queryFn: () => runtimeFn() });
  const queues = useQuery({
    queryKey: ["ops-queues"],
    queryFn: () => queuesFn({ data: { reviewStatus: "OPEN" } }),
  });
  const economics = useQuery({
    queryKey: ["ops-payout-economics"],
    queryFn: () => economicsFn(),
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["ops-queues"] });
  }

  const resolve = useMutation({
    mutationFn: (input: { reviewId: string; status: "RESOLVED" | "REJECTED" }) =>
      resolveFn({
        data: {
          reviewId: input.reviewId,
          status: input.status,
          resolution: input.status === "RESOLVED" ? "handled by admin" : "rejected by admin",
        },
      }),
    onSuccess: (result) => {
      if (result.ok) toast.success("Review closed.");
      else toast.error(result.message ?? "Failed.");
      refresh();
    },
  });

  const recon = useMutation({
    mutationFn: () => reconFn(),
    onSuccess: (result) => {
      toast.success(`Reconciled ${result.checked} payments · ${result.mismatches} mismatches.`);
      refresh();
    },
    onError: () => toast.error("Reconciliation failed."),
  });

  const treasury = useMutation({
    mutationFn: () => treasuryFn(),
    onSuccess: (result) => {
      toast.success(`Treasury synced ${result.synced}/${result.accounts} accounts.`);
      refresh();
    },
    onError: () => toast.error("Treasury sync failed."),
  });

  const retry = useMutation({
    mutationFn: (orderId: string) => deliveryFn({ data: { orderId } }),
    onSuccess: (result) => {
      if (result.ok) toast.success("Delivery re-issued — the new code is shown to the buyer once.");
      else toast.error(result.error ?? "Retry failed.");
      refresh();
    },
  });

  const mode = runtime.data?.runtime;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{t.admin.ops.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.ops.subtitle}</p>
      </div>

      <div className="panel grid gap-4 p-5 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Mode" value={mode?.label ?? "…"} />
        <Field label="Network" value={mode?.network ?? "…"} />
        <Field label="Gateway" value={mode?.gateway ?? "…"} />
        <Field label="Signer" value={mode?.signer ?? "…"} />
        <Field label="Confirmations" value={String(mode?.requiredConfirmations ?? "—")} />
        <Field label="Real value" value={mode?.realValue ? "YES" : "NO"} />
        <Field
          label="Payout signer"
          value={mode?.payoutSimulated === false ? "REAL — TRON_TESTNET" : "Simulated"}
        />
        {mode?.blockers.length ? (
          <p className="col-span-full text-sm text-warning">
            Blockers: {mode.blockers.join("; ")}
          </p>
        ) : null}
        {mode?.payoutBlockers.length ? (
          <p className="col-span-full text-sm text-warning">
            Payout signer blockers: {mode.payoutBlockers.join("; ")}
          </p>
        ) : null}
      </div>

      <PayoutEconomicsSection data={economics.data} isLoading={economics.isLoading} />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Manual review queue</h2>
        </div>
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Detail</th>
                <th className="px-4 py-3">Opened</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(queues.data?.reviews.length ?? 0) === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                    Nothing open. 
                  </td>
                </tr>
              ) : (
                queues.data?.reviews.map((review) => (
                  <tr key={review.id} className="border-t border-border/60">
                    <td className="mono-tag px-4 py-3">{review.kind}</td>
                    <td className={`px-4 py-3 ${statusTone(review.severity)}`}>
                      {review.severity}
                    </td>
                    <td className="mono-tag px-4 py-3">
                      {review.subject_type}/{truncateMiddle(review.subject_id, 6, 4)}
                    </td>
                    <td className="px-4 py-3">{review.detail}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {shortDate(review.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={resolve.isPending}
                          onClick={() =>
                            resolve.mutate({ reviewId: review.id, status: "RESOLVED" })
                          }
                        >
                          Resolve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={resolve.isPending}
                          onClick={() =>
                            resolve.mutate({ reviewId: review.id, status: "REJECTED" })
                          }
                        >
                          Reject
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Treasury</h2>
          <Button variant="outline" disabled={treasury.isPending} onClick={() => treasury.mutate()}>
            {treasury.isPending ? "Syncing…" : "Sync balances"}
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(queues.data?.treasury ?? []).map((account) => (
            <div key={account.id} className="panel p-4">
              <p className="text-sm font-medium">{account.label}</p>
              <p className="mono-tag text-muted-foreground">
                {account.asset} · {account.network}
              </p>
              <p className="mt-2 text-xl font-semibold">{money(account.balance)}</p>
              <p className="mono-tag text-muted-foreground">
                pending {money(account.pending_balance)} · {account.health}
              </p>
              <p className="mono-tag text-muted-foreground">
                {truncateMiddle(account.address, 8, 6)} · synced {shortDate(account.last_synced_at)}
              </p>
            </div>
          ))}
          {(queues.data?.treasury.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No treasury accounts recorded yet.</p>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Order reconciliation</h2>
          <Button variant="outline" disabled={recon.isPending} onClick={() => recon.mutate()}>
            {recon.isPending ? "Reconciling…" : "Run reconciliation"}
          </Button>
        </div>
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Internal</th>
                <th className="px-4 py-3">Chain</th>
                <th className="px-4 py-3">Detail</th>
                <th className="px-4 py-3">When</th>
              </tr>
            </thead>
            <tbody>
              {(queues.data?.recon.length ?? 0) === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                    No reconciliation runs recorded yet.
                  </td>
                </tr>
              ) : (
                queues.data?.recon.map((record) => (
                  <tr key={record.id} className="border-t border-border/60">
                    <td className={`px-4 py-3 ${statusTone(record.status)}`}>{record.status}</td>
                    <td className="mono-tag px-4 py-3">
                      {truncateMiddle(record.subject_id, 6, 4)}
                    </td>
                    <td className="px-4 py-3">{money(record.internal_amount ?? 0)}</td>
                    <td className="px-4 py-3">{money(record.chain_amount ?? 0)}</td>
                    <td className="px-4 py-3">{record.detail}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {shortDate(record.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Deliveries needing attention</h2>
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Attempts</th>
                <th className="px-4 py-3">Error</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(queues.data?.deliveries.length ?? 0) === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={5}>
                    All deliveries are settled.
                  </td>
                </tr>
              ) : (
                queues.data?.deliveries.map((delivery) => (
                  <tr key={delivery.id} className="border-t border-border/60">
                    <td className="mono-tag px-4 py-3">
                      {truncateMiddle(delivery.order_id, 6, 4)}
                    </td>
                    <td className={`px-4 py-3 ${statusTone(delivery.status)}`}>
                      {delivery.status}
                    </td>
                    <td className="px-4 py-3">{delivery.attempts}</td>
                    <td className="px-4 py-3">{delivery.last_error ?? "—"}</td>
                    <td className="px-4 py-3">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(delivery.order_id)}
                      >
                        Re-issue code
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function usd(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function pct(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

type PayoutEconomics = Awaited<ReturnType<typeof getPayoutEconomicsFn>>;

function PayoutEconomicsSection({
  data,
  isLoading,
}: {
  data: PayoutEconomics | undefined;
  isLoading: boolean;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-medium">Payout economics</h2>
        <p className="text-sm text-muted-foreground">
          Real, receipt-verified network cost from confirmed on-chain payouts only — never
          estimated.
        </p>
      </div>

      {isLoading || !data ? (
        <div className="panel p-5 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          <div className="panel grid gap-4 p-5 sm:grid-cols-3 lg:grid-cols-6">
            <Field
              label="Treasury TRX"
              value={
                data.treasury.simulated
                  ? "Simulated"
                  : (data.treasury.trxBalance?.toFixed(2) ?? "—")
              }
            />
            <Field
              label="Treasury USDT"
              value={
                data.treasury.simulated
                  ? "Simulated"
                  : (data.treasury.usdtBalance?.toFixed(2) ?? "—")
              }
            />
            <Field
              label="Energy available"
              value={
                data.treasury.simulated ? "—" : String(data.treasury.energyAvailable ?? "—")
              }
            />
            <Field
              label="Bandwidth available"
              value={
                data.treasury.simulated ? "—" : String(data.treasury.bandwidthAvailable ?? "—")
              }
            />
            <Field label="Confirmed real payouts" value={String(data.metrics.overall.count)} />
            <Field
              label="Success / fail / review"
              value={`${data.metrics.successCount} / ${data.metrics.failureCount} / ${data.metrics.manualReviewCount}`}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="panel p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Avg network cost / payout
              </p>
              <p className="mt-1 text-xl font-semibold">{usd(data.metrics.overall.avgNetworkCostUsd)}</p>
            </div>
            <div className="panel p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Fresh-recipient avg cost
              </p>
              <p className="mt-1 text-xl font-semibold">{usd(data.metrics.fresh.avgNetworkCostUsd)}</p>
              <p className="mono-tag text-muted-foreground">n={data.metrics.fresh.count}</p>
            </div>
            <div className="panel p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Existing-recipient avg cost
              </p>
              <p className="mt-1 text-xl font-semibold">
                {usd(data.metrics.existing.avgNetworkCostUsd)}
              </p>
              <p className="mono-tag text-muted-foreground">n={data.metrics.existing.count}</p>
            </div>
            <div className="panel p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Total network cost (all time)
              </p>
              <p className="mt-1 text-xl font-semibold">{usd(data.metrics.overall.totalNetworkCostUsd)}</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="panel p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Last 24h</p>
              <p className="mt-1 text-lg font-semibold">{usd(data.metrics.last24h.avgNetworkCostUsd)}</p>
              <p className="mono-tag text-muted-foreground">n={data.metrics.last24h.count}</p>
            </div>
            <div className="panel p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Last 7d</p>
              <p className="mt-1 text-lg font-semibold">{usd(data.metrics.last7d.avgNetworkCostUsd)}</p>
              <p className="mono-tag text-muted-foreground">n={data.metrics.last7d.count}</p>
            </div>
            <div className="panel p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Last 30d</p>
              <p className="mt-1 text-lg font-semibold">{usd(data.metrics.last30d.avgNetworkCostUsd)}</p>
              <p className="mono-tag text-muted-foreground">n={data.metrics.last30d.count}</p>
            </div>
          </div>

          <div className="panel overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Voucher</th>
                  <th className="px-4 py-3">Fee (1%)</th>
                  <th className="px-4 py-3">Avg network cost</th>
                  <th className="px-4 py-3">Margin after cost</th>
                  <th className="px-4 py-3">Cost as % of voucher</th>
                </tr>
              </thead>
              <tbody>
                {data.byDenomination.map((row) => (
                  <tr key={row.denomination} className="border-t border-border/60">
                    <td className="px-4 py-3">${row.denomination}</td>
                    <td className="px-4 py-3">{usd(row.feeUsd)}</td>
                    <td className="px-4 py-3">{usd(row.avgNetworkCostUsd)}</td>
                    <td
                      className={`px-4 py-3 ${row.netMarginUsd !== null && row.netMarginUsd < 0 ? "text-destructive" : ""}`}
                    >
                      {usd(row.netMarginUsd)}
                    </td>
                    <td className="px-4 py-3">{pct(row.costAsPctOfVoucher)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel grid gap-4 p-5 sm:grid-cols-3">
            <Field label="Projected cost / 100 payouts" value={usd(data.projected.per100)} />
            <Field label="Projected cost / 1,000 payouts" value={usd(data.projected.per1000)} />
            <Field label="Projected cost / 10,000 payouts" value={usd(data.projected.per10000)} />
          </div>
          <p className="text-xs text-muted-foreground">
            Resource provider: {data.config.provider} · cost guard{" "}
            {data.config.costGuardEnabled ? "enabled" : "disabled"} · max network cost{" "}
            {usd(data.config.maxNetworkCostUsd)} · min margin {usd(data.config.minPayoutMarginUsd)}
          </p>

          <div className="panel grid gap-4 p-5 sm:grid-cols-3 lg:grid-cols-6">
            <Field
              label="Energy available"
              value={data.treasury.simulated ? "—" : String(data.treasury.energyAvailable ?? "—")}
            />
            <Field label="Rental provider" value={data.rental.provider} />
            <Field
              label="Last rental"
              value={data.rental.lastRental ? shortDate(data.rental.lastRental.createdAt) : "None yet"}
            />
            <Field
              label="Last rental price"
              value={data.rental.lastRental?.priceTrx != null ? `${data.rental.lastRental.priceTrx} TRX` : "—"}
            />
            <Field
              label="Rented energy"
              value={
                data.rental.lastRental?.delegatedEnergy != null
                  ? String(data.rental.lastRental.delegatedEnergy)
                  : "—"
              }
            />
            <Field
              label="Rental expiration"
              value={data.rental.lastRental?.expiresAt ? shortDate(data.rental.lastRental.expiresAt) : "—"}
            />
            <Field
              label="Rental active / failed / expired"
              value={`${data.rental.stats.active} / ${data.rental.stats.failed} / ${data.rental.stats.expired}`}
            />
          </div>
        </>
      )}
    </section>
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
