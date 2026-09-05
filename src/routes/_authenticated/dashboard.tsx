import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getAdminOverviewFn } from "@/lib/api/admin.functions";
import { money, statusTone } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Admin overview — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Testnet voucher KPIs: issued, sold and redeemed vouchers, outstanding liability and ledger reconciliation.",
      },
      { property: "og:title", content: "Admin overview — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Voucher KPIs, liability trend and ledger reconciliation for the testnet demo.",
      },
    ],
  }),
  component: AdminDashboard,
});

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel p-4">
      <p className="mono-tag text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function AdminDashboard() {
  const { t } = useI18n();
  const fn = useServerFn(getAdminOverviewFn);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => fn(),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading overview…</p>;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  if (!data) return null;

  const k = data.kpis;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{t.admin.dashboard.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.dashboard.subtitle}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Vouchers issued" value={String(k.totalVouchers)} hint={money(k.totalValue)} />
        <Kpi label="Active" value={String(k.activeVouchers)} hint="Created, assigned or sold" />
        <Kpi label="Sold (unredeemed)" value={String(k.soldVouchers)} />
        <Kpi
          label="Redeemed"
          value={String(k.redeemedVouchers)}
          hint={money(k.redeemedValue)}
        />
        <Kpi label="Outstanding liability" value={money(k.outstandingLiability)} />
        <Kpi label="Treasury balance" value={money(k.treasury)} />
        <Kpi label="Fees collected" value={money(k.fees)} hint="1% simulated redemption fee" />
        <Kpi
          label="Ledger"
          value={data.balanced ? "Balanced" : "Out of balance"}
          hint="Double-entry debits vs credits"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="text-sm font-semibold">Voucher activity (30 days)</h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.series}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <Tooltip
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="issued" fill="var(--chart-2)" stackId="a" />
                <Bar dataKey="sold" fill="var(--chart-1)" stackId="a" />
                <Bar dataKey="redeemed" fill="var(--chart-5)" stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel p-4">
          <h2 className="text-sm font-semibold">Outstanding liability trend</h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.liabilitySeries}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                <Tooltip
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="liability"
                  stroke="var(--chart-1)"
                  fill="var(--chart-1)"
                  fillOpacity={0.2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="text-sm font-semibold">Status breakdown</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {data.statusBreakdown.map((row) => (
            <span
              key={row.status}
              className={`mono-tag rounded-full border px-3 py-1 ${statusTone(row.status)}`}
            >
              {row.status} · {row.count}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
