/**
 * In-memory per-chat state. One process, one Map — fine for a single-instance
 * long-polling bot. Restarting the process drops in-flight conversations,
 * which is acceptable for a demo.
 */

export type BuyState = { publicOrderId: string; paymentId: string };

export type RedeemFlow =
  | { step: "AWAIT_PUBLIC_ID" }
  | { step: "AWAIT_CODE"; publicId: string }
  | { step: "AWAIT_DESTINATION"; publicId: string; code: string };

export type ChatSession = {
  activeOrder?: BuyState;
  redeem?: RedeemFlow;
};

const sessions = new Map<number, ChatSession>();

export function getSession(chatId: number): ChatSession {
  let session = sessions.get(chatId);
  if (!session) {
    session = {};
    sessions.set(chatId, session);
  }
  return session;
}

export function clearFlow(chatId: number): void {
  const session = getSession(chatId);
  delete session.redeem;
}
