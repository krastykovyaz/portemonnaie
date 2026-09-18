import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth.server";

const credentialsSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(6).max(200),
});

export const signInFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => credentialsSchema.parse(input))
  .handler(async ({ data }) => {
    const { getUserByEmail } = await import("@/lib/db/users");
    const { verifyPassword } = await import("@/lib/auth/password.server");
    const user = getUserByEmail(data.email);
    if (!user || !(await verifyPassword(data.password, user.password_hash))) {
      return { ok: false as const, error: "Invalid email or password." };
    }
    const { createUserSession } = await import("@/lib/auth/session.server");
    await createUserSession(user.id);
    return { ok: true as const };
  });

export const signUpFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => credentialsSchema.parse(input))
  .handler(async ({ data }) => {
    const { getUserByEmail, createUser } = await import("@/lib/db/users");
    if (getUserByEmail(data.email)) {
      return { ok: false as const, error: "An account with that email already exists." };
    }
    const user = await createUser({ email: data.email, password: data.password });
    const { createUserSession } = await import("@/lib/auth/session.server");
    await createUserSession(user.id);
    return { ok: true as const };
  });

export const signOutFn = createServerFn({ method: "POST" }).handler(async () => {
  const { destroySession } = await import("@/lib/auth/session.server");
  await destroySession();
  return { ok: true as const };
});

export const meFn = createServerFn({ method: "GET" }).handler(async () => {
  const { currentUserId } = await import("@/lib/auth/session.server");
  const userId = await currentUserId();
  if (!userId) return null;
  const { getUserById } = await import("@/lib/db/users");
  const user = getUserById(userId);
  if (!user) return null;
  return { id: user.id, email: user.email };
});

export const getSessionProfileFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { getRolesForUser } = await import("@/lib/db/users");
    const roles = getRolesForUser(context.userId);
    const email = context.claims["email"];
    const { getAgentByUser } = await import("../services/agent.server");
    const agent = roles.includes("agent") ? await getAgentByUser(context.userId) : null;
    const { demoToolsEnabled } = await import("../services/guards.server");
    return {
      userId: context.userId,
      email: typeof email === "string" ? email : null,
      roles,
      agentName: agent?.name ?? null,
      agentRef: agent?.agent_ref ?? null,
      demoToolsEnabled: demoToolsEnabled(),
    };
  });

const claimSchema = z.object({
  role: z.enum(["admin", "agent"]),
  agentRef: z.enum(["AGT-A", "AGT-B", "AGT-C"]).optional(),
});

/**
 * DEMO ONLY: lets a signed-in demo user take the admin or agent role so the
 * end-to-end flow can be walked through without manual provisioning.
 * A production deployment would provision roles out of band.
 */
export const claimDemoRoleFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: unknown) => claimSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { requireDemoMode } = await import("../services/guards.server");
    requireDemoMode();
    const { grantRole } = await import("@/lib/db/users");
    const { db } = await import("@/lib/db/client");
    const email = context.claims["email"];
    const label = typeof email === "string" ? email : context.userId;

    grantRole(context.userId, data.role);

    if (data.role === "agent") {
      const agentRef = data.agentRef ?? "AGT-A";
      db.query(`UPDATE agents SET user_id = NULL WHERE user_id = ?`).run(context.userId);
      const result = db
        .query(`UPDATE agents SET user_id = ?, email = ? WHERE agent_ref = ?`)
        .run(context.userId, label, agentRef);
      if (result.changes === 0) throw new Error(`No agent record for ${agentRef}`);
    }

    const { writeAudit } = await import("../services/audit.server");
    await writeAudit({
      actorId: context.userId,
      actorLabel: label,
      action: "DEMO_ROLE_CLAIMED",
      entity: "user_role",
      entityId: context.userId,
      metadata: { role: data.role, agent_ref: data.agentRef ?? null },
    });

    return { ok: true, role: data.role };
  });
