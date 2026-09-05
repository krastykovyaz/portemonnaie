import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { previewVoucherFn, redeemVoucherFn } from "@/lib/api/redeem.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useI18n } from "@/lib/i18n/context";
import { tronScanTxUrl } from "@/lib/format";

type Voucher = {
  public_id: string;
  asset: string;
  network: string;
  denomination: number;
  expires_at: string | null;
};

type RedeemResult = {
  tx_hash?: string | null;
  amount?: number;
  [key: string]: unknown;
};

export const Route = createFileRoute("/redeem/$publicId")({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search["code"] === "string" ? search["code"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Redeem your voucher — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Enter your voucher secret code and wallet address to receive a simulated USDT testnet payout.",
      },
      { property: "og:title", content: "Redeem your voucher — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Simulated USDT payout for a demo prepaid crypto voucher.",
      },
    ],
  }),
  component: RedeemPage,
});

function RedeemPage() {
  const { publicId } = Route.useParams();
  const { t } = useI18n();
  const search = Route.useSearch();
  const preview = useServerFn(previewVoucherFn);
  const redeem = useServerFn(redeemVoucherFn);

  const [code, setCode] = useState(search.code ?? "");
  const [destination, setDestination] = useState("");
  const [voucher, setVoucher] = useState<Voucher | null>(null);
  const [result, setResult] = useState<RedeemResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function checkVoucher(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await preview({ data: { publicId, code: code.trim() } });
    setBusy(false);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    setVoucher(response.voucher);
  }

  async function submitRedemption(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await redeem({
      data: { publicId, code: code.trim(), destination: destination.trim() },
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    setResult(response.result as RedeemResult);
  }

  return (
    <main className="grid-backdrop flex min-h-screen items-start justify-center px-6 py-12">
      <div className="panel w-full max-w-lg space-y-6 p-6">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <p className="mono-tag rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning inline-block">
              {t.redeem.demoBadge}
            </p>
            <h1 className="text-2xl font-semibold">{t.redeem.title}</h1>
            <p className="mono-tag text-muted-foreground">{publicId}</p>
          </div>
          <LanguageSwitcher />
        </div>

        {result ? (
          (() => {
            const simulated = result["simulated"] !== false; // default true if ever absent
            const txHash = result["tx_hash"] ? String(result["tx_hash"]) : null;
            const network = result["network"] ? String(result["network"]) : "TRON_TESTNET";
            return (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold text-success">
                  {simulated ? t.redeem.payoutSimulated : "Payout confirmed — real transfer"}
                </h2>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t.redeem.amountLabel}</dt>
                    <dd className="mono-tag">
                      {String(result["amount"] ?? voucher?.denomination)} USDT
                    </dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">
                      {simulated ? t.redeem.simulatedTxHash : "Transaction hash"}
                    </dt>
                    <dd className="mono-tag break-all">
                      {txHash ? (
                        !simulated ? (
                          <a
                            href={tronScanTxUrl(network, txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline decoration-dotted hover:text-foreground"
                          >
                            {txHash}
                          </a>
                        ) : (
                          txHash
                        )
                      ) : (
                        "pending"
                      )}
                    </dd>
                  </div>
                </dl>
                <p className="text-sm text-muted-foreground">
                  {simulated
                    ? t.redeem.simulatedNote
                    : "This is a real TRC20 USDT transfer on TRON Nile testnet — no real-world value, but a genuine on-chain transaction."}
                </p>
              </div>
            );
          })()
        ) : voucher ? (
          <form className="space-y-4" onSubmit={submitRedemption}>
            <div className="rounded-lg border border-border bg-secondary/40 p-4">
              <p className="text-3xl font-semibold">{voucher.denomination} USDT</p>
              <p className="mono-tag text-muted-foreground">{voucher.network}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="destination">{t.redeem.walletLabel}</Label>
              <Input
                id="destination"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="T..."
                className="font-mono"
                autoComplete="off"
                required
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? t.redeem.submitting : t.redeem.redeemBtn}
            </Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={checkVoucher}>
            <div className="space-y-2">
              <Label htmlFor="code">{t.redeem.secretCodeLabel}</Label>
              <Input
                id="code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="font-mono uppercase"
                autoComplete="off"
                required
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? t.redeem.checking : t.redeem.checkVoucher}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
