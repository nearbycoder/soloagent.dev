import type { ConnectorKind, ConnectorKindInfo } from "@soloagent/client";
import { discordDriver } from "./discord.ts";
import { slackDriver } from "./slack.ts";
import { telegramDriver } from "./telegram.ts";
import type { DriverFactory } from "./types.ts";
import { webhookDriver } from "./webhook.ts";

export const SLACK_MANIFEST = `display_information:
  name: Solo
  description: Your agents, on soloagent.dev
  background_color: "#0b0b12"
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Solo
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:read
      - files:read
      - groups:read
      - im:history
      - im:read
      - im:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false`;

export const CONNECTOR_KINDS: ConnectorKindInfo[] = [
  {
    kind: "slack",
    name: "Slack",
    tagline: "Mention your agents in any channel or DM them. Replies stream into threads.",
    fields: [
      { key: "botToken", label: "Bot token", secret: true, placeholder: "xoxb-…", help: "OAuth & Permissions → Bot User OAuth Token" },
      { key: "appToken", label: "App-level token", secret: true, placeholder: "xapp-…", help: "Basic Information → App-Level Tokens (scope connections:write)" },
    ],
    setup: `1. Go to **https://api.slack.com/apps** → **Create New App** → **From a manifest**, pick your workspace, and paste the manifest below.
2. **Basic Information → App-Level Tokens → Generate**: add the \`connections:write\` scope. Copy the \`xapp-…\` token.
3. **Install App** to your workspace and copy the **Bot User OAuth Token** (\`xoxb-…\`).
4. Paste both tokens here. Invite the bot to a channel with \`/invite @Solo\`, then mention it.

Socket Mode means no public URL is needed — it works on Railway and on your laptop alike. The manifest turns on **Interactivity**, which the Approve / Deny buttons of tool approvals need; for an app made from an older manifest, switch it on under **Interactivity & Shortcuts** (no request URL is needed with Socket Mode).

Files and images people share reach the agent through the \`files:read\` scope. Apps created before it was added: add \`files:read\` under **OAuth & Permissions → Scopes**, then reinstall the app.

\`\`\`yaml
${SLACK_MANIFEST}
\`\`\``,
  },
  {
    kind: "discord",
    name: "Discord",
    tagline: "Talk to agents with @mentions, replies, and DMs on your servers.",
    fields: [{ key: "botToken", label: "Bot token", secret: true, placeholder: "MTEx…", help: "Developer Portal → your app → Bot → Reset Token" }],
    setup: `1. Open **https://discord.com/developers/applications** → **New Application**.
2. **Bot** tab: click **Reset Token** and copy it. Turn on **Message Content Intent** under *Privileged Gateway Intents*.
3. **OAuth2 → URL Generator**: scopes \`bot\`; permissions *Send Messages*, *Send Messages in Threads*, *Read Message History*, *View Channels*. Open the URL to add the bot to your server.
4. Paste the token here. Mention the bot, reply to it, or DM it.`,
  },
  {
    kind: "telegram",
    name: "Telegram",
    tagline: "A private Telegram bot for your agents, in DMs and groups.",
    fields: [{ key: "botToken", label: "Bot token", secret: true, placeholder: "123456:ABC-…", help: "From @BotFather" }],
    setup: `1. Message **@BotFather** on Telegram and send \`/newbot\`.
2. Pick a name and username; BotFather replies with a token.
3. Paste the token here, then message your bot.
4. For groups: add the bot and mention it (or reply to it). Use \`/setprivacy\` in BotFather to control what it sees.`,
  },
  {
    kind: "webhook",
    name: "Webhook",
    tagline: "Wire agents into anything that can send an HTTP request.",
    fields: [
      { key: "secret", label: "Shared secret", secret: true, placeholder: "a long random string", help: "Callers send it as the x-solo-secret header" },
    ],
    setup: `Send messages with a POST:

\`\`\`bash
curl -X POST https://YOUR-SOLO/api/hooks/CONNECTOR_ID \\
  -H 'x-solo-secret: YOUR_SECRET' -H 'content-type: application/json' \\
  -d '{"text": "@coder what changed in the last deploy?", "thread": "deploys", "user": "ci"}'
\`\`\`

- Without \`callback_url\`, the request waits for the answer and returns \`{ "thread", "status", "answer" }\`.
- With \`callback_url\`, it returns \`202\` at once and POSTs \`{ "thread", "text" }\` there, with the same \`x-solo-secret\` header, when the agent answers.
- \`thread\` keeps a conversation going across requests; omit it for a one-off.`,
  },
];

export const DRIVERS: Record<ConnectorKind, DriverFactory> = {
  slack: slackDriver,
  discord: discordDriver,
  telegram: telegramDriver,
  webhook: webhookDriver,
};

export function kindInfo(kind: string): ConnectorKindInfo | undefined {
  return CONNECTOR_KINDS.find((k) => k.kind === kind);
}
