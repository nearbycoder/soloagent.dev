# Changelog

All notable changes to soloagent are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- _Nothing yet. Add entries under Added / Changed / Fixed / Removed / Security as you go._

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

[Unreleased]: https://github.com/nearbycoder/soloagent.dev/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/nearbycoder/soloagent.dev/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/nearbycoder/soloagent.dev/releases/tag/v0.1.0
