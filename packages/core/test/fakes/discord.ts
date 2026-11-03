import { EventEmitter } from "node:events";
import { ChannelType, type Client, Events, type Message } from "discord.js";

export type SentDiscord = { channelId: string; id: string; content: string; reply?: { messageReference: string }; allowedMentions?: unknown; components?: unknown[] };

/**
 * A discord.js Client stand-in: login() emits ClientReady, channels.fetch() returns sendable channels that record
 * what the bot sends and edits. No gateway, no network. Emit Events.MessageCreate with `stubMessage()` to talk to it.
 */
export class StubDiscordClient extends EventEmitter {
  user = { id: "BOT1", tag: "Solo#0001" };
  sent: SentDiscord[] = [];
  edits: { id: string; content: string }[] = [];
  typing = 0;
  destroyed = false;
  #next = 1;

  async login(token: string) {
    queueMicrotask(() => this.emit(Events.ClientReady, this));
    return token;
  }

  async destroy() {
    this.destroyed = true;
    this.removeAllListeners();
  }

  channels = {
    fetch: async (id: string) => ({
      id,
      isSendable: () => true,
      send: async (options: Omit<SentDiscord, "channelId" | "id">) => {
        const message = { channelId: id, id: `m${this.#next++}`, ...options };
        this.sent.push(message);
        return message;
      },
      sendTyping: async () => {
        this.typing++;
      },
      messages: {
        fetch: async (messageId: string) => ({
          id: messageId,
          edit: async (options: { content: string }) => {
            this.edits.push({ id: messageId, content: options.content });
            const sent = this.sent.find((s) => s.id === messageId);
            if (sent) sent.content = options.content;
          },
        }),
      },
    }),
  };

  asClient(): Client {
    return this as unknown as Client;
  }

  /** Every message's latest text in a channel, in order. */
  contents(channelId: string): string[] {
    return this.sent.filter((s) => s.channelId === channelId).map((s) => s.content);
  }
}

type StubMessageInput = {
  content: string;
  author?: { id: string; username: string; globalName?: string | null; bot?: boolean };
  memberName?: string;
  dm?: boolean;
  channelId?: string;
  channelName?: string;
  guildName?: string;
  /** A thread inside this parent channel. */
  parent?: { id: string; name: string };
  mentions?: string[];
  reference?: string;
  attachments?: { name: string; contentType: string | null; size: number; url: string }[];
  id?: string;
};

/** Just enough of a discord.js Message for the driver's reads. */
export function stubMessage(input: StubMessageInput): Message {
  const author = input.author ?? { id: "U1", username: "ann", globalName: "Ann" };
  const channelId = input.channelId ?? (input.dm ? "DM1" : "C1");
  const attachments = new Map((input.attachments ?? []).map((a, i) => [String(i), a]));
  const channel = input.dm
    ? { type: ChannelType.DM, isThread: () => false }
    : {
        type: input.parent ? ChannelType.PublicThread : ChannelType.GuildText,
        name: input.channelName ?? "eng",
        isThread: () => !!input.parent,
        parent: input.parent ?? null,
      };
  return {
    id: input.id ?? "M1",
    content: input.content,
    channelId,
    channel,
    author: { bot: false, globalName: null, ...author, displayAvatarURL: () => `https://cdn.example/${author.id}.png` },
    member: input.dm ? null : { displayName: input.memberName ?? author.globalName ?? author.username },
    guild: input.dm ? null : { name: input.guildName ?? "Acme" },
    mentions: { users: new Set(input.mentions ?? []) },
    reference: input.reference ? { messageId: input.reference } : null,
    fetchReference: async () => ({ author: { id: "BOT1" } }),
    attachments,
  } as unknown as Message;
}
