# Changelog

All notable changes to soloagent are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- _Nothing yet. Add entries under Added / Changed / Fixed / Removed / Security as you go._

## [0.2.0] - 2026-11-03

### Added

- **Tool approvals.** Per-agent policy (off, risky tools, every tool). Waiting tool calls are durable and survive restarts. Approve or deny in the dashboard, the TUI (`/approve`, `/deny`), or with buttons in Slack, Discord, and Telegram, limited to the people you name. Unanswered requests are denied after a timeout. The risky list accepts prefixes such as `mcp__github__*`.
- **Teams.** Dashboard users with admin and member roles, invited by one-time link. The admin token can be rotated from Settings. Per-connector access lists for people, channels, and agents. Daily spend and message budgets per agent, per-person hourly rate limits, and a `429` from the API when a limit is hit. Agents with the workspace skill are unreachable from chat apps unless you allow it.
- **MCP servers.** Connect any Model Context Protocol server over stdio or Streamable HTTP from the new **Tools** page, and pick which agents get its tools. Env values and headers are sealed at rest. Large tool sets load on demand through `tool_search`. Dropped servers reconnect with backoff.
- **Memory editor.** A Memory tab per agent: search, add, edit, delete, and clear everything it remembers.
- **Recurring automations.** Cron or simple presets in any time zone, DST-aware, posting into a thread or a chat channel. Each one is a durable task.
- **Files and images.** Share screenshots, photos, logs, and code from chat apps, the dashboard (paste, drop, or the paperclip), or `soloagent ask --file`. Images reach the model resized and text files are inlined.
- **Backups and export.** `soloagent backup` and `soloagent restore`, scheduled backups (`SOLOAGENT_BACKUP_INTERVAL`, `SOLOAGENT_BACKUP_KEEP`), a backup download in Settings, and agent export/import by handle with a dry run.
- **Upgrade notices** in the dashboard, the TUI, and `soloagent --version`. Turn them off with `SOLOAGENT_UPDATE_CHECK=0`.
- **Distribution.** Homebrew (`brew install nearbycoder/soloagent/soloagent`), npm publishing from tagged releases (when the repo has an `NPM_TOKEN`), and a Railway template guide.
- **Repo hygiene.** CONTRIBUTING, SECURITY, a code of conduct, issue and PR templates, and Dependabot.
- **Tests.** Connector integration tests against fake Slack (Web API and Socket Mode) and Telegram servers, Discord driver tests, and Playwright end-to-end tests of the dashboard in CI.

### Fixed

- A fast answer in Slack, Discord, or Telegram no longer arrives as a second message under a "thinking…" placeholder that never updates.

### Security

- Removing a user, signing out, or rotating the admin token closes that credential's open WebSockets right away. A role change makes the dashboard reconnect with the new permissions.
- Writes to MCP servers, memories, automations, approval settings, backups, and agent import are admin-only.

## [0.1.1] - 2026-11-02

### Fixed

- Slack: a bad token no longer crashes the server on every boot. Bolt's token check is awaited inside connector error handling, and the server logs stray promise rejections instead of exiting.
- Model auto-assignment never overrides a model chosen on purpose.
- `!reset @coder …` routes to the named agent.
- Piped stdin works with `soloagent ask "…"`.
- `soloagent token` honors `SOLOAGENT_DATA_DIR`.
- The installer works with npm 12, which blocks installs from a URL by default. It downloads the release tarball and installs the local file. Direct `npm`/`npx` commands in the docs pass `--allow-remote=root`.
- Dashboard: "load earlier" keeps your place, popovers fit the viewport, and stopped runs read as stopped. Errors show once, the stray 1969 date dividers are gone, contrast is higher, and each route has its own tab title.

### Changed

- Webhook secrets are compared in constant time.
- The systemd unit takes `PORT` and the data directory from its environment.
- The default agent is seeded with the new brand colors.
- Workspace packages depend on each other with `*`, so version bumps resolve locally.
- Docs and site: every documented command, route, payload, and keybinding was checked against the build. Webhook responses, the CLI table, TUI keys and slash commands, environment variables, and the durability wording were corrected. Copy buttons copy only runnable commands.

### Added

- The Docker workflow boots the published image and checks `/healthz` and the API.

## [0.1.0] - 2026-11-02

First public release.

### Added

- **Core runtime** on Pi Durable: agents, threads, skills (`memory`, `web`, `delegate`, `schedule`, `workspace`), and durable conversations, tool calls, reminders, and delegations that resume after a restart.
- **Connectors** for Slack (Socket Mode), Discord, Telegram, and webhooks, with sealed (AES-256-GCM) bot tokens and provider credentials.
- **Providers:** subscription logins (Claude Pro/Max, ChatGPT, GitHub Copilot, SuperGrok, and more) and API keys for 30+ providers, plus a built-in demo model.
- **Server:** a Hono REST and WebSocket API. **Client SDK:** `@soloagent/client`.
- **Web dashboard** (React 19): streaming chat with thinking and tool cards, an agent editor, subscriptions, connections, activity, and usage.
- **CLI and terminal UI** on pi-tui, running embedded or against a remote server.
- **Deploy anywhere:** a multi-arch Docker image on GHCR, `docker-compose.yml`, Railway (`railway.json`), Render (`render.yaml`), Fly.io (`fly.toml`), a systemd unit, and the `soloagent.dev/install.sh` installer.
- **CI and releases:** typecheck, tests, and npm bundle on every push. Tagged releases attach `soloagent.tgz` and publish to npm when `NPM_TOKEN` is set.
- **soloagent.dev** landing page and docs, plus the paper/ink/lime brand.

### Fixed

- Connectors whose sealed tokens can't be decrypted (because `SOLOAGENT_SECRET` changed) are marked as needing new tokens instead of crashing the server on boot.

[Unreleased]: https://github.com/nearbycoder/soloagent.dev/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nearbycoder/soloagent.dev/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/nearbycoder/soloagent.dev/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/nearbycoder/soloagent.dev/releases/tag/v0.1.0
