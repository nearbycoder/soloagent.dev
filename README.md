<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" height="48" alt="soloagent">
  </picture>
</p>

<p align="center">
  <b>All your agents. One control plane.</b><br>
  Durable AI agents on the subscriptions you already pay for — answering in Slack, Discord, Telegram, webhooks, the web, and your terminal.
</p>

<p align="center">
  <a href="https://soloagent.dev">soloagent.dev</a> ·
  <a href="https://soloagent.dev/docs/">Docs</a> ·
  <a href="#deploy">Deploy anywhere</a> ·
  <a href="#terminal-ui">Terminal UI</a>
</p>

<p align="center">
  <img src="assets/demo.gif" alt="The soloagent dashboard: starting a new chat and watching the agent stream its answer" width="820">
</p>

---

soloagent is an open-source, self-hosted home for your AI agents. Give each agent a name, a personality, a model, and skills; then talk to all of them from wherever your team already is. It is built on **[Pi](https://github.com/earendil-works/pi)** — `@earendil-works/pi-ai` for model access and **`@earendil-works/pi-durable`** for durable execution — so every model turn and tool call is committed to storage *before* it is shown. Crash it, redeploy it, kill the container mid-answer: runs pick up where they stopped.

## Highlights

- **Durable by default.** Conversations, model turns, tool calls, reminders, and delegations live in Pi Durable's SQLite storage. A restart resumes unfinished work; a reminder set for next Tuesday fires next Tuesday.
- **Bring any subscription.** Sign in with **Claude Pro/Max**, **ChatGPT**, **GitHub Copilot**, **SuperGrok**, OpenRouter, and more via OAuth — or paste API keys for 30+ providers (Anthropic, OpenAI, Gemini, Mistral, Groq, DeepSeek, xAI, Bedrock, Azure, Vercel AI Gateway, …). Each agent can run on a different one. Credentials are sealed with AES-256-GCM.
- **Everywhere your team talks.**
  - **Slack** — Socket Mode (no public URL); @mention in a channel and the reply streams into the thread; DMs too.
  - **Discord** — mentions, replies, DMs; each thread is its own conversation.
  - **Telegram** — DMs, groups, forum topics.
  - **Webhooks** — synchronous answers or `callback_url`.
  - **Web dashboard** and **terminal UI**, both live.
- **Agents that work together.** Skills an agent can be granted:
  - `memory` — remember / recall / forget across every conversation
  - `web` — `web_fetch`, `web_search`
  - `delegate` — `ask_agent` hands a task to another agent through a durable child conversation
  - `schedule` — durable reminders, follow-ups, and recurring automations that survive restarts
  - `workspace` — read / write / edit / bash, starting in a per-agent folder (powerful, not a sandbox; off by default)
- **Approvals.** Agents can pause before risky tools (`bash`, `write`, `edit`, or every tool) until someone clicks **Approve** in the dashboard, the TUI (`/approve`, `/deny`), or right in the Slack, Discord, or Telegram thread. The wait is durable: it survives restarts, and an approved call runs once. On by default for agents with `workspace`.
- **Ready for teams.** Per-connector access lists (people, channels, agents), daily spend and message budgets per agent, per-person rate limits, and dashboard users with admin and member roles, invited by one-time link.
- **Files and images.** Share screenshots, photos, logs, CSVs, and code from any chat app, the dashboard (paste, drop, or 📎), or `soloagent ask --file`. Images go to the model resized; text files are inlined; files are stored on your disk, content-addressed.
- **Recurring automations.** "Every weekday at 9:00, post a standup summary in #eng." Cron or simple presets, any time zone (DST-aware), into an existing thread or a chat channel. Each one is a durable task; a run that came due while the server was down fires once on startup. Manage them on the **Automations** page, with `soloagent automations`, or by asking an agent.
- **Tools from MCP servers.** Connect any [Model Context Protocol](https://modelcontextprotocol.io) server — GitHub, Linear, Postgres, Sentry — over stdio or HTTP, and pick which agents get its tools. Large tool sets load on demand through `tool_search`.
- **Editable memory.** See, search, edit, and clear what each agent remembers from its Memory tab.
- **Steer mid-run.** Messages sent while an agent works join the running work at its next step instead of waiting for it to finish.
- **A real GUI and a real TUI.** A fast dashboard (chat with streaming, thinking, and tool cards; agent editor; subscription logins; connector setup with guides; live task graph; usage and cost) and a full-screen terminal UI built on `pi-tui`.
- **Try it with zero accounts.** A built-in demo model answers until you connect a provider.

## Quick start

**On your machine** (Node.js 22.19+):

```bash
curl -fsSL https://soloagent.dev/install.sh | sh
soloagent            # terminal UI with a private local server
soloagent serve      # web dashboard on http://localhost:7420 (soloagent token prints the login token)
```

With **Homebrew** (macOS and Linux):

```bash
brew install nearbycoder/soloagent/soloagent
```

The installer downloads the latest release and installs it with npm. To do it yourself (Windows included; `--allow-remote=root` lets npm 12 install from a URL):

```bash
npm install -g --allow-remote=root https://github.com/nearbycoder/soloagent.dev/releases/latest/download/soloagent.tgz
npx -y --allow-remote=root https://github.com/nearbycoder/soloagent.dev/releases/latest/download/soloagent.tgz   # try once
```

**With Docker** (any OS, amd64 and arm64):

```bash
docker run -d --name soloagent -p 7420:7420 -v soloagent:/data ghcr.io/nearbycoder/soloagent.dev
docker logs soloagent | grep token
```

Then sign in to a model provider from the dashboard's **Providers** page, or in the terminal with `/login anthropic`. Your default agent, `@solo`, switches from the built-in demo model to the real one automatically.

## Deploy

soloagent needs a long-running process, a persistent directory, and a port. It runs as a single instance.

<!-- TODO(railway-template): create the Railway template (2 minutes, see docs/railway-template.md), then replace
     TEMPLATE_CODE below, move the button into the Railway row of the table, and delete this comment.
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TEMPLATE_CODE?utm_medium=integration&utm_source=button&utm_campaign=soloagent)
-->

| Where | How |
|---|---|
| **Any Docker host** (VPS, home server, NAS, Coolify, Dokploy) | `docker compose up -d` with [`docker-compose.yml`](docker-compose.yml) |
| **Railway** | New project from this repo, add a volume at `/data` ([`railway.json`](railway.json)) |
| **Render** | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/nearbycoder/soloagent.dev) — Blueprint in [`render.yaml`](render.yaml) |
| **Fly.io** | `fly launch --copy-config --no-deploy`, `fly volumes create soloagent_data`, `fly deploy` ([`fly.toml`](fly.toml)) |
| **Linux server** | `npm install -g` the release plus the systemd unit in [`deploy/soloagent.service`](deploy/soloagent.service) |

