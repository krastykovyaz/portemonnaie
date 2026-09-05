# VoucherRail

A prepaid crypto voucher platform demo: agents sell fixed-denomination vouchers, customers redeem them for a USDT payout on TRON. Built with TanStack Start, SQLite (via `sql.js`), and a real TRON Nile testnet integration for both payment detection and payout signing.

**This is a demo/testnet project.** No real money is ever moved unless you deliberately configure MAINNET, which the code refuses to do without an explicit acknowledgement and a real custody key — see [Chain modes](#chain-modes) below.

## Features

- Two independent sale flows: online purchase (reserve → pay with USDT → auto-fulfil) and agent-sold vouchers (batch-generate → assign → sell → redeem).
- Double-entry ledger and an append-only audit log for every state transition.
- Real TRON Nile testnet integration: payment detection via TronGrid, and an optional real TRC20 payout signer (opt-in, fails closed if misconfigured — see `.env.example`).
- Admin console: orders, vouchers, batches, agents, payouts, transactions, operations, ledger, audit log.
- A Telegram bot (`bot/`) mirroring the customer/agent/admin flows, run as a separate process.
- English / Russian / French UI.

## Stack

TanStack Start (React 19, TanStack Router/Query) · Vite · SQLite (`sql.js`, no native bindings) · Tailwind · Radix UI · `tronweb` for TRON interaction.

## Development

This project uses [Bun](https://bun.sh).

```sh
git clone https://github.com/krastykovyaz/portemonnaie.git
cd portemonnaie
bun install
cp .env.example .env   # fill in SESSION_SECRET at minimum
bun run dev
```

Run the test suite with `bun run test` (this runs via `vitest`, not `bun test` directly — `bun test`'s runtime doesn't load `tronweb`'s generated modules correctly).

## Configuration

See `.env.example` for the full list. At minimum you need `SESSION_SECRET` (a random 32+ character string). Everything else defaults to DEMO mode: fully simulated, no network calls, no keys.

### Chain modes

- **DEMO** (default) — everything simulated.
- **TESTNET** — real payment detection against TRON Nile via TronGrid. Payouts stay simulated unless you also set `PAYOUT_SIGNER=TRON_TESTNET` with a valid `CUSTODY_KEY_REF` (a **testnet-only** private key) — see the comments in `.env.example` for the full validation checklist. Misconfiguration fails closed; it never silently falls back to a simulated payout.
- **MAINNET** — deliberately blocked without `CUSTODY_KEY_REF` and `MAINNET_ACKNOWLEDGED=true`. There is currently no real MAINNET signer implemented.

### Telegram bot

Run separately from the web app:

```sh
bun run bot
```

Requires `TELEGRAM_BOT_TOKEN` in `.env`.
