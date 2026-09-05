import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VoucherRail — Prepaid Crypto Voucher Demo (Testnet)" },
      {
        name: "description",
        content:
          "VoucherRail is a testnet demo of a prepaid crypto voucher platform: agents sell vouchers, customers redeem them for simulated USDT payouts.",
      },
      { property: "og:title", content: "VoucherRail — Prepaid Crypto Voucher Demo (Testnet)" },
      {
        property: "og:description",
        content:
          "Redeem a demo voucher code for a simulated USDT payout on testnet. No real money, no real custody.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [publicId, setPublicId] = useState("");
  const [code, setCode] = useState("");

  return (
    <main className="grid-backdrop min-h-screen">
      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary font-mono text-sm font-bold text-primary-foreground">
              VR
            </div>
            <span className="text-lg font-semibold">{t.common.appName}</span>
            <span className="mono-tag rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning">
              {t.common.demoTestnet}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild>
              <Link to="/buy">{t.common.buyVoucher}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/auth">{t.common.staffSignIn}</Link>
            </Button>
            <LanguageSwitcher />
          </div>

        </header>

        <section className="grid gap-8 md:grid-cols-[1.1fr_1fr] md:items-center">
          <div className="space-y-4">
            <h1 className="text-4xl font-semibold sm:text-5xl">{t.landing.heroTitle}</h1>
            <p className="text-muted-foreground">{t.landing.heroDesc}</p>
            <p className="mono-tag text-muted-foreground">{t.landing.heroDisclaimer}</p>
          </div>

          <form
            className="panel space-y-4 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              const id = publicId.trim().toUpperCase();
              if (!id) return;
              navigate({
                to: "/redeem/$publicId",
                params: { publicId: id },
                search: { code: code.trim() || undefined },
              });
            }}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{t.landing.redeemTitle}</h2>
              <p className="text-sm text-muted-foreground">{t.landing.redeemDesc}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="publicId">{t.landing.voucherIdLabel}</Label>
              <Input
                id="publicId"
                value={publicId}
                onChange={(event) => setPublicId(event.target.value)}
                placeholder="VCH-XXXXXX"
                className="font-mono uppercase"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="code">{t.landing.codeLabel}</Label>
              <Input
                id="code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="XXXX-XXXX-XXXX"
                className="font-mono uppercase"
                autoComplete="off"
              />
            </div>
            <Button type="submit" className="w-full">
              {t.common.continue}
            </Button>
          </form>
        </section>
      </div>
    </main>
  );
}
