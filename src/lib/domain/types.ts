/**
 * Shared domain types for the voucher platform.
 * DEMO / TESTNET ONLY — no real value moves anywhere in this system.
 */

export const ASSET = "USDT" as const;
export const NETWORK = "TRON_TESTNET" as const;
export const DENOMINATIONS = [10, 25, 50, 100, 250] as const;
export const FEE_RATE = 0.01;

export type VoucherStatus =
  | "CREATED"
  | "ASSIGNED"
  | "SOLD"
  | "REDEEMING"
  | "REDEEMED"
  | "BLOCKED"
  | "EXPIRED"
  | "CANCELLED";

export type TxStatus = "PENDING" | "BROADCAST" | "CONFIRMING" | "CONFIRMED" | "FAILED";

export type AppRole = "admin" | "agent" | "customer";

export type VoucherRow = {
  id: string;
  public_id: string;
  asset: string;
  network: string;
  denomination: number;
  status: VoucherStatus;
  batch_id: string | null;
  assigned_agent_id: string | null;
  created_at: string;
  sold_at: string | null;
  redeemed_at: string | null;
  expires_at: string;
};

export type VoucherWithAgent = VoucherRow & { agent_name: string | null };

export type BatchRow = {
  id: string;
  batch_ref: string;
  asset: string;
  network: string;
  denomination: number;
  quantity: number;
  expires_at: string;
  created_at: string;
};

export type AgentRow = {
  id: string;
  user_id: string | null;
  name: string;
  agent_ref: string;
  email: string | null;
  commission_rate: number;
  status: string;
  created_at: string;
};

export type TransactionRow = {
  id: string;
  voucher_id: string | null;
  amount: number;
  asset: string;
  network: string;
  destination_address: string;
  tx_hash: string | null;
  status: TxStatus;
  confirmations: number;
  created_at: string;
  confirmed_at: string | null;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type AuditRow = {
  id: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  metadata: Record<string, JsonValue>;
  created_at: string;
};

export type LedgerBalance = {
  code: string;
  name: string;
  account_type: string;
  debits: number;
  credits: number;
  balance: number;
};

export type LedgerEntryRow = {
  id: string;
  journal_id: string;
  direction: "DEBIT" | "CREDIT";
  amount: number;
  asset: string;
  memo: string | null;
  created_at: string;
  account_code: string;
};

export type RedemptionResult = {
  public_id: string;
  amount: number;
  asset: string;
  network: string;
  destination: string;
  tx_hash: string;
  confirmations: number;
  confirmed_at: string;
  fee: number;
  /** False only for a real (non-mock) payout signer — see registry.server.ts. */
  simulated: boolean;
};

export const VOUCHER_STATUS_LABELS: Record<VoucherStatus, string> = {
  CREATED: "Created",
  ASSIGNED: "Assigned",
  SOLD: "Sold",
  REDEEMING: "Redeeming",
  REDEEMED: "Redeemed",
  BLOCKED: "Blocked",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

export const NETWORK_LABEL = "TRON TESTNET (simulated)";

export type TransactionWithVoucher = TransactionRow & { voucher_public_id: string | null };
