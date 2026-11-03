// Bundles the CLI, server, core, and client into one ESM file and assembles a publishable
// `soloagent` package in dist/npm, with the web GUI beside it. Third-party deps stay external.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "dist/npm");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const rootPkg = read("package.json");

const deps = {};
for (const ws of ["client", "core", "server", "cli"]) {
  for (const [name, version] of Object.entries(read(`packages/${ws}/package.json`).dependencies ?? {})) {
    if (!name.startsWith("@soloagent/")) deps[name] = version;
  }
}

if (!existsSync(join(root, "packages/web/dist/index.html"))) {
  console.error("Build the web GUI first: npm run build -w @soloagent/web");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, "packages/cli/src/main.ts")],
  outfile: join(out, "soloagent.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  // Workspace packages are bundled; everything else resolves from node_modules at runtime.
  plugins: [
    {
      name: "bundle-workspace",
      setup(b) {
        b.onResolve({ filter: /^@soloagent\// }, (args) => ({ path: join(root, "packages", args.path.split("/")[1], "src/index.ts") }));
      },
    },
  ],
  legalComments: "none",
});

cpSync(join(root, "packages/web/dist"), join(out, "web"), { recursive: true });
cpSync(join(root, "README.md"), join(out, "README.md"));
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "soloagent",
      version: rootPkg.version,
      description: rootPkg.description,
      type: "module",
      license: "MIT",
      homepage: "https://soloagent.dev",
      repository: { type: "git", url: "git+https://github.com/nearbycoder/soloagent.dev.git" },
      bin: { soloagent: "soloagent.mjs" },
      files: ["soloagent.mjs", "web", "README.md", "LICENSE"],
      engines: { node: ">=22.19.0" },
      keywords: ["ai", "agents", "slack", "discord", "telegram", "claude", "chatgpt", "pi", "durable", "tui"],
      dependencies: deps,
    },
    null,
    2,
  ),
);
console.log(`built ${out} (${Object.keys(deps).length} runtime deps)`);
