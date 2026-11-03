# Releasing soloagent

Pushing a `v*` tag runs the whole release. A maintainer only bumps the version, writes the changelog, and tags.

## Cut a release

1. Start from an up-to-date `main` with green CI.
2. Bump the version everywhere:

   ```bash
   node scripts/bump-version.mjs 0.2.0     # --dry-run to preview; pre-releases like 0.2.0-rc.1 work too
   ```

   The script updates every place the version lives:

   | File | What changes |
   |---|---|
   | `package.json` | `version` |
   | `packages/*/package.json` | `version` in each workspace (`cli`, `client`, `core`, `server`, `web`) |
   | `package-lock.json` | the root and workspace `version` entries |
   | `packages/core/src/runtime.ts` | `export const VERSION = "…"` (reported by `/api/overview` and the dashboard) |
   | `CHANGELOG.md` | `## [Unreleased]` becomes `## [0.2.0] - <today>`, a fresh Unreleased section goes above it, and the compare links at the bottom are updated |

   The CLI reads its version from `package.json`, so `soloagent --version` follows automatically.
3. Read `CHANGELOG.md` and tidy the new section. Then check that everything still builds:

   ```bash
   npm run typecheck && npm test && npm run build:npm
   ```

4. Commit and tag:

   ```bash
   git commit -am "Release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```

## What the tag triggers

| Workflow | Job | Result | Needs |
|---|---|---|---|
| `release.yml` | `release` | Builds `dist/npm`, packs it, and creates a GitHub Release with notes and two assets: `soloagent.tgz` (stable name, so `releases/latest/download/soloagent.tgz` and `install.sh` always get the newest) and `soloagent-<version>.tgz` | nothing |
| `release.yml` | `release` → *npm publish* step | `npm publish --access public` of `dist/npm` as `soloagent` | the `NPM_TOKEN` secret |
| `release.yml` | `homebrew` | Runs `scripts/update-homebrew.mjs` against [nearbycoder/homebrew-soloagent](https://github.com/nearbycoder/homebrew-soloagent), which points `Formula/soloagent.rb` at `soloagent-<version>.tgz` and sets its sha256, then pushes. Skipped for pre-release tags (`-rc.1` and similar). | the `HOMEBREW_TAP_TOKEN` secret |
| `docker.yml` | `image`, `smoke` | Pushes `ghcr.io/nearbycoder/soloagent.dev` tagged `<version>`, `<major>.<minor>`, and `sha-<short>` (`latest` follows `main`), then boots it and checks `/healthz` | nothing (uses `GITHUB_TOKEN`) |

Without a secret, its step is skipped and the rest of the release still succeeds.

## Secrets

Set these under **Settings → Secrets and variables → Actions** in `nearbycoder/soloagent.dev`.

| Secret | Enables | How to make it |
|---|---|---|
| `NPM_TOKEN` | Publishing `soloagent` to npm | On npmjs.com: **Access Tokens → Generate New Token → Granular**, with read and write on the `soloagent` package. For the very first publish, the package doesn't exist yet: use a token with "all packages" write, or publish once by hand (`cd dist/npm && npm publish --access public`), then narrow the token. |
| `HOMEBREW_TAP_TOKEN` | Pushing the formula update to the tap | A fine-grained GitHub PAT with **Contents: Read and write** on `nearbycoder/homebrew-soloagent` only, or a classic PAT with `repo` scope. |

## Homebrew notes

- Update the tap by hand: clone the tap next to this repo, then run `node scripts/update-homebrew.mjs ../homebrew-soloagent/Formula/soloagent.rb --version 0.2.0` and commit. Without `--tarball`, the script downloads the release asset and hashes it.
- The tap's own CI (`brew audit --strict --new`, install from source, `brew test`) runs on every push and daily.
- Homebrew installs npm packages with a one-day release cooldown (`--min-release-age=1`). If a release bumps a dependency that was published less than 24 hours earlier, `brew install soloagent` fails with `ETARGET … with a date before …` until a day has passed. npm, the installer, and Docker are unaffected. When this happens, wait a day before announcing the Homebrew upgrade.

## After the release

- Check the [release page](https://github.com/nearbycoder/soloagent.dev/releases), that `curl -fsSL https://soloagent.dev/install.sh | sh` installs the new version, and that `docker pull ghcr.io/nearbycoder/soloagent.dev:<version>` works.
- If the site changed, deploy it: `npm run deploy:site`.
