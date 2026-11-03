import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { json, listen, readBody } from "./http.ts";

export type SlackCall = { method: string; token: string; params: Record<string, unknown> };

/**
 * A minimal Slack on loopback: the Web API under `apiUrl` (auth.test, apps.connections.open, chat.postMessage,
 * chat.update, users.info, conversations.info, chat.postEphemeral), and the Socket Mode WebSocket that
 * apps.connections.open hands out. It says `hello` on connect, sends envelopes with `send()`, and records acks.
 */
export class FakeSlack {
  readonly calls: SlackCall[] = [];
  readonly acks: string[] = [];
  apiUrl = "";
  /** Bot tokens auth.test accepts. Anything else answers `invalid_auth`. */
  validBotTokens = new Set<string>();
  users: Record<string, string> = {};
  channels: Record<string, string> = {};
  #sockets = new Set<WebSocket>();
  #ackWaiters = new Map<string, () => void>();
  #nextTs = 1_730_000_000;
  #close: () => Promise<void> = async () => {};

  static async start(): Promise<FakeSlack> {
    const fake = new FakeSlack();
    const wss = new WebSocketServer({ noServer: true });
    const { server, port, close } = await listen(async (req, res) => {
      const method = /^\/api\/([a-zA-Z.]+)$/.exec(new URL(req.url ?? "/", "http://x").pathname)?.[1];
      if (!method) return json(res, { ok: false, error: "unknown_method" }, 404);
      const params = await readBody(req);
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/, "") || String(params.token ?? "");
      fake.calls.push({ method, token, params });
      json(res, fake.#answer(method, token, params, port));
    });
    server.on("upgrade", (req, socket, head) => {
      if (!req.url?.startsWith("/link")) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => fake.#connected(ws));
    });
    fake.apiUrl = `http://127.0.0.1:${port}/api/`;
    fake.#close = async () => {
      // Bolt's stop() does not wait for the close handshake; let it finish so the client sees a clean close.
      const deadline = Date.now() + 1_000;
      while (fake.#sockets.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      for (const ws of fake.#sockets) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await close();
    };
    return fake;
  }

  callsTo(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  /** Whether a Socket Mode client is connected. */
  get connected(): boolean {
    return this.#sockets.size > 0;
  }

  /** Send an Events API envelope (an `event_callback`) and resolve once the app acks it. */
  async event(event: Record<string, unknown>): Promise<string> {
    const envelopeId = randomUUID();
    const acked = new Promise<void>((resolve) => this.#ackWaiters.set(envelopeId, resolve));
    const envelope = {
      envelope_id: envelopeId,
      type: "events_api",
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: "",
      payload: {
        token: "verification",
        team_id: "T1",
        api_app_id: "A1",
        type: "event_callback",
        event_id: `Ev${envelopeId.slice(0, 8)}`,
        event_time: Math.floor(Date.now() / 1000),
        authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true, is_enterprise_install: false }],
        event: { event_ts: String(event.ts), ...event },
      },
    };
    const [socket] = this.#sockets;
    if (!socket) throw new Error("no Socket Mode client connected");
    socket.send(JSON.stringify(envelope));
    await acked;
    return envelopeId;
  }

  /** A fresh message timestamp. */
  ts(): string {
    return `${this.#nextTs++}.000100`;
  }

  async close() {
    await this.#close();
  }

  #connected(ws: WebSocket) {
    this.#sockets.add(ws);
    ws.on("close", () => this.#sockets.delete(ws));
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { envelope_id?: string };
      if (!message.envelope_id) return;
      this.acks.push(message.envelope_id);
      this.#ackWaiters.get(message.envelope_id)?.();
      this.#ackWaiters.delete(message.envelope_id);
    });
    ws.send(JSON.stringify({ type: "hello", num_connections: 1, debug_info: { host: "fake", approximate_connection_time: 3600 }, connection_info: { app_id: "A1" } }));
  }

  #answer(method: string, token: string, params: Record<string, unknown>, port: number): Record<string, unknown> {
    switch (method) {
      case "auth.test":
        return this.validBotTokens.has(token)
          ? { ok: true, url: "https://acme.slack.com/", team: "Acme", user: "solo", team_id: "T1", user_id: "UBOT", bot_id: "BBOT", is_enterprise_install: false }
          : { ok: false, error: "invalid_auth" };
      case "apps.connections.open":
        return token.startsWith("xapp-") ? { ok: true, url: `ws://127.0.0.1:${port}/link?ticket=${randomUUID()}` } : { ok: false, error: "invalid_auth" };
      case "users.info": {
        const id = String(params.user);
        const name = this.users[id];
        return name ? { ok: true, user: { id, name, real_name: name, profile: { display_name: name } } } : { ok: false, error: "user_not_found" };
      }
      case "conversations.info": {
        const id = String(params.channel);
        const name = this.channels[id];
        return name ? { ok: true, channel: { id, name } } : { ok: false, error: "channel_not_found" };
      }
      case "chat.postMessage":
        return { ok: true, channel: params.channel, ts: this.ts(), message: { text: params.text } };
      case "chat.update":
        return { ok: true, channel: params.channel, ts: params.ts, text: params.text };
      case "chat.postEphemeral":
        return { ok: true, message_ts: this.ts() };
      default:
        return { ok: false, error: "unknown_method" };
    }
  }
}
