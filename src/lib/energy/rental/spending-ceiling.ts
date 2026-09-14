/**
 * A SEPARATE, stricter spending gate for the manual real-mainnet Tronex smoke
 * test (scripts/tronex-mainnet-smoke-test.ts) — deliberately distinct from
 * the payout cost guard (MAX_NETWORK_COST_USD/MIN_PAYOUT_MARGIN_USD in
 * ../economics-config.ts), which governs ordinary payout economics, not a
 * manually-triggered real-money test script. This one has no default: an
 * unset ceiling means "no one has decided how much this test may spend,"
 * which must fail closed rather than pick a number on the operator's behalf.
 */
export type SpendingCeilingDecision =
  | { ok: true; ceilingUsd: number }
  | { ok: false; reason: string };

export function checkSpendingCeiling(
  quotedUsd: number,
  ceilingRaw: string | undefined,
): SpendingCeilingDecision {
  if (ceilingRaw === undefined || ceilingRaw.trim() === "") {
    return {
      ok: false,
      reason:
        "TRONEX_TEST_MAX_COST_USD is not configured -- failing closed rather than risking an unbounded real spend.",
    };
  }
  const ceilingUsd = Number(ceilingRaw);
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) {
    return {
      ok: false,
      reason: `TRONEX_TEST_MAX_COST_USD is not a valid positive number: "${ceilingRaw}"`,
    };
  }
  if (quotedUsd > ceilingUsd) {
    return {
      ok: false,
      reason: `Quoted cost $${quotedUsd} exceeds TRONEX_TEST_MAX_COST_USD ($${ceilingUsd})`,
    };
  }
  return { ok: true, ceilingUsd };
}
