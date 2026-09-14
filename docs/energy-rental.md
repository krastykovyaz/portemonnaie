# TRON Energy rental

## Why Energy is needed at all

Every USDT (TRC20) transfer on TRON costs **Energy** (to run the contract's
`transfer()` code) and **Bandwidth** (for the transaction's raw size). An
account gets a small free daily allowance of both; anything beyond that must
be paid for, either by:

- **burning TRX directly** at broadcast time (simplest, but the least
  economical — TRX burned this way is gone, not staked),
- **staking TRX** for Energy (`STAKED`) — capital-efficient long-term, but
  ties up treasury TRX and isn't implemented by this task,
- **renting Energy** from a marketplace for exactly as long as needed
  (`RENTED`) — no capital lockup, pay only for what a given payout actually
  needs.

VoucherRail's payouts were BURN-only until this change. This adds `RENTED` as
a second option: before broadcasting a payout with a real Energy shortfall,
the system can now ask a rental marketplace for a quote, buy just enough
Energy to cover the shortfall, verify the delegation actually landed, and
only then let the payout proceed.

## How rental works, end to end

```
payout request
  -> EnergyManager estimates required Energy/Bandwidth for this recipient
  -> shortfall = required - currently available
  -> shortfall == 0, or ENERGY_PROVIDER != RENTED?
       -> unchanged: the pre-existing BURN/STAKED cost-guard decision, done.
  -> ENERGY_QUOTE_REQUESTED -> provider.getQuote(shortfall)
  -> ENERGY_QUOTE_RECEIVED
  -> guard-check the REAL quoted price against MAX_NETWORK_COST_USD and
     MIN_PAYOUT_MARGIN_USD (the same guard as always, just fed a real number
     instead of a flat estimate)
       -> guard rejects -> do not rent, payout -> MANUAL_REVIEW
  -> create a PENDING row in energy_rentals (idempotency key = the
     redemption's own id, so a retry can never buy a second rental)
  -> ENERGY_RENTAL_REQUESTED -> provider.rentEnergy(...)
       -> throws -> mark FAILED, ENERGY_RENTAL_FAILED, payout does not proceed
  -> poll provider.getRentalStatus(...) up to 3 times until it reports ACTIVE
       -> never confirms -> mark FAILED, ENERGY_RENTAL_FAILED, payout does
          not proceed ("delegation not visible")
  -> ENERGY_RENTAL_CONFIRMED, ENERGY_DELEGATION_VERIFIED
  -> payout may now broadcast, using the newly delegated Energy
```

See [`src/lib/energy/rental/plan-resources.server.ts`](../src/lib/energy/rental/plan-resources.server.ts)
for the exact implementation and
[`src/lib/services/redemption.server.ts`](../src/lib/services/redemption.server.ts)
for where it's called from (`redeemVoucher()`, right where the pre-existing
cost guard already ran).

A provider/network error **at the quote stage** doesn't fail the payout — it
reprices the shortfall as a direct TRX burn (`repriceAsBurn`, the one
resourcing path that never depends on a third party) and falls back to that
guard decision. A failure **after a rental purchase has actually been
attempted** (the purchase itself throws, times out, or its delegation can't
be verified) always fails the payout closed to `MANUAL_REVIEW` — once money
may have moved, the system never guesses.

## Selected provider: Tronex Energy