Serverless and edge platforms (Vercel functions, Netlify, Cloudflare Workers, Lambda) and hosts without persistent disks can't run it. Step-by-step guides for each host: [soloagent.dev/docs/#deploy](https://soloagent.dev/docs/#deploy).

| Variable | Purpose |
|---|---|
| `SOLOAGENT_TOKEN` | Admin token for the dashboard, TUI, and API. Generated and printed on first boot if unset. |
| `SOLOAGENT_SECRET` | Seals provider credentials and bot tokens at rest. Generated and kept in the data dir if unset; keep it stable. |
| `SOLOAGENT_DATA_DIR` | Data directory. `/data` in the Docker image (mount your volume there); `~/.soloagent/data` for `soloagent serve`. |
| `PORT` | HTTP port, default `7420`. |
| `SOLOAGENT_DEMO` | `0` hides the built-in demo model. |
| `SOLOAGENT_PUBLIC_URL` | The public address printed at startup. Railway's domain is detected automatically. |
| `SOLOAGENT_BACKUP_INTERVAL` | Scheduled backups to `<data>/backups/`, e.g. `24h`. Off by default. |
| `SOLOAGENT_BACKUP_KEEP` | Scheduled backups to keep, default `7`. |
| `SOLOAGENT_UPDATE_CHECK` | `0` turns off the check for new releases. |

Connect your terminal to a deployed server:

```bash
soloagent connect https://your-solo.example.com --token "$SOLOAGENT_TOKEN"
```

> **OAuth on a remote server.** Subscription logins redirect to `localhost` on the machine that started them. When the server is remote, the dashboard shows a paste box — copy the final redirect URL (or code) from your browser and paste it in.

### Backups and upgrades

```bash
soloagent backup --out solo.tar.gz          # both databases, workspaces, files; safe while running
soloagent backup --out - | aws s3 cp - s3://my-bucket/solo.tar.gz
soloagent restore solo.tar.gz --data <dir>  # with the server stopped; --force to replace existing data
soloagent agents export > agents.json       # move agents between servers
soloagent agents import agents.json         # matched by handle; --mode skip-existing, --dry-run
```

