import type { TelegramClient, TelegramUser } from "./telegram";
import type { Identity } from "./auth";
import type { ChatSession } from "./session";

export type Ctx = {
  tg: TelegramClient;
  chatId: number;
  user: TelegramUser;
  identity: Identity;
  session: ChatSession;
};

export async function reply(ctx: Ctx, text: string): Promise<void> {
  await ctx.tg.sendMessage(ctx.chatId, text);
}
