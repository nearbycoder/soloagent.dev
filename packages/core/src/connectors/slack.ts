import bolt from "@slack/bolt";
import type { ConnectorDriver, DriverFactory } from "./types.ts";
import { toSlack } from "./format.ts";

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

  return {
    maxLength: 12_000,

    async start() {
      if (!botToken.startsWith("xoxb-")) throw new Error("Bot token must start with xoxb-");
      if (!appToken.startsWith("xapp-")) throw new Error("App-level token must start with xapp- (enable Socket Mode)");
      // Bolt verifies the token in its constructor with a promise nobody awaits, so a bad token
      // would surface as an unhandled rejection. Defer it and await init() where errors are caught.
      app = new App({ token: botToken, appToken, socketMode: true, logLevel: LogLevel.ERROR, deferInitialization: true });
      await app.init();
      const auth = await app.client.auth.test();
      botUserId = auth.user_id ?? "";

      app.event("app_mention", async ({ event, client }) => {
        if (!event.user || ("bot_id" in event && event.bot_id)) return;
        const threadTs = event.thread_ts ?? event.ts;
        const location = await channelName(client, event.channel);
        const name = await userName(client, event.user);
        const text = strip(event.text ?? "");
        host.receive({
          externalKey: `${event.channel}:${threadTs}`,
          location,
          title: `${location} · ${text.slice(0, 48) || "mention"}`,
          author: { name, id: event.user, source: "slack" },
          text,
          target: { channel: event.channel, thread_ts: threadTs },
          isDirect: false,
        });
      });

      app.message(async ({ message, client }) => {
        const m = message as { channel_type?: string; subtype?: string; bot_id?: string; user?: string; text?: string; channel: string; ts: string; thread_ts?: string };
        if (m.channel_type !== "im" || m.subtype || m.bot_id || !m.user) return;
        const name = await userName(client, m.user);
        host.receive({
          externalKey: m.thread_ts ? `${m.channel}:${m.thread_ts}` : m.channel,
          location: `DM with ${name}`,
          title: `DM with ${name}`,
          author: { name, id: m.user, source: "slack" },
          text: strip(m.text ?? ""),
          target: m.thread_ts ? { channel: m.channel, thread_ts: m.thread_ts } : { channel: m.channel },
          isDirect: true,
        });
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
  };
};
