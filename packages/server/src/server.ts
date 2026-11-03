import type { IncomingMessage, Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { parseDuration, scheduleBackups, SERVER_LOCK, SoloAgent, UpdateChecker, updateCheckEnabled, VERSION, type SoloAgentOptions } from "@soloagent/core";
import type { Actor, ClientEvent, ServerEvent } from "@soloagent/client";
import { createApp } from "./app.ts";
import { authenticate } from "./auth.ts";

/** Events every connected client receives; thread streams and tasks are opt-in. */
const BROADCAST = new Set<ServerEvent["type"]>([
  "thread.updated",
  "thread.deleted",
  "agent.updated",
  "agent.deleted",
  "connector.updated",
  "connector.deleted",
  "mcp.updated",
  "mcp.deleted",
  "providers.changed",
  "login.updated",
  "activity",
  "approval.updated",
  "automation.updated",
  "automation.deleted",
]);

// A long-running server should never die from a stray promise rejection in a connector or a
// third-party SDK. Log it; durable work and other connectors keep going.
process.on("unhandledRejection", (reason) => {
  console.error(`[solo] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

export type StartOptions = SoloAgentOptions & {
  port?: number;
  host?: string;
  /** Directory of the built web GUI. Default: packages/web/dist next to this package. */
  webDir?: string;
  quiet?: boolean;
  /** Check GitHub for new releases. Default: SOLOAGENT_UPDATE_CHECK !== "0" (and never under node --test). */
  updateCheck?: boolean;
};

export type RunningServer = { solo: SoloAgent; url: string; port: number; close: () => Promise<void> };

const here = dirname(fileURLToPath(import.meta.url));
/** The built web GUI: SOLOAGENT_WEB_DIR, the monorepo's packages/web/dist, or `web/` beside the published bundle. */
export const DEFAULT_WEB_DIR =
  [process.env.SOLOAGENT_WEB_DIR, resolve(here, "../../web/dist"), resolve(here, "web")].find((dir): dir is string => !!dir && existsSync(join(dir, "index.html"))) ??
  resolve(here, "../../web/dist");

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const solo = await SoloAgent.open(options);
  const log = options.log ?? ((message: string) => console.log(`[solo] ${message}`));
  const updates = new UpdateChecker({
    current: VERSION,
    settings: solo.db,
    enabled: options.updateCheck ?? (updateCheckEnabled() && !process.env.NODE_TEST_CONTEXT),
    log,
  });
  const app = createApp({ solo, webDir: options.webDir ?? DEFAULT_WEB_DIR, updates });
  const port = options.port ?? 7420;
  const host = options.host ?? "0.0.0.0";

  const server = await new Promise<Server>((resolveServer) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolveServer(s as Server)) as Server;
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/ws") return socket.destroy();
    const cookie = /(?:^|;\s*)solo_session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
    const token = url.searchParams.get("token") ?? (cookie ? decodeURIComponent(cookie) : undefined);
    const actor = authenticate(solo, token);
    if (!actor) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(request, socket, head, (ws) => attach(solo, ws, actor, token));
  });

  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}`;

  // Background work that never blocks startup: release checks and scheduled backups.
  const stopUpdates = updates.start();
  const stopBackups = startScheduledBackups(solo, log);
  // Lets `soloagent restore` refuse to run underneath this server.
  const lock = join(solo.dataDir, SERVER_LOCK);
  try {
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid, port: actualPort, url, startedAt: Date.now() })}\n`);
  } catch {
    // read-only data dirs still run
  }

  return {
    solo,
    url,
    port: actualPort,
    close: async () => {
      stopUpdates();
      stopBackups();
      rmSync(lock, { force: true });
      for (const client of wss.clients) client.close();
      await new Promise<void>((r) => server.close(() => r()));
      await solo.close();
    },
  };
}

/** SOLOAGENT_BACKUP_INTERVAL ("24h", "6h"…) and SOLOAGENT_BACKUP_KEEP (default 7). */
function startScheduledBackups(solo: SoloAgent, log: (message: string) => void): () => void {
  const raw = process.env.SOLOAGENT_BACKUP_INTERVAL;
  if (!raw || raw === "0") return () => {};
  const intervalMs = parseDuration(raw);
  if (!intervalMs || intervalMs < 60_000) {
    log(`SOLOAGENT_BACKUP_INTERVAL="${raw}" is not a duration like 24h or 6h (minimum 1m); scheduled backups are off`);
    return () => {};
  }
  const keep = Math.max(1, Math.floor(Number(process.env.SOLOAGENT_BACKUP_KEEP ?? 7)) || 7);
  log(`scheduled backups every ${raw}, keeping ${keep}, in ${join(solo.dataDir, "backups")}`);
  return scheduleBackups(solo.dataDir, { version: VERSION, secret: solo.secretInfo, intervalMs, keep, log });
}

/** Provider sign-in flows are for admins only. */
const ADMIN_EVENTS = new Set<ServerEvent["type"]>(["login.updated"]);

/** Close code for a socket whose credential stopped working. Clients should not reconnect with it. */
export const WS_SESSION_ENDED = 4401;
/** Close code after a role change. Clients reconnect and reload their permissions. */
export const WS_ACCESS_CHANGED = 4000;

function attach(solo: SoloAgent, ws: WebSocket, initialActor: Actor, credential: string | undefined) {
  let actor = initialActor;
  const send = (event: ServerEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  const subscriptions = new Map<string, Promise<() => void>>();
  let tasks: Promise<() => void> | undefined;

  const onEvent = (event: ServerEvent) => {
    if (BROADCAST.has(event.type) && (actor.role === "admin" || !ADMIN_EVENTS.has(event.type))) send(event);
  };
  solo.events.on("event", onEvent);
  // Removed users, ended sessions, and a rotated admin token lose the socket right away; role changes apply live.
  const onAccess = () => {
    const next = authenticate(solo, credential);
    if (!next) return ws.close(WS_SESSION_ENDED, "Session ended");
    // A new role: reconnect so the dashboard reloads what this person may see.
    if (next.role !== actor.role) ws.close(WS_ACCESS_CHANGED, "Access changed");
    actor = next;
  };
  solo.access.on("changed", onAccess);
  send({ type: "hello", version: VERSION });

  ws.on("message", async (raw) => {
    let message: ClientEvent;
    try {
      message = JSON.parse(String(raw)) as ClientEvent;
    } catch {
      return;
    }
    try {
      switch (message.type) {
        case "subscribe": {
          if (subscriptions.has(message.threadId)) return;
          const threadId = message.threadId;
          const subscription = (async () => {
            send({ type: "thread.snapshot", snapshot: await solo.snapshot(threadId) });
            return solo.watch(threadId, send);
          })();
          subscriptions.set(threadId, subscription);
          subscription.catch(() => subscriptions.delete(threadId));
          break;
        }
        case "unsubscribe": {
          const subscription = subscriptions.get(message.threadId);
          subscriptions.delete(message.threadId);
          (await subscription?.catch(() => undefined))?.();
          break;
        }
        case "tasks.subscribe":
          tasks ??= solo.subscribeTasks((list) => send({ type: "tasks", tasks: list }));
          break;
        case "tasks.unsubscribe":
          (await tasks)?.();
          tasks = undefined;
          break;
        case "ping":
          break;
      }
    } catch {
      // unknown thread etc.: ignore
    }
  });

  ws.on("close", async () => {
    solo.events.off("event", onEvent);
    solo.access.off("changed", onAccess);
    for (const subscription of subscriptions.values()) (await subscription.catch(() => undefined))?.();
    (await tasks)?.();
  });
}