**[Tronex Energy](https://tronxenergy.com/api)** was selected because it is
the one candidate with a fully public, machine-readable OpenAPI 3.0.3
specification, fetched and inspected directly (not taken from marketing
copy) at `https://api.tronex.energy/api/v1/openapi.json` on 2026-09-07. Every
field name and endpoint in
[`tronex-provider.server.ts`](../src/lib/energy/rental/tronex-provider.server.ts)
is copied from that spec verbatim.

**Confirmed from the spec:**

| Question | Answer |
|---|---|
| Auth | `X-API-KEY` header, required on every request. Optional HMAC add-on (`X-TIMESTAMP`/`X-SIGNATURE`) exists but requires contacting Tronex support to enable — not used here. |
| Base URL | `https://api.tronex.energy` |
| Quote | `POST /api/v1/precountOrder { days, volume }` → `{ duration, volume, price, summa }` (`summa` = total TRX price) |
| Purchase | `POST /api/v1/buyenergy { days, volume, target }` → `{ ..., order_id, status: Filled\|Pending\|Cancelled, txid }` |
| Status | `GET /api/v1/status/{order_id}` → same shape, or `404` if unknown |
| Energy delegated to an arbitrary address? | Yes — `target` is any TRON address, required on both quote-adjacent purchase calls. |
| Volume limits | 65,000 (min) – 2,000,000 (max) energy per order. |
| Durations | `1h`, `1d`, `3d`, `7d`. |
| Idempotency | **Not supported by the API.** No idempotency field exists in any request schema. All de-duplication is ours — see "Idempotency" below. |
| Cancellation / refund | **Not supported.** No such endpoint exists anywhere in the spec. `cancelRental` is intentionally left undefined on the adapter, not stubbed to a fake success. |
| Rate limits | 100 GET/20s, 40 POST-PUT-DELETE/20s, `429` on excess. |
| Nile / testnet | **Not mentioned anywhere in the spec.** See "Why testnet always uses the mock" below for why this isn't a documentation gap so much as a structural fact about how energy-rental marketplaces work. |

## Why testnet always uses the mock

Tronex (like every real TRON energy-rental marketplace) resells Energy
delegated **from its own staked TRON MAINNET accounts**. That Energy only
exists on mainnet. Nile is an independent blockchain with its own separate
resource economy — delegating mainnet Energy to a Nile address has literally
no effect on a Nile transaction. This isn't a testnet limitation Tronex
happens to have; it's true of any real energy marketplace, because Nile's
test resources are already free (faucet-funded), so no such marketplace has
a reason to exist there.

Separately, and just as decisively: VoucherRail's own payout activation gate
(`resolveRuntime` → `resolvePayoutProvider` in
[`src/lib/providers/registry.server.ts`](../src/lib/providers/registry.server.ts))
only ever activates the real signer (`id: "tron-testnet-signer"`) when
`TRON_NETWORK=NILE`. Every other configuration gets either the simulated mock
or `UnavailablePayoutProvider` (a non-simulated but always-throwing stand-in
for a broken config — confirmed in `registry-payout.test.ts`). So the state
"the real signer is genuinely active AND `TRON_NETWORK=MAINNET`" can never
occur at the same time through this app's real `resolveRuntime()`.

[`src/lib/energy/rental/registry.server.ts`](../src/lib/energy/rental/registry.server.ts)'s
`resolveEnergyRentalProvider()` encodes exactly this: it returns
`MockEnergyRentalProvider` unless `TRON_NETWORK=MAINNET` **and** the active
payout provider's id is specifically `"tron-testnet-signer"` — a combination
that is structurally unreachable today. The real `TronexEnergyRentalProvider`
adapter is fully implemented and unit-tested against Tronex's documented API
(so it's ready the day this app might target a network Tronex actually
supports), but it cannot be exercised end-to-end by this app as it exists.

## Idempotency

Tronex's API has no idempotency concept, so all of it is ours:

- Each redemption gets one rental, keyed as `` `rental:${redemptionId}` ``.
- `energy_rentals.idempotency_key` is `UNIQUE` at the database level — a
  retry racing a concurrent attempt can never insert a second row.
- A retry that finds an existing **ACTIVE** rental reuses it outright,
  re-evaluating the cost guard against the already-paid price but never
  calling the provider again.
- A retry that finds an **EXPIRED** rental (see below) renews the same DB row
  in place with a fresh purchase, rather than creating a new one.

## Expiry

Rentals carry an `expires_at` derived from the requested duration. A rental
past its expiry is swept to `EXPIRED` (emitting `ENERGY_RENTAL_EXPIRED`) by
`expireStaleRentals()` in
[`src/lib/db/procedures/energy-rentals.ts`](../src/lib/db/procedures/energy-rentals.ts),
called at the start of every `planPayoutResources()` run so a stale rental
is never mistaken for a still-usable delegation.

## No permanent inventory

There is no bulk-purchase or pre-funded Energy pool. Every rental is
requested pay-as-needed, sized to the specific payout's shortfall (rounded up
only to the provider's own minimum sellable unit — 65,000 energy for
Tronex). Nothing is purchased speculatively.

