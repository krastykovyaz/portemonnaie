import { createMiddleware } from "@tanstack/react-start";
import { currentUserId } from "./session.server";
import { getUserById } from "../db/users";

/** Replaces the former requireSupabaseAuth: reads the signed session cookie instead of a bearer JWT. */
export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const userId = await currentUserId();
  if (!userId) throw new Error("Unauthorized: not signed in");
  const user = getUserById(userId);
  if (!user) throw new Error("Unauthorized: account no longer exists");
  return next({ context: { userId, claims: { email: user.email } } });
});
