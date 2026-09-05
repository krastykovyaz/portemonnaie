/** Small read helpers the bot needs that the web app's service layer doesn't expose. */
import { db } from "@/lib/db/client";

export async function getVoucherIdByPublicId(
  publicId: string,
): Promise<{ id: string; status: string; assigned_agent_id: string | null } | null> {
  return (
    (db
      .query(`SELECT id, status, assigned_agent_id FROM vouchers WHERE public_id = ?`)
      .get(publicId.toUpperCase()) as {
      id: string;
      status: string;
      assigned_agent_id: string | null;
    } | null) ?? null
  );
}
