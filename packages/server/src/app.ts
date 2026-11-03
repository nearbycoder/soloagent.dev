import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context as HonoContext } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { CONNECTOR_KINDS, HttpError, VERSION, type SoloAgent } from "@soloagent/core";
import type { AgentInput, ApprovalSettings, ApprovalStatus, ConnectorInput, Source } from "@soloagent/client";

export type AppOptions = {
  solo: SoloAgent;
  /** Built web GUI (packages/web/dist). Served at / when present. */
  webDir?: string;
};

const COOKIE = "solo_session";

export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requestToken(c: HonoContext): string | undefined {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  // Query-string tokens are accepted only on the WebSocket upgrade (see server.ts), never on REST.
  return getCookie(c, COOKIE) ?? undefined;
}

export function createApp({ solo, webDir }: AppOptions) {
  const app = new Hono();

  app.onError((error, c) => {
    const status = error instanceof HttpError ? error.status : /not found/i.test(error.message) ? 404 : 400;
    if (status >= 500 || !(error instanceof HttpError)) console.error(`[solo] ${c.req.method} ${c.req.path}: ${error.message}`);
    return c.json({ error: error.message }, status as 400);
  });

  app.get("/healthz", (c) => c.json({ ok: true, uptimeMs: Date.now() - solo.startedAt }));

  const api = new Hono();

  // Public: session login and inbound webhooks (they carry their own secret).
  api.post("/session", async (c) => {
    const { token } = await c.req.json<{ token?: string }>();
    if (!tokenMatches(solo.adminToken, token)) return c.json({ error: "That token is not right" }, 401);
    setCookie(c, COOKIE, token!, {
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
    return c.json({ ok: true });
  });

  api.post("/hooks/:id", async (c) => {
    const body = await c.req.json<{ text?: string; thread?: string; user?: string; callback_url?: string }>().catch(() => ({}));
    const result = await solo.receiveWebhook(c.req.param("id"), c.req.header("x-solo-secret") ?? c.req.query("secret"), body);
    return c.json(result, "accepted" in result ? 202 : 200);
  });

  api.use("*", async (c, next) => {
    if (!tokenMatches(solo.adminToken, requestToken(c))) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  api.delete("/session", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  api.get("/me", (c) => c.json({ ok: true, version: VERSION }));

  // Overview
  api.get("/overview", async (c) => c.json(await solo.overview()));
  api.get("/usage", async (c) => c.json(await solo.usage()));

  // Agents
  api.get("/agents", (c) => c.json(solo.agents.list()));
  api.post("/agents", async (c) => c.json(solo.createAgent(await c.req.json<AgentInput>()), 201));
  api.get("/agents/:id", (c) => {
    const agent = solo.agents.get(c.req.param("id"));
    return agent ? c.json(agent) : c.json({ error: "Agent not found" }, 404);
  });
  api.patch("/agents/:id", async (c) => c.json(solo.updateAgent(c.req.param("id"), await c.req.json<Partial<AgentInput>>())));
  api.delete("/agents/:id", (c) => {
    solo.agents.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Providers
  api.get("/providers", async (c) => c.json(await solo.providers.list()));
  api.put("/providers/:id/key", async (c) => {
    const { key } = await c.req.json<{ key?: string }>();
    if (!key?.trim()) throw new HttpError(400, "key is required");
    await solo.providers.setApiKey(c.req.param("id"), key);
    return c.json({ ok: true });
  });
  api.delete("/providers/:id/credential", async (c) => {
    await solo.providers.logout(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.post("/providers/:id/login", async (c) => {
    const { type } = await c.req.json<{ type?: "oauth" | "api_key" }>().catch(() => ({ type: undefined }));
    return c.json(solo.providers.startLogin(c.req.param("id"), type ?? "oauth"));
  });
  api.get("/logins/:id", (c) => {
    const flow = solo.providers.flow(c.req.param("id"));
    return flow ? c.json(flow) : c.json({ error: "Login not found" }, 404);
  });
  api.post("/logins/:id/answer", async (c) => {
    const { value } = await c.req.json<{ value?: string }>();
    return c.json(solo.providers.answer(c.req.param("id"), value ?? ""));
  });
  api.delete("/logins/:id", (c) => c.json(solo.providers.cancel(c.req.param("id"))));

  // Connectors
  api.get("/connector-kinds", (c) => c.json(CONNECTOR_KINDS));
  api.get("/connectors", (c) => c.json(solo.connectors.list()));
  api.post("/connectors", async (c) => c.json(solo.connectors.create(await c.req.json<ConnectorInput>()), 201));
  api.patch("/connectors/:id", async (c) => c.json(solo.connectors.update(c.req.param("id"), await c.req.json<Partial<ConnectorInput>>())));
  api.post("/connectors/:id/restart", async (c) => c.json(await solo.connectors.restart(c.req.param("id"))));
  api.delete("/connectors/:id", async (c) => {
    await solo.connectors.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Threads
  api.get("/threads", (c) =>
    c.json(solo.listThreads({ agentId: c.req.query("agentId"), source: c.req.query("source"), limit: Number(c.req.query("limit") ?? 200) })),
  );
  api.post("/threads", async (c) => {
    const body = await c.req.json<{ agentId?: string; title?: string; source?: Source }>().catch(() => ({}) as { agentId?: string; title?: string; source?: Source });
    const source: Source = body.source === "tui" || body.source === "api" ? body.source : "web";
    return c.json(await solo.createThread({ agentId: body.agentId, title: body.title, source }), 201);
  });
  api.get("/threads/:id", async (c) => c.json(await solo.snapshot(c.req.param("id"))));
  api.patch("/threads/:id", async (c) => c.json(solo.updateThread(c.req.param("id"), await c.req.json())));
  api.delete("/threads/:id", async (c) => {
    await solo.deleteThread(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.get("/threads/:id/messages", async (c) =>
    c.json(await solo.messages(c.req.param("id"), c.req.query("before"), Math.min(200, Number(c.req.query("limit") ?? 50)))),
  );
  const sendBody = async (c: HonoContext) => {
    const body = await c.req.json<{ text?: string; author?: string; source?: Source; whenBusy?: "steer" | "followUp" }>();
    if (!body.text?.trim()) throw new HttpError(400, "text is required");
    const source: Source = body.source === "tui" || body.source === "api" ? body.source : "web";
    return { text: body.text, author: { name: body.author?.trim() || "You", source }, whenBusy: body.whenBusy };
  };
  api.post("/threads/:id/messages", async (c) => {
    const sent = await solo.send(c.req.param("id"), await sendBody(c));
    return c.json({ submissionId: sent.submissionId }, 202);
  });
  api.post("/threads/:id/ask", async (c) => {
    const sent = await solo.send(c.req.param("id"), await sendBody(c));
    return c.json(await sent.wait());
  });
  api.post("/threads/:id/stop", async (c) => {
    await solo.stop(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.post("/threads/:id/reset", async (c) => {
    await solo.reset(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.post("/threads/:id/compact", async (c) => {
    await solo.compact(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Schedules
  api.get("/schedules", (c) => c.json(solo.schedules()));
  api.delete("/schedules/:id", async (c) => {
    await solo.cancelSchedule(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Approvals
  api.get("/approvals", (c) => {
    const status = c.req.query("status");
    const allowed = ["pending", "approved", "denied", "expired", "cancelled", "decided"];
    return c.json(
      solo.listApprovals({
        status: status && allowed.includes(status) ? (status as ApprovalStatus | "decided") : undefined,
        threadId: c.req.query("threadId"),
        limit: Number(c.req.query("limit") ?? 100),
      }),
    );
  });
  api.get("/approval-settings", (c) => c.json(solo.approvalSettings()));
  api.put("/approval-settings", async (c) => c.json(solo.setApprovalSettings(await c.req.json<Partial<ApprovalSettings>>())));
  api.get("/approvals/:id", (c) => {
    const approval = solo.approvals.get(c.req.param("id"));
    return approval ? c.json(approval) : c.json({ error: "Approval not found" }, 404);
  });
  const decisionBody = async (c: HonoContext) =>
    c.req.json<{ by?: string; reason?: string; via?: string }>().catch(() => ({}) as { by?: string; reason?: string; via?: string });
  api.post("/approvals/:id/approve", async (c) => {
    const body = await decisionBody(c);
    return c.json(solo.decideApproval(c.req.param("id"), { approve: true, by: body.by, via: body.via === "tui" || body.via === "api" ? body.via : "dashboard" }));
  });
  api.post("/approvals/:id/deny", async (c) => {
    const body = await decisionBody(c);
    return c.json(
      solo.decideApproval(c.req.param("id"), { approve: false, by: body.by, reason: body.reason, via: body.via === "tui" || body.via === "api" ? body.via : "dashboard" }),
    );
  });

  app.route("/api", api);

  // Web GUI
  if (webDir && existsSync(join(webDir, "index.html"))) {
    // Re-read on change so a rebuilt GUI never points at stale asset names.
    let index = { mtime: 0, html: "" };
    const indexHtml = () => {
      const path = join(webDir, "index.html");
      const mtime = statSync(path).mtimeMs;
      if (mtime !== index.mtime) index = { mtime, html: readFileSync(path, "utf8") };
      return index.html;
    };
    app.use("/assets/*", serveStatic({ root: webDir, onFound: (_path, c) => void c.header("cache-control", "public, max-age=31536000, immutable") }));
    app.use("*", serveStatic({ root: webDir }));
    app.get("*", (c) => c.html(indexHtml()));
  } else {
    app.get("/", (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>soloagent</title><body style="font:16px system-ui;background:#0b0b12;color:#e5e5f0;display:grid;place-items:center;height:100vh"><div><h1>✦ soloagent is running</h1><p>The web GUI is not built. Run <code>npm run build</code>, or use the TUI: <code>npx soloagent</code>.</p></div>`,
      ),
    );
  }

  return app;
}
