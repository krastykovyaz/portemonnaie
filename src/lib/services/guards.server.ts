import { hasRole } from "@/lib/db/users";
import { normalizeMode } from "../config/mode";

type Ctx = { userId: string; claims: Record<string, unknown> };

export function demoToolsEnabled(chainMode: string | undefined = process.env["CHAIN_MODE"]): boolean {
  return normalizeMode(chainMode) === "DEMO";
}

/**
 * Demo conveniences (self-granted roles, dataset reset, simulated payments)
 * must never be reachable once anything real is configured — in TESTNET the
 * payout signer can be live, so a self-granted admin would control real
 * transfers. Fails closed: anything other than an explicit DEMO refuses.
 */
export function requireDemoMode(): void {
  if (!demoToolsEnabled()) {
    throw new Error("Forbidden: this action is only available in DEMO mode");
  }
}

export function actorLabel(context: Ctx): string {
  const email = context.claims["email"];
  return typeof email === "string" ? email : context.userId;
}

export async function requireAdmin(context: Ctx) {
  if (!hasRole(context.userId, "admin")) throw new Error("Forbidden: admin role required");
  return { userId: context.userId, label: actorLabel(context) };
}

export async function requireAgent(context: Ctx) {
  if (!hasRole(context.userId, "agent")) throw new Error("Forbidden: agent role required");
  return { userId: context.userId, label: actorLabel(context) };
}
