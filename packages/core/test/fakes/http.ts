import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Reads a request body as JSON, a form, or nothing. Values that look like JSON (Slack's `blocks`) are parsed. */
export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) return JSON.parse(raw) as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    params[key] = /^[[{]/.test(value) ? safeJson(value) : value;
  }
  return params;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** An HTTP server on a free loopback port that closes every open connection (long polls included) on close(). */
export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error: unknown) => {
      if (!res.headersSent) json(res, { ok: false, error: String(error) }, 500);
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Polls until `get` returns something truthy. */
export async function until<T>(get: () => T | undefined | null | false, what = "condition", ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
