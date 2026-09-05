/**
 * SQLite schema — ported from the former Postgres/Supabase migrations.
 * No RLS, no enums, no triggers: those become application-level checks in
 * src/lib/db/procedures/* and the guards.server.ts role checks. Money is
 * stored as REAL, same precision the app already treats it at (everything
 * flows through JS `Number`); ids are TEXT uuids; timestamps are ISO-8601
 * TEXT so every existing `new Date(x)` call in the app keeps working.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','agent','customer')),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, role)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  agent_ref TEXT NOT NULL UNIQUE,
  email TEXT,
  commission_rate REAL NOT NULL DEFAULT 0.05,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  telegram_user_id INTEGER UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voucher_batches (
  id TEXT PRIMARY KEY,
  batch_ref TEXT NOT NULL UNIQUE,
  asset TEXT NOT NULL DEFAULT 'USDT',
  network TEXT NOT NULL DEFAULT 'TRON_TESTNET',
  denomination REAL NOT NULL,
  quantity INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'USDT',
  network TEXT NOT NULL DEFAULT 'TRON_TESTNET',
  denomination REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','ASSIGNED','RESERVED','SOLD','REDEEMING','REDEEMED','BLOCKED','EXPIRED','CANCELLED')),
  batch_id TEXT REFERENCES voucher_batches(id) ON DELETE SET NULL,
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  reserved_order_id TEXT,
  reserved_until TEXT,
  sale_price REAL,
  commission_amount REAL NOT NULL DEFAULT 0,
  payout_amount REAL,
  network_cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sold_at TEXT,
  redeemed_at TEXT,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
CREATE INDEX IF NOT EXISTS idx_vouchers_agent ON vouchers(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_batch ON vouchers(batch_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_code_hash ON vouchers(code_hash);
CREATE INDEX IF NOT EXISTS idx_vouchers_denomination ON vouchers(denomination);

CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  destination_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','PROCESSING','COMPLETED','FAILED')),
  error_message TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_redemption ON voucher_redemptions(voucher_id) WHERE status <> 'FAILED';
CREATE INDEX IF NOT EXISTS idx_redemptions_user ON voucher_redemptions(user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  voucher_id TEXT REFERENCES vouchers(id) ON DELETE SET NULL,
  redemption_id TEXT REFERENCES voucher_redemptions(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  asset TEXT NOT NULL DEFAULT 'USDT',
  network TEXT NOT NULL DEFAULT 'TRON_TESTNET',
  destination_address TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','BROADCAST','CONFIRMING','CONFIRMED','FAILED')),
  confirmations INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_voucher ON transactions(voucher_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'USDT',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount REAL NOT NULL CHECK (amount > 0),
  asset TEXT NOT NULL DEFAULT 'USDT',
  voucher_id TEXT REFERENCES vouchers(id) ON DELETE SET NULL,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  memo TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_journal ON ledger_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  public_order_id TEXT NOT NULL UNIQUE,
  customer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  voucher_id TEXT REFERENCES vouchers(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  denomination REAL NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDT',
  payment_asset TEXT NOT NULL DEFAULT 'USDT',
  payment_network TEXT NOT NULL DEFAULT 'TRON_TESTNET',
  payment_address TEXT,
  payment_tx_hash TEXT,
  payment_status TEXT NOT NULL DEFAULT 'WAITING'
    CHECK (payment_status IN ('WAITING','DETECTED','CONFIRMING','CONFIRMED','UNDERPAID','OVERPAID','EXPIRED','FAILED','MANUAL_REVIEW')),
  voucher_status TEXT,
  order_status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (order_status IN ('CREATED','RESERVED','PAYMENT_PENDING','PAYMENT_DETECTED','PAYMENT_CONFIRMED','VOUCHER_DELIVERED','COMPLETED','PAYMENT_EXPIRED','PAYMENT_UNDERPAID','PAYMENT_OVERPAID','PAYMENT_FAILED','FULFILLMENT_FAILED','CANCELLED','MANUAL_REVIEW')),
  required_amount REAL NOT NULL,
  received_amount REAL NOT NULL DEFAULT 0,
  amount_difference REAL NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'DEMO',
  customer_email TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  asset TEXT NOT NULL DEFAULT 'USDT',
  network TEXT NOT NULL DEFAULT 'TRON_TESTNET',
  contract_address TEXT,
  required_amount REAL NOT NULL,
  detected_amount REAL NOT NULL DEFAULT 0,
  amount_difference REAL NOT NULL DEFAULT 0,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING'
    CHECK (status IN ('WAITING','DETECTED','CONFIRMING','CONFIRMED','UNDERPAID','OVERPAID','EXPIRED','FAILED','MANUAL_REVIEW')),
  tx_hash TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  required_confirmations INTEGER NOT NULL DEFAULT 3,
  last_checked_at TEXT,
  failure_reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_address ON payment_requests(address);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  payment_id TEXT REFERENCES payment_requests(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  from_address TEXT,
  to_address TEXT NOT NULL,
  contract_address TEXT,
  asset TEXT NOT NULL DEFAULT 'USDT',
  network TEXT NOT NULL DEFAULT 'TRON_TESTNET',
  amount REAL NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  block_number INTEGER,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_tx_payment ON payment_transactions(payment_id);

CREATE TABLE IF NOT EXISTS voucher_deliveries (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  delivery_method TEXT NOT NULL DEFAULT 'ONSCREEN',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','DELIVERED','FAILED','MANUAL_REVIEW')),
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON voucher_deliveries(status);

CREATE TABLE IF NOT EXISTS manual_reviews (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'WARNING',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','REJECTED')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  payment_id TEXT REFERENCES payment_requests(id) ON DELETE SET NULL,
  voucher_id TEXT REFERENCES vouchers(id) ON DELETE SET NULL,
  payout_id TEXT REFERENCES payouts(id) ON DELETE SET NULL,
  detail TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  resolution TEXT,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON manual_reviews(status);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON manual_reviews(created_at DESC);

CREATE TABLE IF NOT EXISTS treasury_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'USDT',
  network TEXT NOT NULL DEFAULT 'TRON_TESTNET',
  address TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  pending_balance REAL NOT NULL DEFAULT 0,
  health TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (asset, network, address)
);

CREATE TABLE IF NOT EXISTS reconciliation_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  internal_amount REAL,
  chain_amount REAL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recon_run ON reconciliation_records(run_id);
CREATE INDEX IF NOT EXISTS idx_recon_created_at ON reconciliation_records(created_at DESC);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  redemption_id TEXT NOT NULL UNIQUE REFERENCES voucher_redemptions(id) ON DELETE CASCADE,
  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'mock-tron-testnet',
  network TEXT NOT NULL DEFAULT 'TRON_TESTNET',
  token TEXT NOT NULL DEFAULT 'USDT',
  amount REAL NOT NULL,
  fee_rate REAL NOT NULL DEFAULT 0.01,
  destination_address TEXT NOT NULL,
  provider_transaction_id TEXT,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('NOT_STARTED','PENDING','BROADCAST','CONFIRMING','CONFIRMED','FAILED','MANUAL_REVIEW')),
  confirmations INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scenario TEXT NOT NULL DEFAULT 'SUCCESS',
  failure_reason TEXT,
  locked_by TEXT,
  locked_at TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  broadcast_at TEXT,
  confirming_at TEXT,
  confirmed_at TEXT,
  failed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_tx_hash ON payouts(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_payouts_voucher ON payouts(voucher_id);

-- Crash-safe broadcast idempotency for real (non-mock) payout signers: written
-- immediately after a successful on-chain broadcast, BEFORE returning control
-- to the caller, so that if the process dies before payouts.tx_hash is
-- persisted, a retry with the same idempotency key finds this row first and
-- returns the existing tx hash instead of signing/broadcasting a second
-- transfer. Never holds key material -- only the public idempotency key and
-- the resulting public transaction hash.
CREATE TABLE IF NOT EXISTS payout_signer_broadcasts (
  idempotency_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payout_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payouts_enabled INTEGER NOT NULL DEFAULT 1,
  paused_reason TEXT,
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO payout_settings (id, payouts_enabled, created_at, updated_at)
  VALUES (1, 1, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO ledger_accounts (id, code, name, account_type, asset, created_at, updated_at) VALUES
  ('acc-treasury-usdt', 'TREASURY_USDT', 'Treasury USDT', 'ASSET', 'USDT', datetime('now'), datetime('now')),
  ('acc-voucher-liability', 'VOUCHER_LIABILITY', 'Outstanding voucher liability', 'LIABILITY', 'USDT', datetime('now'), datetime('now')),
  ('acc-customer-payout', 'CUSTOMER_PAYOUT', 'Customer payouts', 'EXPENSE', 'USDT', datetime('now'), datetime('now')),
  ('acc-fees', 'FEES', 'Fee revenue', 'REVENUE', 'USDT', datetime('now'), datetime('now')),
  ('acc-customer-payments', 'CUSTOMER_PAYMENTS', 'Customer USDT payments received', 'ASSET', 'USDT', datetime('now'), datetime('now')),
  ('acc-sales-revenue', 'SALES_REVENUE', 'Voucher sales revenue', 'REVENUE', 'USDT', datetime('now'), datetime('now')),
  ('acc-overpayment-liability', 'OVERPAYMENT_LIABILITY', 'Customer overpayments owed', 'LIABILITY', 'USDT', datetime('now'), datetime('now')),
  ('acc-refunds', 'REFUNDS', 'Refunds paid', 'EXPENSE', 'USDT', datetime('now'), datetime('now')),
  ('acc-adjustments', 'ADJUSTMENTS', 'Manual adjustments', 'EQUITY', 'USDT', datetime('now'), datetime('now'));
`;