## Cost guard interaction

The existing cost guard (`MIN_PAYOUT_MARGIN_USD`, `MAX_NETWORK_COST_USD`,
`ENABLE_PAYOUT_COST_GUARD` — unchanged from the prior cost-accounting work)
is never bypassed for a rental: `evaluatePayoutMargin()` is called with the
**real quoted price** before any purchase happens, exactly the same function
and thresholds used for BURN/STAKED. If a quote would push the payout over
budget or below the required margin, the rental is never purchased and the
payout is routed to `MANUAL_REVIEW` — the guard's behavior is identical
whether the number it's checking came from a flat estimate or a live quote.

On confirmation, `payoutConfirm()` folds the rental's `price_usd` into
`payouts.provider_cost` and `payouts.total_network_cost` on top of whatever
TRX was actually burned on-chain (read from the transaction receipt, same as
before). A BURN/STAKED payout with no `energy_rental_id` is completely
unaffected — `provider_cost` still equals the actual on-chain burn cost,
exactly as before this feature existed.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ENERGY_PROVIDER` | `BURN` | `STAKED` \| `RENTED` \| `BURN`. Set `RENTED` to try the rental market before burning. |
| `ENERGY_RENTAL_DURATION` | `1h` | `1h` \| `1d` \| `3d` \| `7d`, passed to the rental provider. |
| `TRX_USD_PRICE` | `0.15` | Illustrative — no live feed. |
| `ENABLE_PAYOUT_COST_GUARD` | `true` | Fail-safe default: guard is on. |
| `MIN_PAYOUT_MARGIN_USD` | `0` | Reject a payout whose fee minus network cost falls below this. |
| `MAX_NETWORK_COST_USD` | `1` | Reject a payout whose estimated network cost exceeds this outright. |
| `TRONEX_API_KEY` | *(unset)* | Real Tronex API key. **Secret — never commit.** Only consulted in the (currently unreachable) real-MAINNET-marketplace branch; fails closed (throws) if that branch is ever reached without it. |
| `TRONEX_API_URL` | `https://api.tronex.energy` | Override for testing against a different Tronex-compatible endpoint. |

## Testnet behavior, summarized

On Nile (this app's only executable chain), `ENERGY_PROVIDER=RENTED` is
fully functional end-to-end — quoting, "purchasing", verifying delegation,
recording cost — but every one of those steps runs against
`MockEnergyRentalProvider`, entirely in-process, with no network calls and no
real TRX. This is intentional and documented, not a stand-in that was
supposed to be replaced: a *correct* real-marketplace integration cannot be
exercised on Nile at all (see above), so the mock isn't a testing
convenience here, it's the only economically meaningful behavior Nile can
have.

## What's required before MAINNET

1. **MAINNET is not enabled by this change and must not be enabled by
   reading this document.** `CHAIN_MODE=MAINNET` and `TRON_NETWORK=MAINNET`
   both remain blocked by the existing payout activation gate.
2. Before any real MAINNET payout: fund a real Tronex account, set
   `TRONEX_API_KEY`, and re-verify (with a small real quote — read-only,
   costs nothing) that pricing and the volume limits still match this
   document, since the spec is Tronex's to change.
3. Re-benchmark real MAINNET resource costs (the mainnet USDT contract has
   `consume_user_resource_percent: 30` and a much smaller
   `origin_energy_limit` than the Nile test contract — see the payout
   cost-accounting work this feature builds on) and retune
   `MAX_NETWORK_COST_USD` / `MIN_PAYOUT_MARGIN_USD` accordingly.
4. Extend `src/lib/providers/registry.server.ts`'s payout activation gate to
   support a real MAINNET signer at all — today it structurally cannot
   activate one, which is also what keeps this rental integration itself
   unreachable outside Nile.
