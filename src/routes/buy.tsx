import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createOrderFn, getStorefrontFn } from "@/lib/api/order.functions";
import { money } from "@/lib/format";

export const Route = createFileRoute("/buy")({
  head: () => ({
    meta: [
      { title: "Buy a USDT voucher — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Order a prepaid USDT voucher in the VoucherRail testnet demo: pick a denomination, reserve inventory and pay with simulated USDT.",
      },
      { property: "og:title", content: "Buy a USDT voucher — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Reserve and pay for a simulated USDT voucher. Testnet demo, no real value.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BuyPage,
});

const IDEMPOTENCY_STORAGE_KEY = "voucherrail_buy_idempotency_key";

function newIdempotencyKey(): string {
  return `ord_${crypto.randomUUID().replaceAll("-", "")}`;
}

// Persisted in sessionStorage, not component state: the whole point of this
// key is that leaving and coming back to /buy (e.g. the browser back button)
// must resume the same reservation, not silently create a new one that
// leaves the old one stuck holding inventory until it expires.
function loadIdempotencyKey(): string {
  try {
    const stored = window.sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // sessionStorage unavailable — fall back to a key that only survives this mount
  }
  const fresh = newIdempotencyKey();
  try {
    window.sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, fresh);
  } catch {
    // ignore write failures
  }
  return fresh;
}

function resetIdempotencyKey(): string {
  const fresh = newIdempotencyKey();
  try {
    window.sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, fresh);
  } catch {
    // ignore write failures
  }
  return fresh;
}

function BuyPage() {
  const storefront = useServerFn(getStorefrontFn);
  const create = useServerFn(createOrderFn);
  const navigate = useNavigate();
  const [denomination, setDenomination] = useState<number | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(loadIdempotencyKey);

  const { data, isLoading } = useQuery({
    queryKey: ["storefront"],
    queryFn: () => storefront(),
  });

  const mutation = useMutation({
    mutationFn: (input: { denomination: number }) =>
      create({
        data: {
          denomination: input.denomination,
          idempotencyKey,
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(
          result.error === "OUT_OF_STOCK"
            ? "That denomination just sold out — pick another."
            : `Order failed: ${result.error}`,
        );
        setIdempotencyKey(resetIdempotencyKey());
        return;
      }
      // This reservation is now handed off to the order page; a future visit
      // to /buy should start a fresh one rather than replay this key.
      resetIdempotencyKey();
      navigate({ to: "/order/$publicOrderId", params: { publicOrderId: result.publicOrderId } });
    },
    onError: () => toast.error("Could not create the order. Try again."),
  });

  return (
    <main className="grid-backdrop min-h-screen px-6 py-16">
      <div className="mx-auto max-w-3xl space-y-8">
        <div className="space-y-3">
          <span className="mono-tag rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning">
            {data?.label ?? "DEMO / TESTNET"}
          </span>
          <h1 className="text-3xl font-semibold">Buy a prepaid USDT voucher</h1>
          <p className="text-muted-foreground">
            {data?.banner ?? "Simulated environment — no blockchain calls and no real value."} An
            order reserves one voucher from inventory for{" "}
            {data?.paymentTtlMinutes ?? 30} minutes.
          </p>
        </div>

        <div className="panel space-y-5 p-6">
          <div className="space-y-3">
            <Label>Denomination</Label>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading inventory…</p>
            ) : (data?.availability.length ?? 0) === 0 ? (
              <p className="text-sm text-destructive">No inventory available right now.</p>
            ) : (
              <div className="flex flex-wrap gap-3">
                {data?.availability.map((item) => (
                  <button
                    key={item.denomination}
                    type="button"
                    onClick={() => setDenomination(item.denomination)}
                    className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                      denomination === item.denomination
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    <span className="block text-lg font-semibold">{money(item.denomination)}</span>
                    <span className="mono-tag text-muted-foreground">
                      {item.available} available · {item.reserved} reserved
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button
            className="w-full"
            disabled={!denomination || mutation.isPending}
            onClick={() => denomination && mutation.mutate({ denomination })}
          >
            {mutation.isPending ? "Reserving voucher…" : "Reserve and continue to payment"}
          </Button>
          <p className="mono-tag text-muted-foreground">
            Idempotency key {idempotencyKey.slice(0, 14)}… — clicking twice returns the same order.
          </p>
        </div>
      </div>
    </main>
  );
}
