import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getLedgerFn } from "@/lib/api/admin.functions";
import { money, shortDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/_authenticated/ledger")({
  head: () => ({
    meta: [
      { title: "Ledger & reconciliation — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Double-entry ledger accounts, balances and journal entries for simulated voucher sales and redemptions.",
      },
      { property: "og:title", content: "Ledger & reconciliation — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Double-entry accounting view for the VoucherRail testnet demo.",
      },
    ],
  }),
  component: LedgerPage,
});

function LedgerPage() {
  const { t } = useI18n();
  const fn = useServerFn(getLedgerFn);
  const { data, isLoading } = useQuery({ queryKey: ["ledger"], queryFn: () => fn() });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading ledger…</p>;
  if (!data) return null;

  const r = data.reconciliation;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.admin.ledger.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.ledger.subtitle}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel p-4">
          <p className="mono-tag text-muted-foreground">Voucher liability</p>
          <p className="mt-2 text-2xl font-semibold">{money(r.liability)}</p>
        </div>
        <div className="panel p-4">
          <p className="mono-tag text-muted-foreground">Treasury</p>
          <p className="mt-2 text-2xl font-semibold">{money(r.treasury)}</p>
        </div>
        <div className="panel p-4">
          <p className="mono-tag text-muted-foreground">Fees</p>
          <p className="mt-2 text-2xl font-semibold">{money(r.fees)}</p>
        </div>
        <div className="panel p-4">
          <p className="mono-tag text-muted-foreground">Status</p>
          <p
            className={`mt-2 text-2xl font-semibold ${r.balanced ? "text-success" : "text-destructive"}`}
          >
            {r.balanced ? "Balanced" : "Out of balance"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Debits {money(r.totalDebits)} · Credits {money(r.totalCredits)}
          </p>
        </div>
      </div>

      <div className="panel overflow-x-auto">
        <h2 className="p-4 text-sm font-semibold">Chart of accounts</h2>
        <table className="w-full text-sm">
          <thead className="border-y border-border text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Code</th>
              <th className="p-3 font-medium">Account</th>
              <th className="p-3 font-medium">Type</th>
              <th className="p-3 font-medium">Debits</th>
              <th className="p-3 font-medium">Credits</th>
              <th className="p-3 font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {r.balances.map((account) => (
              <tr key={account.code} className="border-b border-border/50 last:border-0">
                <td className="p-3 font-mono text-xs">{account.code}</td>
                <td className="p-3">{account.name}</td>
                <td className="p-3 text-muted-foreground">{account.account_type}</td>
                <td className="p-3">{money(account.debits)}</td>
                <td className="p-3">{money(account.credits)}</td>
                <td className="p-3">{money(account.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel overflow-x-auto">
        <h2 className="p-4 text-sm font-semibold">Recent journal entries</h2>
        <table className="w-full text-sm">
          <thead className="border-y border-border text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Date</th>
              <th className="p-3 font-medium">Account</th>
              <th className="p-3 font-medium">Direction</th>
              <th className="p-3 font-medium">Amount</th>
              <th className="p-3 font-medium">Memo</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => (
              <tr key={entry.id} className="border-b border-border/50 last:border-0">
                <td className="p-3 text-muted-foreground">{shortDate(entry.created_at)}</td>
                <td className="p-3 font-mono text-xs">{entry.account_code}</td>
                <td className="p-3">
                  <span
                    className={`mono-tag ${entry.direction === "DEBIT" ? "text-info" : "text-warning"}`}
                  >
                    {entry.direction}
                  </span>
                </td>
                <td className="p-3">{money(Number(entry.amount))}</td>
                <td className="p-3 text-muted-foreground">{entry.memo ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
