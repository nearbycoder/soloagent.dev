import { Bot } from "grammy";
import { toTelegramHtml } from "./format.ts";
import type { ConnectorDriver, DriverFactory } from "./types.ts";

/**
 * Telegram over long polling. Answers every private message, and in groups @mentions and replies to the bot.
 * Forum topics are separate conversations.
 */
export const telegramDriver: DriverFactory = (config, host): ConnectorDriver => {
  const token = config.botToken ?? "";
  let bot: Bot | undefined;

  async function send(chatId: string, markdown: string, extra: Record<string, unknown>) {
    try {
      return await bot!.api.sendMessage(chatId, toTelegramHtml(markdown), { parse_mode: "HTML", ...extra });
    } catch {
      return await bot!.api.sendMessage(chatId, markdown, extra);
    }
  }

  return {
    maxLength: 3_900,

    async start() {
      if (!token) throw new Error("Bot token is required");
      bot = new Bot(token);
      const me = await bot.api.getMe();
      const username = me.username;

      bot.on("message:text", async (ctx) => {
        const message = ctx.message;
        const chat = ctx.chat;
        const isDirect = chat.type === "private";
        const mentioned = username ? message.text.includes(`@${username}`) : false;
        const repliedToBot = message.reply_to_message?.from?.id === me.id;
        if (!isDirect && !mentioned && !repliedToBot) return;
        const from = message.from;
        const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "someone";
        const text = username ? message.text.replace(new RegExp(`@${username}\\b`, "g"), "").trim() : message.text;
        const topic = message.is_topic_message ? message.message_thread_id : undefined;
        const title = "title" in chat && chat.title ? chat.title : `DM with ${name}`;
        host.receive({
          externalKey: topic ? `${chat.id}:${topic}` : String(chat.id),
          location: isDirect ? `DM with ${name}` : title,
          title,
          author: { name, id: from ? String(from.id) : undefined, source: "telegram" },
          text,
          target: {
            chatId: String(chat.id),
            ...(topic ? { threadId: String(topic) } : {}),
            ...(isDirect ? {} : { replyTo: String(message.message_id) }),
          },
          isDirect,
        });
      });

      bot.catch((error) => host.log(`telegram: ${error.message}`));
      void bot.start({ drop_pending_updates: false, onStart: () => host.status("connected", undefined, `@${username}`) });
    },

    async stop() {
      await bot?.stop().catch(() => {});
      bot = undefined;
    },

    async post(target, markdown) {
      if (!bot) throw new Error("Telegram is not connected");
      const sent = await send(target.chatId!, markdown, {
        ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
        ...(target.replyTo ? { reply_parameters: { message_id: Number(target.replyTo), allow_sending_without_reply: true } } : {}),
      });
      return { chatId: String(sent.chat.id), messageId: String(sent.message_id) };
    },

    async edit(_target, handle, markdown) {
      if (!bot) throw new Error("Telegram is not connected");
      try {
        await bot.api.editMessageText(handle.chatId!, Number(handle.messageId), toTelegramHtml(markdown), { parse_mode: "HTML" });
      } catch (error) {
        if (String(error).includes("not modified")) return;
        await bot.api.editMessageText(handle.chatId!, Number(handle.messageId), markdown).catch(() => {});
      }
    },

    async typing(target) {
      await bot?.api.sendChatAction(target.chatId!, "typing", target.threadId ? { message_thread_id: Number(target.threadId) } : {});
    },
  };
};
