import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const TOKEN = "e2e-token";

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

/**
 * Builds the dashboard, then runs the real server (packages/server/src/main.ts) on a free port with a fresh data
 * dir, a fixed admin token, and the built-in demo model. Returns the teardown.
 */
export default async function globalSetup() {
  execSync("npm run build -w @soloagent/web", { cwd: ROOT, stdio: "inherit" });

  const dataDir = mkdtempSync(join(tmpdir(), "solo-e2e-"));
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const server = spawn(process.execPath, ["packages/server/src/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SOLOAGENT_DATA_DIR: dataDir,
      SOLOAGENT_TOKEN: TOKEN,
      SOLOAGENT_SECRET: "e2e-secret",
      SOLOAGENT_DEMO: "1",
      SOLOAGENT_UPDATE_CHECK: "0",
      // Invite links use the origin the browser came in on.
      SOLOAGENT_PUBLIC_URL: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((done) => server.once("exit", (code) => done(code)));

  const deadline = Date.now() + 30_000;
  for (;;) {
    const ok = await fetch(`${url}/healthz`).then((r) => r.ok, () => false);
    if (ok) break;
    if (server.exitCode !== null || Date.now() > deadline) {
      server.kill("SIGKILL");
      throw new Error(`soloagent did not start on ${url}:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.env.SOLOAGENT_E2E_URL = url;
  process.env.SOLOAGENT_E2E_DATA_DIR = dataDir;

  return async () => {
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
    rmSync(dataDir, { recursive: true, force: true });
    if (process.env.SOLOAGENT_E2E_SHOW_SERVER_LOG) console.log(output);
  };
}
