# Contributing to soloagent

Thanks for helping. Bug reports, docs fixes, connectors, skills, and dashboard polish are all welcome. For anything bigger than a small fix, open an issue first so we can agree on the shape before you spend the time.

## Dev setup

You need **Node.js 22.19+**. Node 24+ is recommended, since it runs `.ts` files directly; the repo runs TypeScript with no build step except for the web dashboard. You also need npm.

```bash
git clone https://github.com/nearbycoder/soloagent.dev && cd soloagent.dev
npm install
npm run build                 # build the web dashboard once (packages/web/dist)
SOLOAGENT_TOKEN=devtoken npm run dev   # server with --watch on http://localhost:7420
npm run dev:web               # optional: Vite dev server for the dashboard, proxies /api to :7420
npm run tui                   # the terminal UI against a local server
```

Data goes to `./.data` (gitignored). Point `SOLOAGENT_DATA_DIR` somewhere else to keep a separate playground, and delete the folder to start fresh.

### The demo model

You don't need any provider account to develop. A built-in **demo model** (`packages/core/src/demo.ts`, built on Pi's faux provider) answers until you connect a real provider. It streams thinking and markdown, so chat, streaming, and tool-card UI can be worked on offline. Try "hi" or "what is soloagent?". Set `SOLOAGENT_DEMO=0` to hide it.

## Project layout

| Path | What lives there |
|---|---|
| `packages/core` | The runtime: Pi Durable harness, agents, threads, skills, connectors (Slack, Discord, Telegram, webhook), credential sealing, the demo model |
| `packages/server` | Hono HTTP + WebSocket API; serves the built dashboard |
| `packages/client` | Wire-protocol types and the typed SDK used by the dashboard and the TUI |
| `packages/web` | The dashboard (React 19, Vite, Tailwind 4) |
| `packages/cli` | The `soloagent` CLI and terminal UI (pi-tui) |
| `site/` | soloagent.dev landing page and docs (static HTML) |
| `scripts/` | npm bundling, site stamping, version bumps, Homebrew formula |
| `docs/` | Maintainer docs: [releasing](docs/releasing.md), [Railway template](docs/railway-template.md) |
| `deploy/`, `Dockerfile`, `docker-compose.yml`, `render.yaml`, `fly.toml`, `railway.json` | Ways to run it |

## Tests and checks

```bash
npm test             # node:test, end-to-end runtime tests on Pi's faux provider
npm run typecheck    # tsc for the Node packages and the dashboard
npm run build:npm    # bundle the publishable package into dist/npm
```

CI runs all three on every pull request. Tests live in `packages/*/test/**/*.test.ts` and use `node:test` with `node:assert/strict`. Prefer end-to-end tests through `SoloAgent.open()` with a faux provider, as in `packages/core/test/runtime.test.ts`, over mocking internals. A bug fix should come with a test that fails without it.

## Code style

- **Erasable TypeScript only.** Node runs the source directly by stripping types, so `tsconfig.base.json` sets `erasableSyntaxOnly` and `verbatimModuleSyntax`. That means no `enum`, no `namespace`, no constructor parameter properties, and no `import x = require()`. Use `import type` for type-only imports, and include the `.ts` extension in relative imports.
- `strict` and `noUncheckedIndexedAccess` are on. Handle the `undefined`, and use `!` only where it is obviously safe.
- Keep dependencies few. Every runtime dependency ships to every user (`scripts/build-npm.mjs` keeps third-party packages external).
- Follow the formatting around you: two-space indent, double quotes, semicolons, trailing commas, lines of about 140 characters.
- Comments explain *why*, not *what*.
- User-facing text (dashboard, TUI, docs) is plain and direct. If you change a command, route, flag, or env var, update `README.md` and `site/docs/index.html` in the same PR.

## Pull requests

- One focused change per PR, with a clear title and a description of *what* and *why*. Screenshots or a short clip help for UI changes.
- `npm run typecheck`, `npm test`, and `npm run build:npm` pass locally.
- New behavior has tests. Docs are updated where users would look.
- Add a line under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md) for anything users would notice.
- Don't bump versions. Maintainers do that when releasing ([docs/releasing.md](docs/releasing.md)).
- Be kind in reviews. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security issue? Please don't open a public issue. See [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
