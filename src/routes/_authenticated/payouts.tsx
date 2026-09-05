import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  listPayoutsFn,
  payoutActionFn,
  runPayoutRecoveryFn,
  setPayoutsEnabledFn,
} from "@/lib/api/ops.functions";
import { money, shortDate, statusTone, tronScanTxUrl, truncateMiddle } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

const FILTERS = [
  "ALL",
  "PENDING",
  "BROADCAST",
  "CONFIRMING",
  "CONFIRMED",
  "FAILED",
  "MANUAL_REVIEW",
] as const;

export const Route = createFileRoute("/_authenticated/payouts")({
  head: () => ({
    meta: [
      { title: "Payouts — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Monitor simulated USDT payouts, retry failures, escalate to manual review and control the emergency payout switch.",
      },
      { property: "og:title", content: "Payouts — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Payout state machine monitoring with retry, recovery and kill switch controls.",
      },
    ],
  }),
  component: PayoutsPage,
});

function PayoutsPage() {
  const { t } = useI18n();
  const list = useServerFn(listPayoutsFn);
  const act = useServerFn(payoutActionFn);
  const toggle = useServerFn(setPayoutsEnabledFn);
  const recover = useServerFn(runPayoutRecoveryFn);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>("ALL");

  const { data, isLoading } = useQuery({
    queryKey: ["payouts", status],
    queryFn: () => list({ data: { status } }),
    refetchInterval: 10000,
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["payouts"] });
  }

  const action = useMutation({
    mutationFn: (input: {
      payoutId: string;
      action: "RETRY" | "MANUAL_REVIEW" | "RELEASE";
      reason?: string;
    }) => act({ data: input }),
    onSuccess: (result) => {
      if (result.ok) toast.success("Done.");
      else toast.error(result.message ?? "Action failed.");
      refresh();
    },
    onError: () => toast.error("Action failed."),
  });

  const killSwitch = useMutation({
    mutationFn: (enabled: boolean) =>
      toggle({ data: { enabled, reason: enabled ? "resumed by admin" : "paused by admin" } }),
    onSuccess: () => {
      toast.success("Payout switch updated.");
      refresh();
    },
  });

  const recovery = useMutation({
    mutationFn: () => recover(),
    onSuccess: (result) => {
      toast.success(
        `Recovery: ${result.claimed} claimed, ${result.confirmed} confirmed, ${result.manualReview} escalated.`,
      );
      refresh();
    },
    onError: () => toast.error("Recovery sweep failed."),
  });

  const stats = data?.stats;
  const enabled = data?.settings?.payoutsEnabled ?? true;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t.admin.payouts.title}</h1>
          <p className="text-sm text-muted-foreground">{t.admin.payouts.subtitle}</p>
        </div>
        <Button variant="outline" disabled={recovery.isPending} onClick={() => recovery.mutate()}>
          {recovery.isPending ? "Recovering…" : "Run recovery sweep"}
        </Button>
      </div>

      <div className="panel flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="text-sm font-medium">Emergency payout switch</p>
          <p className="text-xs text-muted-foreground">
            {enabled
              ? "Payouts enabled. New redemptions will broadcast."
              : `Payouts paused${data?.settings?.pausedReason ? ` — ${data.settings.pausedReason}` : ""}.`}
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={killSwitch.isPending}
          onCheckedChange={(next) => killSwitch.mutate(next)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Payouts" value={String(stats?.total ?? 0)} />
        <Stat label="In flight" value={String(stats?.inFlight ?? 0)} />
        <Stat label="Confirmed" value={String(stats?.confirmed ?? 0)} />
        <Stat label="Failed" value={String(stats?.failed ?? 0)} />
        <Stat label="Manual review" value={String(stats?.manualReview ?? 0)} />
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
              <th className="px-4 py-3">Voucher</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Conf.</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Destination</th>
              <th className="px-4 py-3">Tx</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={10}>
                  Loading payouts…
                </td>
              </tr>
            ) : (data?.payouts.length ?? 0) === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={10}>
                  No payouts yet.
                </td>
              </tr>
            ) : (
              data?.payouts.map((payout) => (
                <tr key={payout.id} className="border-t border-border/60">
                  <td className="mono-tag px-4 py-3">{payout.voucher_public_id ?? "—"}</td>
                  <td className="px-4 py-3">
                    {payout.simulated ? (
                      <span className="mono-tag rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning">
                        Simulated
                      </span>
                    ) : (
                      <span className="mono-tag rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-success">
                        TESTNET real
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {money(payout.amount)} {payout.token}
                  </td>
                  <td className={`px-4 py-3 ${statusTone(payout.status)}`}>
                    {payout.status_label}
                    {payout.failure_reason ? (
                      <span className="block text-xs text-muted-foreground">
                        {payout.failure_reason}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{payout.confirmations}</td>
                  <td className="px-4 py-3">
                    {payout.attempt_count}/{payout.max_attempts}
                  </td>
                  <td className="mono-tag px-4 py-3">
                    {truncateMiddle(payout.destination_address, 6, 6)}
                  </td>
                  <td className="mono-tag px-4 py-3">
                    {payout.tx_hash ? (
                      <a
                        href={tronScanTxUrl(payout.network, payout.tx_hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={
                          payout.simulated
                            ? "Simulated hash — won't be found on-chain"
                            : "View on TronScan"
                        }
                        className="underline decoration-dotted hover:text-foreground"
                      >
                        {truncateMiddle(payout.tx_hash, 6, 6)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{shortDate(payout.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {payout.status === "FAILED" || payout.status === "MANUAL_REVIEW" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={action.isPending}
                          onClick={() =>
                            action.mutate({ payoutId: payout.id, action: "RETRY" })
                          }
                        >
                          Retry
                        </Button>
                      ) : null}
                      {payout.status !== "CONFIRMED" && payout.status !== "MANUAL_REVIEW" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.isPending}
                          onClick={() =>
                            action.mutate({
                              payoutId: payout.id,
                              action: "MANUAL_REVIEW",
                              reason: "flagged from payout console",
                            })
                          }
                        >
                          Review
                        </Button>
                      ) : null}
                      {payout.status === "MANUAL_REVIEW" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.isPending}
                          onClick={() =>
                            action.mutate({
                              payoutId: payout.id,
                              action: "RELEASE",
                              reason: "voucher released by admin",
                            })
                          }
                        >
                          Release voucher
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
