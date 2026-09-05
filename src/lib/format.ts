export function money(value: number): string {
  return `${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDT`;
}

export function shortDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncateMiddle(value: string | null, head = 8, tail = 6): string {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

const STATUS_TONE: Record<string, string> = {
  CREATED: "border-border bg-muted/40 text-muted-foreground",
  ASSIGNED: "border-info/40 bg-info/10 text-info",
  SOLD: "border-primary/40 bg-primary/10 text-primary",
  REDEEMING: "border-warning/40 bg-warning/10 text-warning",
  REDEEMED: "border-success/40 bg-success/10 text-success",
  BLOCKED: "border-destructive/40 bg-destructive/10 text-destructive",
  CANCELLED: "border-destructive/40 bg-destructive/10 text-destructive",
  EXPIRED: "border-border bg-muted/40 text-muted-foreground",
  PENDING: "border-border bg-muted/40 text-muted-foreground",
  BROADCAST: "border-info/40 bg-info/10 text-info",
  CONFIRMING: "border-warning/40 bg-warning/10 text-warning",
  CONFIRMED: "border-success/40 bg-success/10 text-success",
  FAILED: "border-destructive/40 bg-destructive/10 text-destructive",
  COMPLETED: "border-success/40 bg-success/10 text-success",
};

export function statusTone(status: string): string {
  return STATUS_TONE[status] ?? "border-border bg-muted/40 text-muted-foreground";
}

/**
 * TronScan explorer link for a tx hash. Points at the right network, but for
 * a simulated hash (anything not actually broadcast) TronScan will just show
 * "not found" — that's expected, not a bug.
 */
export function tronScanTxUrl(network: string, txHash: string): string {
  const base = network === "TRON_MAINNET" ? "https://tronscan.org" : "https://nile.tronscan.org";
  return `${base}/#/transaction/${txHash}`;
}