Backups leave the credentials secret out unless you pass `--include-secret`, so a restore needs the same `SOLOAGENT_SECRET` (or the original `<data>/.secret`). The dashboard shows when a new release is out, and **Settings** shows how to upgrade for each install method. Details: [soloagent.dev/docs/#backups](https://soloagent.dev/docs/#backups).

### From source

```bash
git clone https://github.com/nearbycoder/soloagent.dev && cd soloagent.dev
npm install && npm run build      # build the web dashboard
npm start                         # http://localhost:7420
npm link -w @soloagent/cli        # optional: the soloagent command from this checkout
```

## Connect chat apps

Open **Connections** in the dashboard; each connector has a step-by-step guide.

| | What you need |
|---|---|
| **Slack** | Create an app from the bundled manifest, enable Socket Mode, and paste the `xapp-…` app token (scope `connections:write`) and `xoxb-…` bot token. Invite the bot to a channel and mention it. Apps created before `files:read` was in the manifest: add that scope and reinstall to share files. |
| **Discord** | A bot token with the *Message Content* intent enabled; invite it with the `bot` scope. |
| **Telegram** | A bot token from @BotFather (`/newbot`). |
| **Webhook** | A shared secret. `POST /api/hooks/<id>` with `x-solo-secret` and `{ "text", "thread", "user", "callback_url"?, "attachments"? }`; the answer comes back as `{ "thread", "status", "answer" }`, or is POSTed to `callback_url` as `{ "thread", "text" }`. |

Files and images people share reach the agent too: images resized for the model, text files inlined (100 KB each), notes for PDFs and other files; up to 20 MB and 10 files per message. They're stored under `<data dir>/files/`. See [Files & images](https://soloagent.dev/docs/#files).

For [approval](https://soloagent.dev/docs/#approvals) buttons, list who may press them under **Approvers** on the connector (platform user ids or display names). Slack needs **Interactivity** on; the bundled manifest enables it.

In any chat: `@coder fix the build` or `coder: fix the build` picks an agent; otherwise the connector's agent (or the default) answers. Commands: `!agents`, `!reset` (or `!new`), `!stop`, `!help`.

## Teams and access

- **Access lists.** Each connector can limit which people (platform id or name), channels (id or `#name`), and agents it serves. Empty means everyone. People who aren't allowed get one short reply, and the attempt is logged in Activity. Webhooks apply only the agent list.
- **Workspace safety.** Agents with the `workspace` skill aren't reachable from Slack, Discord, or Telegram unless the agent's chat access is turned on.
- **Budgets and rate limits.** Set a daily USD budget or message limit per agent, and messages per person per hour per connector. Over a limit, chat gets a friendly reply and the API returns `429`. Spend is recorded for every provider response.
- **Users and roles.** Invite people from **Team** with a one-time link (7 days). Members chat, view agents, and see usage; admins also manage providers, connectors, agents, and the team. The admin token stays the superuser for the CLI and API, and can be rotated from Settings unless it comes from `SOLOAGENT_TOKEN`.

Details: [soloagent.dev/docs#teams](https://soloagent.dev/docs/#teams).

## Tools (MCP)

Open **Tools** in the dashboard and add a server: a command to run over stdio (with env vars for tokens) or a remote Streamable HTTP URL (with headers). Then turn it on for an agent under **Tools from MCP servers**. Its tools appear as `mcp__<server>__<tool>`.

```bash
curl -X POST http://localhost:7420/api/mcp-servers -H "authorization: Bearer $SOLOAGENT_TOKEN" \
  -H 'content-type: application/json' -d '{"id": "github", "transport": "http",
  "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer github_pat_…"}}'
```

Env values and headers are sealed at rest and masked in the API. soloagent reconnects dropped servers with backoff, and a broken server only shows an error. stdio servers run as the soloagent user with a minimal environment, so only add ones you trust. Details and examples: [soloagent.dev/docs/#mcp](https://soloagent.dev/docs/#mcp).

## Terminal UI

```
soloagent                     open the terminal UI (local server, or your remote)
soloagent ask "<message>"     ask once and print the answer   (--agent, --thread, --json; piped input is appended, "-" = stdin only)
soloagent login [provider]    sign in with a subscription      (--key for API keys)
soloagent serve               run the server in the foreground (--port, --data, --host)
soloagent connect <url>       use a remote server              (--token)
soloagent disconnect          go back to the local server
soloagent agents | threads    list things                      (--json)
soloagent automations         list recurring automations       (--json)
soloagent token               print the local admin token
soloagent backup | restore    back up or restore all data      (--out, --include-secret / --data, --force)
soloagent agents export|import  move agents between servers    (--mode, --dry-run)
```

Inside the TUI: <kbd>Enter</kbd> send (steers while busy) · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>Esc</kbd> stop · <kbd>Ctrl</kbd>+<kbd>P</kbd> threads · <kbd>Ctrl</kbd>+<kbd>N</kbd> new · <kbd>Ctrl</kbd>+<kbd>B</kbd> sidebar · <kbd>Ctrl</kbd>+<kbd>T</kbd> thinking · <kbd>Ctrl</kbd>+<kbd>O</kbd> tool output · `/new @agent`, `/agent`, `/model`, `/login`, `/threads`, `/reset`, `/compact`, `/approve`, `/deny [reason]`, `/usage`, `/help`.

```bash
git diff | soloagent ask - --agent reviewer
```

## SDK and API

Everything the GUI and TUI do goes through a typed client, `@soloagent/client` in `packages/client` (not on npm yet; use it from a clone):

```ts
import { SoloClient } from "@soloagent/client";

const solo = new SoloClient({ baseUrl: "https://your-solo.up.railway.app", token: process.env.SOLOAGENT_TOKEN });
const thread = await solo.createThread({ agentId: "coder" });
const { answer } = await solo.ask(thread.id, "What changed in the last deploy?");

const stream = solo.connect();
stream.subscribe(thread.id);
stream.on((event) => event.type === "thread.live" && console.log(event.live.partial?.text));
```

Or embed the runtime directly:

```ts
import { SoloAgent } from "@soloagent/core";

const solo = await SoloAgent.open({ dataDir: "./.data" });
const thread = await solo.createThread({ source: "api" });
const sent = await solo.send(thread.id, { text: "hello", author: { name: "me", source: "api" } });
console.log(await sent.wait());
await solo.close();
```

REST routes live under `/api` with `Authorization: Bearer <token>` (only the WebSocket accepts `?token=`): `agents`, `threads` (`/messages`, `/ask`, `/stop`, `/reset`, `/compact`), `providers` (`/login`, `/key`), `connectors`, `schedules`, `automations` (`/run`, `/preview`), `approvals` (`/approve`, `/deny`), `usage`, `overview`, `backup`, `agents/export`, `agents/import`, `version` (no token needed), and the WebSocket at `/api/ws`. See the [docs](https://soloagent.dev/docs/).

## Architecture

```
 Slack · Discord · Telegram · Webhooks · Web GUI · TUI
                         │
            ┌────────────▼─────────────┐
            │  @soloagent/server        │  Hono REST + WebSocket
            │  @soloagent/core          │  router · agents · threads · connectors · skills
            │   └ Pi Durable Harness    │  durable conversations, tasks, tools  (SQLite)
            └────────────┬─────────────┘
                         │  @earendil-works/pi-ai
      Claude · ChatGPT · Copilot · Gemini · OpenRouter · 30+ providers
```

| Package | |
|---|---|
| `packages/core` | The runtime: Pi Durable harness, agents, threads, skills, connectors, credential sealing |
| `packages/server` | HTTP + WebSocket API, serves the GUI |
| `packages/client` | Wire protocol types and the typed SDK used by the GUI and TUI |
| `packages/web` | The dashboard (React 19, Vite, Tailwind 4) |
| `packages/cli` | The `soloagent` CLI and terminal UI (pi-tui) |
| `site/` | soloagent.dev |

## Development

```bash
npm install
npm run dev          # server with --watch on :7420 (SOLOAGENT_TOKEN=devtoken recommended)
npm run dev:web      # Vite dev server for the GUI (proxies /api)
npm test             # end-to-end runtime tests on Pi's faux provider
npm run typecheck
npm run build:npm    # bundle the publishable `soloagent` package into dist/npm
node scripts/bump-version.mjs 0.x.y # bump every version and the changelog, then tag v0.x.y (see docs/releasing.md)
git tag v0.x.y && git push --tags   # CI builds the release tarball, Docker image, and (with NPM_TOKEN) publishes to npm
# soloagent.dev deploys from site/ on Vercel automatically when a push to main changes it
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout, code style, and PR checklist, and [docs/releasing.md](docs/releasing.md) for what a `v*` tag publishes (GitHub release, Docker image, npm with `NPM_TOKEN`, Homebrew with `HOMEBREW_TAP_TOKEN`).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

- Every API call needs the admin token or a signed-in user's session, except inbound webhooks, which use their own secret. Sessions live in an httpOnly cookie; passwords are hashed with scrypt. Roles are enforced on the server.
- Provider credentials, bot tokens, and webhook secrets are sealed with AES-256-GCM using `SOLOAGENT_SECRET`, or a generated secret in the data directory.
- The `workspace` skill runs shell commands on the server, starting in a per-agent folder, with the server's permissions. It is not a sandbox. Grant it only to agents you trust, on a deployment you're comfortable with. Chat apps can't reach such an agent unless you turn on its chat access.
- Third-party subscriptions have their own terms. Use subscription logins for your own personal use.

## License

MIT © Josh Hamilton and contributors. Built on [Pi](https://github.com/earendil-works/pi) by Earendil. Provider and product names are trademarks of their respective owners.
