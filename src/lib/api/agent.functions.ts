import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/require-auth.server";

export const getAgentWorkspaceFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { requireAgent } = await import("../services/guards.server");
    const actor = await requireAgent(context);
    const { getAgentWorkspace } = await import("../services/agent.server");
    return getAgentWorkspace(actor.userId);
  });

export const markVoucherSoldFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { voucherId: string }) => input)
  .handler(async ({ data, context }) => {
    const { requireAgent } = await import("../services/guards.server");
    const actor = await requireAgent(context);
    const { getAgentByUser } = await import("../services/agent.server");
    const agent = await getAgentByUser(actor.userId);
    if (!agent) throw new Error("No agent profile linked to this account");
    const { markVoucherSold } = await import("../services/voucher.server");
    const voucher = await markVoucherSold({
      voucherId: data.voucherId,
      agentId: agent.id,
      actorId: actor.userId,
      actorLabel: actor.label,
    });
    return { public_id: voucher.public_id, status: voucher.status };
  });
