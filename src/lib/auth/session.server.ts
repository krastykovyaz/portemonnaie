// Aliased on import: this is a server-side cookie-session accessor, not a React
// hook, but eslint-plugin-react-hooks treats any `use*`-named call as one.
import { useSession as startSession } from "@tanstack/react-start/server";

export type AuthSessionData = { userId: string };

function sessionConfig() {
  const password = process.env["SESSION_SECRET"];
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters");
  }
  return {
    password,
    name: "voucherrail",
    maxAge: 60 * 60 * 24 * 30,
    cookie: { httpOnly: true, sameSite: "lax" as const, path: "/" },
  };
}

function getAuthSession() {
  return startSession<AuthSessionData>(sessionConfig());
}

export async function createUserSession(userId: string): Promise<void> {
  const session = await getAuthSession();
  await session.update({ userId });
}

export async function destroySession(): Promise<void> {
  const session = await getAuthSession();
  await session.clear();
}

export async function currentUserId(): Promise<string | null> {
  const session = await getAuthSession();
  return session.data.userId ?? null;
}
