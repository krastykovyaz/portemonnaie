import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listTransactionsFn } from "@/lib/api/admin.functions";
import { money, shortDate, statusTone, tronScanTxUrl, truncateMiddle } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/_authenticated/transactions")({
  head: () => ({
    meta: [
      { title: "Simulated transactions — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Every simulated USDT payout with its mock TX hash, confirmations and destination address.",
      },
      { property: "og:title", content: "Simulated transactions — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Mock TRON testnet payout log for the VoucherRail demo.",
      },
    ],
  }),
  component: TransactionsPage,
});

function TransactionsPage() {
  const { t } = useI18n();
  const fn = useServerFn(listTransactionsFn);
  const { data, isLoading } = useQuery({ queryKey: ["transactions"], queryFn: () => fn() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.admin.transactions.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.transactions.subtitle}</p>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Voucher</th>
              <th className="p-3 font-medium">Amount</th>
              <th className="p-3 font-medium">Destination</th>
              <th className="p-3 font-medium">TX hash</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">Conf.</th>
              <th className="p-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  Loading transactions…
                </td>
              </tr>
            ) : (data ?? []).length === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  No simulated payouts yet.
                </td>
              </tr>
            ) : (
              (data ?? []).map((tx) => (
                <tr key={tx.id} className="border-b border-border/50 last:border-0">
                  <td className="p-3 font-mono text-xs">{tx.voucher_public_id ?? "—"}</td>
                  <td className="p-3">{money(Number(tx.amount))}</td>
                  <td className="p-3 font-mono text-xs">
                    {truncateMiddle(tx.destination_address, 10, 6)}
                  </td>
                  <td className="p-3 font-mono text-xs">
                    {tx.tx_hash ? (
                      <span className="inline-flex items-center gap-2">
                        {truncateMiddle(tx.tx_hash, 10, 6)}
                        <a
                          href={tronScanTxUrl(tx.network, tx.tx_hash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View on TronScan (simulated hashes won't be found on-chain)"
                          className="text-muted-foreground underline decoration-dotted hover:text-foreground"
                        >
                          TronScan
                        </a>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="p-3">
                    <span
                      className={`mono-tag rounded-full border px-2 py-0.5 ${statusTone(tx.status)}`}
                    >
                      {tx.status}
                    </span>
                  </td>
                  <td className="p-3">{tx.confirmations}</td>
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
