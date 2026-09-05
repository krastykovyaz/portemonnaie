import { db, newId, nowIso } from "./client";
import { hashPassword } from "../auth/password.server";

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  created_at: string;
  updated_at: string;
};

export function getUserByEmail(email: string): UserRow | null {
  return (
    (db.query(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase()) as UserRow | null) ??
    null
  );
}

export function getUserById(userId: string): UserRow | null {
  return (db.query(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow | null) ?? null;
}

export function getRolesForUser(userId: string): string[] {
  const rows = db.query(`SELECT role FROM user_roles WHERE user_id = ?`).all(userId) as Array<{
    role: string;
  }>;
  return rows.map((r) => r.role);
}

export function hasRole(userId: string, role: "admin" | "agent" | "customer"): boolean {
  return (
    db.query(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?`).get(userId, role) !== null
  );
}

export function grantRole(userId: string, role: "admin" | "agent" | "customer"): void {
  db.query(
    `INSERT OR IGNORE INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
  ).run(newId(), userId, role, nowIso());
}

/** Mirrors the former handle_new_user trigger: every signup starts as a plain customer. */
export async function createUser(input: {
  email: string;
  password: string;
  fullName?: string | null;
}): Promise<UserRow> {
  const id = newId();
  const now = nowIso();
  const passwordHash = await hashPassword(input.password);
  const email = input.email.trim().toLowerCase();

  db.query(
    `INSERT INTO users (id, email, password_hash, full_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, email, passwordHash, input.fullName ?? email, now, now);
  grantRole(id, "customer");

  return {
    id,
    email,
    password_hash: passwordHash,
    full_name: input.fullName ?? email,
    created_at: now,
    updated_at: now,
  };
}
