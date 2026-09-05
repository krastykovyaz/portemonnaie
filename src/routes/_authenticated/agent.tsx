import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getAgentWorkspaceFn, markVoucherSoldFn } from "@/lib/api/agent.functions";
import { money, shortDate, statusTone, truncateMiddle } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/agent")({
  head: () => ({
    meta: [
      { title: "Agent workspace — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Agent inventory of assigned testnet vouchers, mark-as-sold flow and redemption history.",
      },
      { property: "og:title", content: "Agent workspace — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Sell and track assigned vouchers in the VoucherRail testnet demo.",
      },
    ],
  }),
  component: AgentWorkspace,
});

function AgentWorkspace() {
  const fn = useServerFn(getAgentWorkspaceFn);
  const sellFn = useServerFn(markVoucherSoldFn);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["agent-workspace"], queryFn: () => fn() });

  const sell = useMutation({
    mutationFn: (voucherId: string) => sellFn({ data: { voucherId } }),
    onSuccess: (result) => {
      toast.success(`${result.public_id} marked as sold`);
      queryClient.invalidateQueries({ queryKey: ["agent-workspace"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading workspace…</p>;
  if (!data) return null;

  if (!data.agent) {
    return (
      <div className="panel p-6">
        <h1 className="text-xl font-semibold">No agent profile linked</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your login has the agent role but is not linked to an agent record yet. Open Account and
          use the demo tools to link one of the seeded agents.
        </p>
      </div>
    );
  }

  const stats = data.stats!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{data.agent.name}</h1>
        <p className="text-sm text-muted-foreground">
          Agent {data.agent.agent_ref} · commission{" "}
          {(Number(data.agent.commission_rate) * 100).toFixed(2)}%
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: "Inventory", value: String(stats.inventory) },
          { label: "Available", value: String(stats.available) },
          { label: "Sold", value: String(stats.sold) },
          { label: "Redeemed", value: String(stats.redeemed) },
          { label: "Commission", value: money(stats.commission) },
        ].map((item) => (
          <div key={item.label} className="panel p-4">
            <p className="mono-tag text-muted-foreground">{item.label}</p>
            <p className="mt-2 text-2xl font-semibold">{item.value}</p>
          </div>
        ))}
      </div>

      <div className="panel overflow-x-auto">
        <h2 className="p-4 text-sm font-semibold">My vouchers</h2>
        <table className="w-full text-sm">
          <thead className="border-y border-border text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Voucher</th>
              <th className="p-3 font-medium">Value</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">Expires</th>
              <th className="p-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {data.vouchers.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-muted-foreground">
                  No vouchers assigned yet.
                </td>
              </tr>
            ) : (
              data.vouchers.map((voucher) => (
                <tr key={voucher.id} className="border-b border-border/50 last:border-0">
                  <td className="p-3 font-mono text-xs">{voucher.public_id}</td>
                  <td className="p-3">{money(Number(voucher.denomination))}</td>
                  <td className="p-3">
                    <span
                      className={`mono-tag rounded-full border px-2 py-0.5 ${statusTone(voucher.status)}`}
                    >
                      {voucher.status}
                    </span>
                  </td>
                  <td className="p-3 text-muted-foreground">{shortDate(voucher.expires_at)}</td>
                  <td className="p-3">
                    {voucher.status === "ASSIGNED" ? (
                      <Button
                        size="sm"
                        disabled={sell.isPending}
                        onClick={() => sell.mutate(voucher.id)}
                      >
                        Mark sold
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="panel overflow-x-auto">
        <h2 className="p-4 text-sm font-semibold">Redemptions on my vouchers</h2>
        <table className="w-full text-sm">
          <thead className="border-y border-border text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Voucher</th>
              <th className="p-3 font-medium">Amount</th>
              <th className="p-3 font-medium">TX hash</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {data.transactions.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-muted-foreground">
                  No redemptions yet.
                </td>
              </tr>
            ) : (
              data.transactions.map((tx) => (
                <tr key={tx.id} className="border-b border-border/50 last:border-0">
                  <td className="p-3 font-mono text-xs">{tx.voucher_public_id ?? "—"}</td>
                  <td className="p-3">{money(Number(tx.amount))}</td>
                  <td className="p-3 font-mono text-xs">
                    {tx.tx_hash ? truncateMiddle(tx.tx_hash, 10, 6) : "—"}
                  </td>
                  <td className="p-3">
                    <span
                      className={`mono-tag rounded-full border px-2 py-0.5 ${statusTone(tx.status)}`}
                    >
                      {tx.status}
                    </span>
                  </td>
                  <td className="p-3 text-muted-foreground">{shortDate(tx.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
