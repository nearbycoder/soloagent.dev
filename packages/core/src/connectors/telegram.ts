import { Bot } from "grammy";
import { toTelegramHtml } from "./format.ts";
import type { ConnectorDriver, DriverFactory, InboundMessage } from "./types.ts";
import { ATTACHMENT_LIMITS } from "../attachments.ts";

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

  /** A photo (its largest size) or a document as a download URL. The Bot API serves files up to 20 MB. */
  async function fileOf(file: { file_id: string; file_size?: number }, name: string, mimeType: string): Promise<NonNullable<InboundMessage["attachments"]>[number]> {
    const base = { name, mimeType, size: file.file_size ?? 0 };
    if (base.size > ATTACHMENT_LIMITS.maxFileBytes) return base;
    try {
      const info = await bot!.api.getFile(file.file_id);
      return info.file_path ? { ...base, url: `https://api.telegram.org/file/bot${token}/${info.file_path}` } : base;
    } catch (error) {
      host.log(`telegram: could not fetch ${name}: ${(error as Error).message}`);
      return base;
    }
  }

  return {
    maxLength: 3_900,

    async start() {
      if (!token) throw new Error("Bot token is required");
      bot = new Bot(token);
      const me = await bot.api.getMe();
      const username = me.username;

      bot.on(["message:text", "message:photo", "message:document"], async (ctx) => {
        const message = ctx.message;
        const chat = ctx.chat;
        const isDirect = chat.type === "private";
        // Photos and documents carry their text as a caption.
        const raw = message.text ?? message.caption ?? "";
        const mentioned = username ? raw.includes(`@${username}`) : false;
        const repliedToBot = message.reply_to_message?.from?.id === me.id;
        if (!isDirect && !mentioned && !repliedToBot) return;
        const from = message.from;
        const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "someone";
        const text = username ? raw.replace(new RegExp(`@${username}\\b`, "g"), "").trim() : raw;
        const photo = message.photo?.at(-1);
        const attachments = photo
          ? [await fileOf(photo, `photo-${photo.file_unique_id}.jpg`, "image/jpeg")]
          : message.document
            ? [await fileOf(message.document, message.document.file_name ?? "file", message.document.mime_type ?? "")]
            : undefined;
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
          ...(attachments ? { attachments } : {}),
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
