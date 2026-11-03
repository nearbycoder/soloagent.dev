import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Message,
} from "discord.js";
import { approvalAction, parseApprovalAction } from "../approvals.ts";
import type { ConnectorDriver, ConnectorHost, DriverFactory, InboundMessage, ReplyTarget } from "./types.ts";

/**
 * Discord over the gateway. Answers @mentions and replies to the bot in servers, and every DM.
 * Each Discord thread is its own conversation; in a regular channel the channel is.
 */
export const discordDriver: DriverFactory = (config, host) =>
  createDiscordDriver(config, host, () =>
    new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel, Partials.Message],
    }),
  );

/** The driver around any discord.js-shaped client. Tests pass a stub; production a real gateway Client. */
export function createDiscordDriver(config: Record<string, string>, host: ConnectorHost, makeClient: () => Client): ConnectorDriver {
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
      client = makeClient();
      const ready = new Promise<void>((resolve) => client!.once(Events.ClientReady, () => resolve()));

      client.on(Events.MessageCreate, async (message: Message) => {
        const botUserId = client?.user?.id;
        if (message.author.bot || !botUserId) return;
        const isDirect = message.channel.type === ChannelType.DM;
        let repliedToBot = false;
        if (message.reference?.messageId && !message.mentions.users.has(botUserId) && !isDirect) {
          const ref = await message.fetchReference().catch(() => undefined);
          repliedToBot = ref?.author.id === botUserId;
        }
        const inbound = discordInbound(message, botUserId, repliedToBot);
        if (inbound) host.receive(inbound);
      });

      // Approvals: Approve / Deny buttons on approval messages.
      client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isButton()) return;
        const parsed = parseApprovalAction(interaction.customId);
        if (!parsed) return;
        try {
          await interaction.deferUpdate();
          const member = interaction.member as { displayName?: string } | null;
          const name = member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
          const result = await host.decide({ approvalId: parsed.id, approve: parsed.approve, user: { id: interaction.user.id, name } });
          if (!result.ok) await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral });
        } catch (error) {
          host.log(`discord: ${error instanceof Error ? error.message : String(error)}`);
        }
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
      const sent = await channel.send(discordReply(target, markdown));
      return { channelId: sent.channelId, messageId: sent.id };
    },

    async edit(_target, handle, markdown) {
      const channel = await fetchChannel(handle.channelId!);
      const message = await channel.messages.fetch(handle.messageId!);
      await message.edit({ content: markdown });
    },

    async requestApproval(target, approvalId, markdown) {
      const channel = await fetchChannel(target.channelId!);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(approvalAction(approvalId, true)).setLabel("Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(approvalAction(approvalId, false)).setLabel("Deny").setStyle(ButtonStyle.Danger),
      );
      const sent = await channel.send({ content: markdown.slice(0, 1_950), components: [row], allowedMentions: { parse: [] } });
      return { channelId: sent.channelId, messageId: sent.id };
    },

    async resolveApproval(_target, handle, markdown) {
      const channel = await fetchChannel(handle.channelId!);
      const message = await channel.messages.fetch(handle.messageId!);
      await message.edit({ content: markdown.slice(0, 1_950), components: [] });
    },

    async typing(target) {
      const channel = await fetchChannel(target.channelId!);
      await channel.sendTyping();
    },
  };
}

/**
 * The InboundMessage for a Discord message, or undefined when the bot should stay quiet: it answers every DM,
 * and in servers @mentions and replies to the bot (`repliedToBot`, which needs a fetch, so the caller works it out).
 */
export function discordInbound(message: Message, botUserId: string, repliedToBot: boolean): InboundMessage | undefined {
  if (message.author.bot) return undefined;
  const isDirect = message.channel.type === ChannelType.DM;
  const mentioned = message.mentions.users.has(botUserId);
  if (!isDirect && !mentioned && !repliedToBot) return undefined;
  const text = message.content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  const name = message.member?.displayName ?? message.author.globalName ?? message.author.username;
  const channelName = "name" in message.channel && message.channel.name ? `#${message.channel.name}` : "channel";
  const location = isDirect ? `DM with ${name}` : `${message.guild?.name ?? "server"} ${channelName}`;
  return {
    externalKey: message.channelId,
    location,
    title: isDirect ? `DM with ${name}` : `${channelName} · ${text.slice(0, 48)}`,
    author: { name, id: message.author.id, source: "discord", avatarUrl: message.author.displayAvatarURL({ size: 64 }) },
    text,
    target: { channelId: message.channelId, replyTo: message.id },
    isDirect,
    ...(isDirect ? {} : { channel: { id: message.channelId, name: channelName === "channel" ? undefined : channelName, parent: parentOf(message) } }),
    // Attachments are on Discord's public CDN; the runtime downloads them.
    ...(message.attachments.size
      ? { attachments: [...message.attachments.values()].map((a) => ({ name: a.name, mimeType: a.contentType ?? "", size: a.size, url: a.url })) }
      : {}),
  };
}

/** The send options of a reply: threaded under the message it answers, never pinging anyone. */
export function discordReply(target: ReplyTarget, markdown: string) {
  return {
    content: markdown,
    reply: target.replyTo ? { messageReference: target.replyTo, failIfNotExists: false } : undefined,
    allowedMentions: { repliedUser: false, parse: [] as [] },
  };
}

/** A thread's parent channel, so "#eng" in an access list also covers threads inside #eng. */
function parentOf(message: Message): { id: string; name?: string } | undefined {
  const channel = message.channel as unknown as { isThread?: () => boolean; parent?: { id: string; name?: string } | null };
  if (!channel.isThread?.() || !channel.parent) return undefined;
  return { id: channel.parent.id, name: channel.parent.name ? `#${channel.parent.name}` : undefined };
}
