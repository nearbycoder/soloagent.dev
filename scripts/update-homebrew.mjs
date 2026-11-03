#!/usr/bin/env node
// Writes the Homebrew formula for a soloagent release: points `url` at the versioned release
// asset (soloagent-<version>.tgz) and fills in its sha256.
//
//   node scripts/update-homebrew.mjs <formula.rb> [--version 0.1.2] [--tarball dist/npm/soloagent-0.1.2.tgz]
//
// Without --tarball the asset is downloaded from the GitHub release, so the hash is of exactly
// what users will fetch. --version defaults to the root package.json version. The release job
// runs this against a checkout of github.com/nearbycoder/homebrew-soloagent.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const REPO = "nearbycoder/soloagent.dev";
const root = new URL("..", import.meta.url).pathname;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { version: { type: "string" }, tarball: { type: "string" }, help: { type: "boolean", short: "h" } },
});
const [formulaPath] = positionals;
if (values.help || !formulaPath) {
  console.error("usage: node scripts/update-homebrew.mjs <formula.rb> [--version <x.y.z>] [--tarball <file.tgz>]");
  process.exit(values.help ? 0 : 1);
}

const version = (values.version ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Not a stable x.y.z version: ${version}`);
  process.exit(1);
}
const url = `https://github.com/${REPO}/releases/download/v${version}/soloagent-${version}.tgz`;

let bytes;
if (values.tarball) {
  bytes = readFileSync(values.tarball);
} else {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`GET ${url} -> ${res.status}`);
    process.exit(1);
  }
  bytes = Buffer.from(await res.arrayBuffer());
}
const sha256 = createHash("sha256").update(bytes).digest("hex");

const formula = `class Soloagent < Formula
  desc "Self-hosted control plane for durable AI agents"
  homepage "https://soloagent.dev"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/soloagent --version")
    assert_match "soloagent", shell_output("#{bin}/soloagent --help")
  end
end
`;

mkdirSync(dirname(formulaPath), { recursive: true });
writeFileSync(formulaPath, formula);
console.log(`${formulaPath}: soloagent ${version} sha256 ${sha256}`);
