import { adminIds } from "./config";
import type { AgentRow } from "@/lib/domain/types";

export type Identity =
  | { role: "admin"; label: string }
  | { role: "agent"; label: string; agent: AgentRow }
  | { role: "customer"; label: string };

export function isAdmin(telegramUserId: number): boolean {
  return adminIds().includes(telegramUserId);
}

function actorLabel(user: { id: number; username?: string }): string {
  return `telegram:${user.id}${user.username ? `:@${user.username}` : ""}`;
}

export async function resolveIdentity(user: { id: number; username?: string }): Promise<Identity> {
  const label = actorLabel(user);
  if (isAdmin(user.id)) return { role: "admin", label };

  const { getAgentByTelegramId } = await import("@/lib/services/agent.server");
  const agent = await getAgentByTelegramId(user.id);
  if (agent) return { role: "agent", label, agent };

  return { role: "customer", label };
}
