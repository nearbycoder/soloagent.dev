import bolt from "@slack/bolt";
import type { ConnectorDriver, DriverFactory, InboundMessage } from "./types.ts";
import { toSlack } from "./format.ts";
import { approvalAction, parseApprovalAction } from "../approvals.ts";
import { ATTACHMENT_LIMITS, download } from "../attachments.ts";

const { App, LogLevel } = bolt;

/**
 * Slack over Socket Mode: no public URL needed, works behind Railway and on a laptop alike.
 * Answers @mentions in channels (in a thread) and every direct message.
 */
export const slackDriver: DriverFactory = (config, host): ConnectorDriver => {
  const botToken = config.botToken ?? "";
  const appToken = config.appToken ?? "";
  let app: InstanceType<typeof App> | undefined;
  let botUserId = "";
  const users = new Map<string, string>();
  const channels = new Map<string, string>();

  async function userName(client: InstanceType<typeof App>["client"], id: string): Promise<string> {
    const cached = users.get(id);
    if (cached) return cached;
    try {
      const info = await client.users.info({ user: id });
      const name = info.user?.profile?.display_name || info.user?.real_name || info.user?.name || id;
      users.set(id, name);
      return name;
    } catch {
      return id;
    }
  }

  async function channelName(client: InstanceType<typeof App>["client"], id: string): Promise<string> {
    const cached = channels.get(id);
    if (cached) return cached;
    try {
      const info = await client.conversations.info({ channel: id });
      const name = info.channel?.name ? `#${info.channel.name}` : id;
      channels.set(id, name);
      return name;
    } catch {
      return id;
    }
  }

  const strip = (text: string) => text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();

  /** Files on the event, downloaded with the bot token (needs the files:read scope). */
  type SlackFile = { name?: string; title?: string; mimetype?: string; size?: number; url_private_download?: string; url_private?: string };
  async function files(list: SlackFile[] | undefined): Promise<InboundMessage["attachments"]> {
    if (!list?.length) return undefined;
    return Promise.all(
      list.slice(0, ATTACHMENT_LIMITS.maxFiles).map(async (f) => {
        const base = { name: f.name || f.title || "file", mimeType: f.mimetype ?? "", size: f.size ?? 0 };
        const url = f.url_private_download ?? f.url_private;
        if (!url || base.size > ATTACHMENT_LIMITS.maxFileBytes) return base;
        try {
          return { ...base, data: await download(url, { headers: { authorization: `Bearer ${botToken}` } }) };
        } catch (error) {
          host.log(`slack: could not download ${base.name}: ${(error as Error).message}${/403|401/.test(String(error)) ? " (does the app have the files:read scope? Reinstall it after adding the scope)" : ""}`);
          return base;
        }
      }),
    );
  }

  return {
    maxLength: 12_000,

    async start() {
      if (!botToken.startsWith("xoxb-")) throw new Error("Bot token must start with xoxb-");
      if (!appToken.startsWith("xapp-")) throw new Error("App-level token must start with xapp- (enable Socket Mode)");
      // Bolt verifies the token in its constructor with a promise nobody awaits, so a bad token
      // would surface as an unhandled rejection. Defer it and await init() where errors are caught.
      // Testing: SOLOAGENT_SLACK_API_URL points the Web API (and Socket Mode's apps.connections.open) at a local fake.
      const slackApiUrl = process.env.SOLOAGENT_SLACK_API_URL || undefined;
      app = new App({
        token: botToken,
        appToken,
        socketMode: true,
        logLevel: LogLevel.ERROR,
        deferInitialization: true,
        ...(slackApiUrl ? { clientOptions: { slackApiUrl: slackApiUrl.endsWith("/") ? slackApiUrl : `${slackApiUrl}/` } } : {}),
      });
      await app.init();
      const auth = await app.client.auth.test();
      botUserId = auth.user_id ?? "";

      app.event("app_mention", async ({ event, client }) => {
        if (!event.user || ("bot_id" in event && event.bot_id)) return;
        const threadTs = event.thread_ts ?? event.ts;
        const location = await channelName(client, event.channel);
        const name = await userName(client, event.user);
        const text = strip(event.text ?? "");
        const attachments = await files((event as { files?: SlackFile[] }).files);
        host.receive({
          externalKey: `${event.channel}:${threadTs}`,
          location,
          title: `${location} · ${text.slice(0, 48) || "mention"}`,
          author: { name, id: event.user, source: "slack" },
          text,
          target: { channel: event.channel, thread_ts: threadTs },
          isDirect: false,
          channel: { id: event.channel, name: location },
          ...(attachments ? { attachments } : {}),
        });
      });

      app.message(async ({ message, client }) => {
        const m = message as { channel_type?: string; subtype?: string; bot_id?: string; user?: string; text?: string; channel: string; ts: string; thread_ts?: string; files?: SlackFile[] };
        if (m.channel_type !== "im" || (m.subtype && m.subtype !== "file_share") || m.bot_id || !m.user) return;
        const name = await userName(client, m.user);
        const attachments = await files(m.files);
        host.receive({
          externalKey: m.thread_ts ? `${m.channel}:${m.thread_ts}` : m.channel,
          location: `DM with ${name}`,
          title: `DM with ${name}`,
          author: { name, id: m.user, source: "slack" },
          text: strip(m.text ?? ""),
          target: m.thread_ts ? { channel: m.channel, thread_ts: m.thread_ts } : { channel: m.channel },
          isDirect: true,
          ...(attachments ? { attachments } : {}),
        });
      });

      // Approvals: Approve / Deny buttons. Socket Mode delivers them once the app has interactivity enabled.
      app.action(/^solo_(approve|deny)$/, async ({ ack, body, action, client }) => {
        await ack();
        const value = "value" in action && typeof action.value === "string" ? action.value : "";
        const parsed = parseApprovalAction(value);
        const b = body as { user?: { id?: string }; channel?: { id?: string }; message?: { ts?: string; thread_ts?: string } };
        const userId = b.user?.id;
        if (!parsed || !userId) return;
        const name = await userName(client, userId);
        const result = await host.decide({ approvalId: parsed.id, approve: parsed.approve, user: { id: userId, name } });
        if (!result.ok && b.channel?.id) {
          await client.chat
            .postEphemeral({ channel: b.channel.id, user: userId, text: result.message, thread_ts: b.message?.thread_ts ?? b.message?.ts })
            .catch(() => {});
        }
      });

      app.error(async (error) => host.log(`slack: ${error.message}`));
      await app.start();
      host.status("connected", undefined, `@${auth.user ?? "bot"} in ${auth.team ?? "workspace"}`);
    },

    async stop() {
      await app?.stop().catch(() => {});
      app = undefined;
    },

    async post(target, markdown) {
      if (!app) throw new Error("Slack is not connected");
      const result = await app.client.chat.postMessage({
        channel: target.channel!,
        thread_ts: target.thread_ts,
        text: toSlack(markdown),
        unfurl_links: false,
      });
      return result.ts ? { ts: result.ts, channel: result.channel ?? target.channel! } : undefined;
    },

    async edit(target, handle, markdown) {
      if (!app) throw new Error("Slack is not connected");
      await app.client.chat.update({ channel: handle.channel ?? target.channel!, ts: handle.ts!, text: toSlack(markdown) });
    },

    async requestApproval(target, approvalId, markdown) {
      if (!app) throw new Error("Slack is not connected");
      const text = toSlack(markdown).slice(0, 2_900);
      const result = await app.client.chat.postMessage({
        channel: target.channel!,
        thread_ts: target.thread_ts,
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text } },
          {
            type: "actions",
            elements: [
              { type: "button", action_id: "solo_approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: approvalAction(approvalId, true) },
              { type: "button", action_id: "solo_deny", style: "danger", text: { type: "plain_text", text: "Deny" }, value: approvalAction(approvalId, false) },
            ],
          },
        ],
        unfurl_links: false,
      });
      return result.ts ? { ts: result.ts, channel: result.channel ?? target.channel! } : undefined;
    },

    async resolveApproval(target, handle, markdown) {
      if (!app) throw new Error("Slack is not connected");
      const text = toSlack(markdown).slice(0, 2_900);
      await app.client.chat.update({ channel: handle.channel ?? target.channel!, ts: handle.ts!, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
    },
  };
};
