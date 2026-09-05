import { hasRole } from "@/lib/db/users";

type Ctx = { userId: string; claims: Record<string, unknown> };

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
