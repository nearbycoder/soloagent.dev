import type { ServerResponse } from "node:http";
import { json, listen, readBody } from "./http.ts";

export type TgUser = { id: number; first_name: string; last_name?: string; username?: string };
export type TgChat = { id: number; type: "private" | "group" | "supergroup"; title?: string; first_name?: string };
export type TgCall = { method: string; params: Record<string, unknown>; result?: unknown };

type Update = { update_id: number } & Record<string, unknown>;

/**
 * A minimal Telegram Bot API on loopback: getMe, getUpdates (a real long poll over a queue), sendMessage,
 * editMessageText, sendChatAction, answerCallbackQuery, deleteWebhook, getFile. Point grammy at `apiRoot`.
 */
export class FakeTelegram {
  readonly bot: TgUser & { is_bot: true };
  readonly calls: TgCall[] = [];
  apiRoot = "";
  #token: string;
  #updates: Update[] = [];
  #nextUpdate = 1;
  #nextMessage = 1_000;
  #polls = new Set<() => void>();
  #close: () => Promise<void> = async () => {};

  private constructor(token: string, bot: TgUser) {
    this.#token = token;
    this.bot = { ...bot, is_bot: true };
  }

  static async start(token: string, bot: TgUser = { id: 4242, first_name: "Solo", username: "solo_bot" }): Promise<FakeTelegram> {
    const fake = new FakeTelegram(token, bot);
    const { port, close } = await listen(async (req, res) => {
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(new URL(req.url ?? "/", "http://x").pathname);
      if (!match || match[1] !== fake.#token) return json(res, { ok: false, error_code: 401, description: "Unauthorized" }, 401);
      const method = match[2]!;
      const params = await readBody(req);
      const call: TgCall = { method, params };
      fake.calls.push(call);
      const answer = await fake.#handle(method, params, res);
      if (res.destroyed) return; // a long poll the client gave up on
      call.result = answer.result;
      json(res, answer, answer.ok ? 200 : answer.error_code);
    });
    fake.apiRoot = `http://127.0.0.1:${port}`;
    fake.#close = close;
    return fake;
  }

  /** The message a sendMessage call created. */
  static messageId(call: TgCall | undefined): number {
    return (call?.result as { message_id: number }).message_id;
  }

  /** Calls to one method, in order. */
  callsTo(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  /** Every text the bot showed in a chat: sent messages and edits, in order. */
  textsIn(chatId: number): string[] {
    return this.calls
      .filter((c) => (c.method === "sendMessage" || c.method === "editMessageText") && Number(c.params.chat_id) === chatId)
      .map((c) => String(c.params.text));
  }

  /** Queue an incoming text message, as Telegram would deliver it to getUpdates. */
  message(from: TgUser, chat: TgChat, text: string): number {
    const messageId = this.#nextMessage++;
    this.#push({ message: { message_id: messageId, date: now(), chat, from: { ...from, is_bot: false }, text } });
    return messageId;
  }

  /** Queue a button press on an inline keyboard. */
  callback(from: TgUser, chat: TgChat, data: string, messageId: number) {
    this.#push({
      callback_query: {
        id: `cb${this.#nextUpdate}`,
        from: { ...from, is_bot: false },
        chat_instance: "ci1",
        data,
        message: { message_id: messageId, date: now(), chat, from: this.bot, text: "approval" },
      },
    });
  }

  async close() {
    for (const wake of this.#polls) wake();
    await this.#close();
  }

  #push(update: Record<string, unknown>) {
    this.#updates.push({ update_id: this.#nextUpdate++, ...update });
    for (const wake of this.#polls) wake();
  }

  async #handle(method: string, params: Record<string, unknown>, res: ServerResponse): Promise<{ ok: boolean; result?: unknown; error_code?: number; description?: string }> {
    const ok = (result: unknown) => ({ ok: true, result });
    switch (method) {
      case "getMe":
        return ok(this.bot);
      case "deleteWebhook":
      case "sendChatAction":
      case "answerCallbackQuery":
        return ok(true);
      case "getUpdates": {
        const offset = Number(params.offset ?? 0);
        // Updates below the offset are confirmed; Telegram forgets them.
        this.#updates = this.#updates.filter((u) => u.update_id >= offset);
        const timeout = Number(params.timeout ?? 0);
        if (!this.#updates.length && timeout > 0) {
          const polls = this.#polls;
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              polls.delete(done);
              resolve();
            };
            const timer = setTimeout(done, timeout * 1_000);
            polls.add(done);
            res.on("close", done);
          });
        }
        return ok(this.#updates.slice(0, Number(params.limit ?? 100)));
      }
      case "sendMessage": {
        const chatId = Number(params.chat_id);
        return ok({
          message_id: this.#nextMessage++,
          date: now(),
          chat: { id: chatId, type: chatId < 0 ? "group" : "private" },
          from: this.bot,
          text: params.text,
        });
      }
      case "editMessageText":
        return ok({ message_id: Number(params.message_id), date: now(), chat: { id: Number(params.chat_id), type: "private" }, from: this.bot, text: params.text });
      case "getFile":
        return ok({ file_id: params.file_id, file_unique_id: String(params.file_id), file_path: `files/${String(params.file_id)}` });
      default:
        return { ok: false, error_code: 404, description: `Not Found: method ${method}` };
    }
  }
}

const now = () => Math.floor(Date.now() / 1000);
