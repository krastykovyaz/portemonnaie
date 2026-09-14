/**
 * Fetches ACTUAL resource consumption for a confirmed transaction directly
 * from TronGrid's transaction receipt. Never estimated/guessed — if the
 * receipt can't be read, callers get `null` and must leave the actual_*
 * columns null rather than backfill them with the pre-broadcast estimate.
 */
export type ActualResourceUsage = {
  energyUsed: number;
  bandwidthUsed: number;
  /** sun actually burned for bandwidth (0 if covered by the free daily quota). */
  netFeeSun: number;
  /** sun actually burned for energy (0 if covered by the contract's own sponsorship or a staked pool). */
  energyFeeSun: number;
};

export async function fetchActualResourceUsage(
  txHash: string,
  apiUrl: string,
): Promise<ActualResourceUsage | null> {
  try {
    const res = await fetch(`${apiUrl}/wallet/gettransactioninfobyid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: txHash }),
    });
    if (!res.ok) return null;
    const info = (await res.json()) as {
      id?: string;
      receipt?: {
        energy_usage_total?: number;
        net_usage?: number;
        net_fee?: number;
        energy_fee?: number;
      };
    };
    if (!info || !info.id || !info.receipt) return null;
    return {
      energyUsed: info.receipt.energy_usage_total ?? 0,
      bandwidthUsed: info.receipt.net_usage ?? 0,
      netFeeSun: info.receipt.net_fee ?? 0,
      energyFeeSun: info.receipt.energy_fee ?? 0,
    };
  } catch {
    return null;
  }
}
