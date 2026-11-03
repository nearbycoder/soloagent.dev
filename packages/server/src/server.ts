import type { IncomingMessage, Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { SoloAgent, VERSION, type SoloAgentOptions } from "@soloagent/core";
import type { ClientEvent, ServerEvent } from "@soloagent/client";
import { createApp, tokenMatches } from "./app.ts";

/** Events every connected client receives; thread streams and tasks are opt-in. */
const BROADCAST = new Set<ServerEvent["type"]>([
  "thread.updated",
  "thread.deleted",
  "agent.updated",
  "agent.deleted",
  "connector.updated",
  "connector.deleted",
  "providers.changed",
  "login.updated",
  "activity",
]);

export type StartOptions = SoloAgentOptions & {
  port?: number;
  host?: string;
  /** Directory of the built web GUI. Default: packages/web/dist next to this package. */
  webDir?: string;
  quiet?: boolean;
};

export type RunningServer = { solo: SoloAgent; url: string; port: number; close: () => Promise<void> };

export const DEFAULT_WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const solo = await SoloAgent.open(options);
  const app = createApp({ solo, webDir: options.webDir ?? DEFAULT_WEB_DIR });
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
    if (!tokenMatches(solo.adminToken, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(request, socket, head, (ws) => attach(solo, ws));
  });

  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}`;
  return {
    solo,
    url,
    port: actualPort,
    close: async () => {
      for (const client of wss.clients) client.close();
      await new Promise<void>((r) => server.close(() => r()));
      await solo.close();
    },
  };
}

function attach(solo: SoloAgent, ws: WebSocket) {
  const send = (event: ServerEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  const subscriptions = new Map<string, Promise<() => void>>();
  let tasks: Promise<() => void> | undefined;

  const onEvent = (event: ServerEvent) => {
    if (BROADCAST.has(event.type)) send(event);
  };
  solo.events.on("event", onEvent);
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
    for (const subscription of subscriptions.values()) (await subscription.catch(() => undefined))?.();
    (await tasks)?.();
  });
}
