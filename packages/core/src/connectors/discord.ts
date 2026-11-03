import { ChannelType, Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import type { ConnectorDriver, DriverFactory } from "./types.ts";

/**
 * Discord over the gateway. Answers @mentions and replies to the bot in servers, and every DM.
 * Each Discord thread is its own conversation; in a regular channel the channel is.
 */
export const discordDriver: DriverFactory = (config, host): ConnectorDriver => {
  const token = config.botToken ?? "";
  let client: Client | undefined;

  async function fetchChannel(id: string) {
    if (!client) throw new Error("Discord is not connected");
    const channel = await client.channels.fetch(id);
    if (!channel || !channel.isSendable()) throw new Error(`Cannot send to channel ${id}`);
    return channel;
  }

  return {
    maxLength: 1_950,

    async start() {
      if (!token) throw new Error("Bot token is required");
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel, Partials.Message],
      });
      const ready = new Promise<void>((resolve) => client!.once(Events.ClientReady, () => resolve()));

      client.on(Events.MessageCreate, async (message: Message) => {
        if (message.author.bot || !client?.user) return;
        const isDirect = message.channel.type === ChannelType.DM;
        const mentioned = message.mentions.users.has(client.user.id);
        let repliedToBot = false;
        if (message.reference?.messageId && !mentioned && !isDirect) {
          const ref = await message.fetchReference().catch(() => undefined);
          repliedToBot = ref?.author.id === client.user.id;
        }
        if (!isDirect && !mentioned && !repliedToBot) return;
        const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
        const name = message.member?.displayName ?? message.author.globalName ?? message.author.username;
        const channelName = "name" in message.channel && message.channel.name ? `#${message.channel.name}` : "channel";
        const location = isDirect ? `DM with ${name}` : `${message.guild?.name ?? "server"} ${channelName}`;
        host.receive({
          externalKey: message.channelId,
          location,
          title: isDirect ? `DM with ${name}` : `${channelName} · ${text.slice(0, 48)}`,
          author: { name, id: message.author.id, source: "discord", avatarUrl: message.author.displayAvatarURL({ size: 64 }) },
          text,
          target: { channelId: message.channelId, replyTo: message.id },
          isDirect,
          // Attachments are on Discord's public CDN; the runtime downloads them.
          ...(message.attachments.size
            ? { attachments: [...message.attachments.values()].map((a) => ({ name: a.name, mimeType: a.contentType ?? "", size: a.size, url: a.url })) }
            : {}),
        });
      });

      client.on(Events.Error, (error) => host.log(`discord: ${error.message}`));
      await client.login(token);
      await ready;
      host.status("connected", undefined, client.user?.tag);
    },

    async stop() {
      await client?.destroy();
      client = undefined;
    },

    async post(target, markdown) {
      const channel = await fetchChannel(target.channelId!);
      const sent = await channel.send({
        content: markdown,
        reply: target.replyTo ? { messageReference: target.replyTo, failIfNotExists: false } : undefined,
        allowedMentions: { repliedUser: false, parse: [] },
      });
      return { channelId: sent.channelId, messageId: sent.id };
    },

    async edit(_target, handle, markdown) {
      const channel = await fetchChannel(handle.channelId!);
      const message = await channel.messages.fetch(handle.messageId!);
      await message.edit({ content: markdown });
    },

    async typing(target) {
      const channel = await fetchChannel(target.channelId!);
      await channel.sendTyping();
    },
  };
};
