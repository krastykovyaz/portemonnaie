import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createBatchFn, listBatchesFn } from "@/lib/api/admin.functions";
import { DENOMINATIONS } from "@/lib/domain/types";
import { money, shortDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/_authenticated/batches")({
  head: () => ({
    meta: [
      { title: "Voucher batches — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Generate batches of fixed-denomination testnet vouchers and print their QR codes and secret codes.",
      },
      { property: "og:title", content: "Voucher batches — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Batch generation with printable QR codes for the VoucherRail testnet demo.",
      },
    ],
  }),
  component: BatchesPage,
});

type CreatedCode = { public_id: string; code: string; denomination: number };

function VoucherCard({ code }: { code: CreatedCode }) {
  const [qr, setQr] = useState<string | null>(null);
  const url = `${typeof window === "undefined" ? "" : window.location.origin}/redeem/${code.public_id}?code=${code.code}`;

  useEffect(() => {
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [url]);

  return (
    <div className="rounded-lg border border-border bg-surface p-3 text-center">
      {qr ? (
        <img src={qr} alt={`QR code for voucher ${code.public_id}`} className="mx-auto size-28 rounded bg-white p-1" />
      ) : (
        <div className="mx-auto size-28 animate-pulse rounded bg-muted" />
      )}
      <p className="mt-2 font-mono text-xs">{code.public_id}</p>
      <p className="font-mono text-[11px] text-muted-foreground">{code.code}</p>
      <p className="mono-tag mt-1 text-primary">{money(code.denomination)}</p>
    </div>
  );
}

function BatchesPage() {
  const { t } = useI18n();
  const createFn = useServerFn(createBatchFn);
  const listFn = useServerFn(listBatchesFn);
  const queryClient = useQueryClient();

  const [denomination, setDenomination] = useState("50");
  const [quantity, setQuantity] = useState("10");
  const [expiresAt, setExpiresAt] = useState(
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
  const [codes, setCodes] = useState<CreatedCode[]>([]);

  const batches = useQuery({ queryKey: ["batches"], queryFn: () => listFn() });

  const create = useMutation({
    mutationFn: () =>
      createFn({
        data: {
          denomination: Number(denomination),
          quantity: Number(quantity),
          expiresAt: new Date(`${expiresAt}T23:59:59Z`).toISOString(),
        },
      }),
    onSuccess: (result) => {
      setCodes(result.codes);
      toast.success(`Generated ${result.codes.length} vouchers`);
      queryClient.invalidateQueries({ queryKey: ["batches"] });
      queryClient.invalidateQueries({ queryKey: ["vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function downloadCsv() {
    const csv = ["public_id,code,denomination"]
      .concat(codes.map((c) => `${c.public_id},${c.code},${c.denomination}`))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "voucher-codes.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.admin.batches.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.batches.subtitle}</p>
      </div>

      <form
        className="panel grid gap-4 p-4 md:grid-cols-4 md:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="space-y-2">
          <Label>Denomination</Label>
          <Select value={denomination} onValueChange={setDenomination}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DENOMINATIONS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} USDT
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="quantity">Quantity</Label>
          <Input
            id="quantity"
            type="number"
            min={1}
            max={500}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="expires">Expires</Label>
          <Input
            id="expires"
            type="date"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Generating…" : "Generate batch"}
        </Button>
      </form>

      {codes.length > 0 ? (
        <div className="panel space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Generated vouchers ({codes.length})</h2>
              <p className="text-xs text-muted-foreground">
                Print or export now. These codes cannot be recovered later.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={downloadCsv}>
                Export CSV
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCodes([])}>
                Dismiss
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {codes.map((code) => (
              <VoucherCard key={code.public_id} code={code} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Batch</th>
              <th className="p-3 font-medium">Denomination</th>
              <th className="p-3 font-medium">Issued</th>
              <th className="p-3 font-medium">Sold</th>
              <th className="p-3 font-medium">Redeemed</th>
              <th className="p-3 font-medium">Expires</th>
              <th className="p-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {(batches.data ?? []).map((batch) => (
              <tr key={batch.id} className="border-b border-border/50 last:border-0">
                <td className="p-3 font-mono text-xs">{batch.batch_ref}</td>
                <td className="p-3">{money(Number(batch.denomination))}</td>
                <td className="p-3">{batch.issued}</td>
                <td className="p-3">{batch.sold}</td>
                <td className="p-3">{batch.redeemed}</td>
                <td className="p-3 text-muted-foreground">{shortDate(batch.expires_at)}</td>
                <td className="p-3 text-muted-foreground">{shortDate(batch.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
