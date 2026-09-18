/**
 * VoucherRail Telegram bot — standalone process, long polling.
 * Run with: bun run bot
 *
 * Talks to the same Supabase project as the web app via the shared
 * src/lib/services/*.server.ts business logic, but is otherwise fully
 * decoupled: it does not import any TanStack Start route, server function,
 * or the request-scoped Supabase auth middleware. Authorization here is
 * Telegram-identity based (see bot/auth.ts), not Supabase-session based.
 */
import { requireBotToken } from "./config";
import { TelegramClient, type TelegramUpdate } from "./telegram";
import { resolveIdentity } from "./auth";
import { getSession } from "./session";
import { routeMessage, routeCallback } from "./router";
import type { Ctx } from "./context";
import { ensureSeeded } from "@/lib/db/bootstrap";

await ensureSeeded();

async function handleUpdate(tg: TelegramClient, update: TelegramUpdate): Promise<void> {
  if (update.message?.text && update.message.from) {
    const { chat, from, text } = update.message;
    const identity = await resolveIdentity(from);
    const ctx: Ctx = { tg, chatId: chat.id, user: from, identity, session: getSession(chat.id) };
    await routeMessage(ctx, text!);
    return;
  }

  if (update.callback_query?.data && update.callback_query.message) {
    const { data, from, message, id } = update.callback_query;
    const identity = await resolveIdentity(from);
    const ctx: Ctx = {
      tg,
      chatId: message.chat.id,
      user: from,
      identity,
      session: getSession(message.chat.id),
    };
    await tg.answerCallbackQuery(id);
    await routeCallback(ctx, data!);
  }
}

async function main() {
  const tg = new TelegramClient(requireBotToken());
  const me = await tg.getMe();
  console.log(`[bot] logged in as @${me.username} (id ${me.id})`);

  let offset = 0;
  let running = true;
  let controller = new AbortController();
  const stop = () => {
    running = false;
    controller.abort();
    console.log("[bot] shutting down…");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (running) {
    let updates: TelegramUpdate[];
    try {
      controller = new AbortController();
      updates = await tg.getUpdates(offset, 30, controller.signal);
    } catch (err) {
      if (!running) break;
      console.error("[bot] getUpdates failed, retrying in 3s", err);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        await handleUpdate(tg, update);
      } catch (err) {
        console.error("[bot] handler error", err);
        const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
        if (chatId) {
          await tg
            .sendMessage(chatId, "Something went wrong handling that. Please try again.")
            .catch(() => {});
        }
      }
    }
  }
}

main().catch((err) => {
  console.error("[bot] fatal", err);
  process.exit(1);
});
