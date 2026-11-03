#!/usr/bin/env node
// Sets the soloagent version everywhere it lives, and turns the CHANGELOG's Unreleased section
// into a dated release section.
//
//   node scripts/bump-version.mjs 0.2.0            # or 0.2.0-rc.1
//   node scripts/bump-version.mjs 0.2.0 --dry-run  # print what would change
//
// Touches: package.json, packages/*/package.json, e2e/package.json, package-lock.json (workspace versions),
// packages/core/src/runtime.ts (VERSION), and CHANGELOG.md. Then review, commit, and tag
// (see docs/releasing.md).
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const REPO_URL = "https://github.com/nearbycoder/soloagent.dev";
const root = new URL("..", import.meta.url).pathname;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" }, date: { type: "string" }, help: { type: "boolean", short: "h" } },
});
const version = positionals[0]?.replace(/^v/, "");
if (values.help || !version) {
  console.error("usage: node scripts/bump-version.mjs <version> [--dry-run] [--date YYYY-MM-DD]");
  process.exit(values.help ? 0 : 1);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not a semver version: ${version}`);
  process.exit(1);
}
const dryRun = values["dry-run"] === true;
const date = values.date ?? new Date().toISOString().slice(0, 10);

const changes = [];
function update(rel, fn) {
  const file = join(root, rel);
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after === before) return;
  changes.push(rel);
  if (!dryRun) writeFileSync(file, after);
}
// Rewrites only the top-level "version" field so the file's formatting is left alone.
const setPkgVersion = (text) => text.replace(/^(\s{2}"version":\s*")[^"]*(")/m, `$1${version}$2`);

const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
// Workspace dirs: packages/* plus e2e/.
const workspaces = [
  ...readdirSync(join(root, "packages"))
    .filter((d) => existsSync(join(root, "packages", d, "package.json")))
    .map((d) => `packages/${d}`),
  ...(existsSync(join(root, "e2e", "package.json")) ? ["e2e"] : []),
];

update("package.json", setPkgVersion);
for (const ws of workspaces) update(`${ws}/package.json`, setPkgVersion);

update("package-lock.json", (text) => {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  for (const ws of workspaces) {
    if (lock.packages?.[ws]) lock.packages[ws].version = version;
  }
  return `${JSON.stringify(lock, null, 2)}\n`;
});

update("packages/core/src/runtime.ts", (text) => {
  const next = text.replace(/^export const VERSION = "[^"]*";/m, `export const VERSION = "${version}";`);
  if (next === text && !text.includes(`export const VERSION = "${version}";`)) {
    throw new Error("packages/core/src/runtime.ts: no `export const VERSION = \"…\";` line found");
  }
  return next;
});

update("CHANGELOG.md", (text) => {
  if (text.includes(`## [${version}]`)) return text;
  const heading = "## [Unreleased]";
  if (!text.includes(heading)) throw new Error("CHANGELOG.md: no `## [Unreleased]` section found");
  const placeholder = "- _Nothing yet. Add entries under Added / Changed / Fixed / Removed / Security as you go._";
  // Unreleased entries become the new version's entries. A fresh Unreleased section goes above.
  let next = text.replace(heading, `${heading}\n\n${placeholder}\n\n## [${version}] - ${date}`);
  // Drop the placeholder line from the section that was just released.
  const releasedAt = next.indexOf(`## [${version}]`);
  next = next.slice(0, releasedAt) + next.slice(releasedAt).replace(`${placeholder}\n\n`, "");
  // Compare links at the bottom.
  next = next.replace(
    /^\[Unreleased\]: .*$/m,
    `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD\n[${version}]: ${REPO_URL}/compare/v${current}...v${version}`,
  );
  return next;
});

console.log(`${dryRun ? "would bump" : "bumped"} ${current} -> ${version}`);
for (const c of changes) console.log(`  ${c}`);
if (!dryRun) console.log(`\nNext: review CHANGELOG.md, commit, then: git tag v${version} && git push origin v${version}`);
