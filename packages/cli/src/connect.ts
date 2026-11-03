import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";
import { SoloClient } from "@soloagent/client";
import { clearRuntime, loadConfig, loadRuntime, paths, saveRuntime } from "./config.ts";

export type ConnectionMode = "local" | "remote";

export type Connection = {
  client: SoloClient;
  /** "local": a server on this machine (embedded or `soloagent serve`); "remote": anywhere else. */
  mode: ConnectionMode;
  /** True when this process started the server itself. */
  embedded: boolean;
  url: string;
  /** Short label for headers, e.g. "local" or "solo.example.com". */
  label: string;
  close: () => Promise<void>;
};

export type ConnectOptions = {
  url?: string;
  token?: string;
  /** Called before an embedded server starts, e.g. to print "starting…". */
  onEmbeddedStart?: () => void;
};

/** Append a line to ~/.soloagent/soloagent.log. Never throws. */
export function logToFile(message: string) {
  try {
    mkdirSync(dirname(paths.log), { recursive: true });
    appendFileSync(paths.log, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break the CLI
  }
}

let restoreConsole: (() => void) | undefined;

/**
 * Route console output and process warnings to the log file. Used while the TUI owns the screen
 * and whenever an embedded server runs, so stdout stays clean for pipes.
 */
export function silenceConsole(): () => void {
  if (restoreConsole) return restoreConsole;
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const original = Object.fromEntries(methods.map((m) => [m, console[m]])) as Record<(typeof methods)[number], (...args: unknown[]) => void>;
  for (const m of methods) console[m] = (...args: unknown[]) => logToFile(`[${m}] ${format(...args)}`);
  const warningListeners = process.listeners("warning");
  process.removeAllListeners("warning");
  const onWarning = (warning: Error) => logToFile(`[warning] ${warning.name}: ${warning.message}`);
  process.on("warning", onWarning);
  restoreConsole = () => {
    for (const m of methods) console[m] = original[m];
    process.off("warning", onWarning);
    for (const listener of warningListeners) process.on("warning", listener);
    restoreConsole = undefined;
  };
  return restoreConsole;
}

function hostLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Work out which server to talk to: `--url/--token`, then SOLOAGENT_URL/SOLOAGENT_TOKEN, then
 * ~/.soloagent/config.json, then a local server another soloagent process already runs, and
 * finally an embedded server started in this process with ~/.soloagent/data.
 */
export async function resolveConnection(options: ConnectOptions = {}): Promise<Connection> {
  const config = loadConfig();
  const envUrl = process.env.SOLOAGENT_URL || undefined;
  const envToken = process.env.SOLOAGENT_TOKEN || undefined;
  const url = options.url ?? envUrl ?? config.url;

  if (url) {
    const tokenFor = config.url && sameServer(config.url, url) ? config.token : undefined;
    const token = options.token ?? envToken ?? tokenFor;
    const client = new SoloClient({ baseUrl: url, token });
    const local = isLoopback(url);
    return { client, mode: local ? "local" : "remote", embedded: false, url, label: local ? "local" : hostLabel(url), close: async () => {} };
  }

  const runtime = loadRuntime();
  if (runtime) {
    const client = new SoloClient({ baseUrl: runtime.url, token: runtime.token });
    const alive = await client.me().then(
      () => true,
      () => false,
    );
    if (alive) return { client, mode: "local", embedded: false, url: runtime.url, label: "local", close: async () => {} };
  }

  return startEmbedded(options);
}

function sameServer(a: string, b: string) {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

async function startEmbedded(options: ConnectOptions): Promise<Connection> {
  options.onEmbeddedStart?.();
  const restore = silenceConsole();
  const { startServer } = await import("@soloagent/server");
  const server = await startServer({
    dataDir: paths.data,
    port: 0,
    host: "127.0.0.1",
    quiet: true,
    log: (message: string) => logToFile(`[solo] ${message}`),
  });
  saveRuntime({ url: server.url, token: server.solo.adminToken, pid: process.pid, dataDir: paths.data, startedAt: Date.now() });
  const client = new SoloClient({ baseUrl: server.url, token: server.solo.adminToken });
  let closed = false;
  return {
    client,
    mode: "local",
    embedded: true,
    url: server.url,
    label: "local",
    close: async () => {
      if (closed) return;
      closed = true;
      clearRuntime();
      await server.close().catch((error: unknown) => logToFile(`close: ${String(error)}`));
      restore();
    },
  };
}
