import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { Hono, type Context as HonoContext } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { backupFileName, CONNECTOR_KINDS, exportAgents, HttpError, importAgents, TeamError, UpdateChecker, VERSION, parseUploads, type SoloAgent } from "@soloagent/core";
import type { AgentInput, ApprovalSettings, ApprovalStatus, AutomationInput, ConnectorInput, McpServerInput, Me, Role, Source } from "@soloagent/client";
import { actorOf, adminOnly, type AuthEnv, COOKIE, LoginThrottle, requestToken, requireAuth, tokenMatches } from "./auth.ts";

export { requestToken, tokenMatches } from "./auth.ts";

export type AppOptions = {
  solo: SoloAgent;
  /** Built web GUI (packages/web/dist). Served at / when present. */
  webDir?: string;
  /** Upgrade notices. Default: a checker that only reports the cached result (no network). */
  updates?: UpdateChecker;
};

/** File types served inline by `GET /api/files/:sha256`. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

function setSession(c: HonoContext, value: string, maxAgeSeconds: number) {
  setCookie(c, COOKIE, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

/** Where invite links point: SOLOAGENT_PUBLIC_URL, else the origin this request came in on. */
function publicOrigin(c: HonoContext): string {
  const configured = process.env.SOLOAGENT_PUBLIC_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host;
  return `${proto}://${host}`;
}

export function createApp({ solo, webDir, updates: updateChecker }: AppOptions) {
  const app = new Hono();
  const updates = updateChecker ?? new UpdateChecker({ current: VERSION, settings: solo.db, enabled: false });

  app.onError((error, c) => {
    const known = error instanceof HttpError || error instanceof TeamError;
    const status = known ? error.status : /not found/i.test(error.message) ? 404 : 400;
    if (status >= 500 || !known) console.error(`[solo] ${c.req.method} ${c.req.path}: ${error.message}`);
    return c.json({ error: error.message }, status as 400);
  });

  app.get("/healthz", (c) => c.json({ ok: true, uptimeMs: Date.now() - solo.startedAt }));

  const api = new Hono<AuthEnv>();
  const throttle = new LoginThrottle();

  // Public: sign-in (admin token, or a name and password), invite links, and inbound webhooks (they carry their own secret).
  api.post("/session", async (c) => {
    const body = await c.req.json<{ token?: string; name?: string; password?: string }>().catch(() => ({}) as { token?: string; name?: string; password?: string });
    if (body.token !== undefined) {
      if (!tokenMatches(solo.adminToken, body.token)) return c.json({ error: "That token is not right" }, 401);
      setSession(c, body.token, 60 * 60 * 24 * 90);
      return c.json({ ok: true });
    }
    const name = body.name?.trim() ?? "";
    if (!name || !body.password) return c.json({ error: "Enter your name and password" }, 400);
    if (throttle.blocked(name)) return c.json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
    const user = await solo.team.checkPassword(name, body.password);
    if (!user) {
      throttle.fail(name);
      return c.json({ error: "That name and password don't match" }, 401);
    }
    throttle.clear(name);
    const session = solo.team.createSession(user.id);
    setSession(c, session.token, Math.floor((session.expiresAt - Date.now()) / 1000));
    return c.json({ ok: true });
  });

  api.get("/invite/:code", (c) => {
    const invite = solo.team.openInvite(c.req.param("code"));
    if (!invite) return c.json({ error: "This invite link has expired or was already used. Ask an admin for a new one." }, 410);
    return c.json({ role: invite.role, name: invite.name, expiresAt: invite.expiresAt });
  });

  api.post("/invite/:code", async (c) => {
    const body = await c.req.json<{ name?: string; password?: string }>().catch(() => ({}) as { name?: string; password?: string });
    const user = await solo.team.acceptInvite(c.req.param("code"), { name: body.name ?? "", password: body.password ?? "" });
    const session = solo.team.createSession(user.id);
    setSession(c, session.token, Math.floor((session.expiresAt - Date.now()) / 1000));
    solo.activity({ type: "access", text: `${user.name} joined the team as ${user.role === "admin" ? "an admin" : "a member"}` });
    return c.json({ ok: true, user }, 201);
  });
  // Public: the running version and whether a newer release exists.
  api.get("/version", (c) => c.json(updates.info()));

  api.post("/hooks/:id", async (c) => {
    const body = await c.req.json<{ text?: string; thread?: string; user?: string; callback_url?: string; attachments?: unknown }>().catch(() => ({}));
    const result = await solo.receiveWebhook(c.req.param("id"), c.req.header("x-solo-secret") ?? c.req.query("secret"), body);
    return c.json(result, "accepted" in result ? 202 : 200);
  });

  api.use("*", requireAuth(solo));

  api.delete("/session", (c) => {
    solo.team.deleteSession(requestToken(c));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  api.get("/me", (c) => c.json({ ok: true, version: VERSION, actor: actorOf(c), tokenFromEnv: solo.adminTokenSource !== "stored" } satisfies Me));

  // Overview (everyone signed in)
  api.get("/overview", async (c) => c.json({ ...(await solo.overview()), update: updates.info() }));

  // Backups and agent export/import (admins)
  api.get("/backup", adminOnly, (c) => {
    const includeSecret = /^(1|true|yes)$/i.test(c.req.query("includeSecret") ?? "");
    const archive = solo.backup({ includeSecret });
    // A client that disconnects mid-download cancels the backup and its temp files.
    c.req.raw.signal.addEventListener("abort", () => archive.destroy(), { once: true });
    return new Response(Readable.toWeb(archive) as ReadableStream, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${backupFileName()}"`,
        "cache-control": "no-store",
      },
    });
  });
  api.get("/agents/export", adminOnly, (c) => {
    c.header("content-disposition", `attachment; filename="soloagent-agents-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json(exportAgents(solo, VERSION));
  });
  api.post("/agents/import", adminOnly, async (c) => {
    const body = await c.req.json<{ agents?: unknown; mode?: unknown }>().catch(() => {
      throw new HttpError(400, "Expected a JSON body with an agents array");
    });
    const dryRun = /^(1|true|yes)$/i.test(c.req.query("dryRun") ?? "");
    const result = importAgents(solo, body, { dryRun });
    if (!dryRun) {
      const changed = result.items.filter((i) => i.action === "create" || i.action === "update").length;
      if (changed) solo.activity({ type: "agent", text: `Imported ${changed === 1 ? "1 agent" : `${changed} agents`}` });
    }
    return c.json(result);
  });
  api.get("/usage", async (c) => c.json(await solo.usage()));
  api.get("/usage/daily", (c) => c.json(solo.dailyUsage(Number(c.req.query("days") ?? 14) || 14)));
  api.get("/spend/today", (c) => c.json(solo.spendToday()));

  // Team (admins)
  api.get("/users", adminOnly, (c) => c.json(solo.team.users()));
  api.patch("/users/:id", adminOnly, async (c) => {
    const body = await c.req.json<{ role?: Role; name?: string }>();
    const before = solo.team.user(c.req.param("id"));
    const user = solo.team.updateUser(c.req.param("id"), body);
    if (before && before.role !== user.role) solo.activity({ type: "access", text: `${actorOf(c).name} made ${user.name} ${user.role === "admin" ? "an admin" : "a member"}` });
    return c.json(user);
  });
  api.delete("/users/:id", adminOnly, (c) => {
    const user = solo.team.user(c.req.param("id"));
    solo.team.deleteUser(c.req.param("id"));
    if (user) solo.activity({ type: "access", text: `${actorOf(c).name} removed ${user.name} from the team` });
    return c.json({ ok: true });
  });
  api.get("/invites", adminOnly, (c) => c.json(solo.team.invites()));
  api.post("/invites", adminOnly, async (c) => {
    const body = await c.req.json<{ role?: Role; name?: string }>().catch(() => ({}) as { role?: Role; name?: string });
    const actor = actorOf(c);
    const { invite, code } = solo.team.createInvite({ role: body.role ?? "member", name: body.name, createdBy: actor.name });
    const path = `/invite/${code}`;
    solo.activity({ type: "access", text: `${actor.name} created an invite for ${invite.name ?? (invite.role === "admin" ? "an admin" : "a member")}` });
    return c.json({ invite, code, path, url: `${publicOrigin(c)}${path}` }, 201);
  });
  api.delete("/invites/:id", adminOnly, (c) => {
    solo.team.revokeInvite(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.post("/admin-token/rotate", adminOnly, (c) => {
    const token = solo.rotateAdminToken();
    // Keep a token-signed-in browser signed in with the new token.
    if (actorOf(c).kind === "token" && !c.req.header("authorization")) setSession(c, token, 60 * 60 * 24 * 90);
    return c.json({ token });
  });

  // Agents (everyone reads; admins change)
  api.get("/agents", (c) => c.json(solo.agents.list()));
  api.post("/agents", adminOnly, async (c) => c.json(solo.createAgent(await c.req.json<AgentInput>()), 201));
  api.get("/agents/:id", (c) => {
    const agent = solo.agents.get(c.req.param("id"));
    return agent ? c.json(agent) : c.json({ error: "Agent not found" }, 404);
  });
  api.patch("/agents/:id", adminOnly, async (c) => c.json(solo.updateAgent(c.req.param("id"), await c.req.json<Partial<AgentInput>>())));
  api.delete("/agents/:id", adminOnly, (c) => {
    solo.agents.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Memories: everyone reads; admins edit (agents still remember and forget on their own)
  const memoryAgent = (c: HonoContext) => {
    const agent = solo.agents.get(c.req.param("id") ?? "");
    if (!agent) throw new HttpError(404, "Agent not found");
    return agent;
  };
  const memoryId = (c: HonoContext) => {
    const id = Number(c.req.param("memoryId"));
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Memory not found");
    return id;
  };
  api.get("/memories/counts", (c) => c.json(solo.memories.counts()));
  api.get("/agents/:id/memories", (c) => c.json(solo.memories.list(memoryAgent(c).id, { q: c.req.query("q"), limit: Number(c.req.query("limit") ?? 500) || 500 })));
  api.post("/agents/:id/memories", adminOnly, async (c) => {
    const agent = memoryAgent(c);
    const { text } = await c.req.json<{ text?: string }>().catch(() => ({ text: undefined }));
    return c.json(solo.memories.add(agent.id, text ?? ""), 201);
  });
  api.patch("/agents/:id/memories/:memoryId", adminOnly, async (c) => {
    const agent = memoryAgent(c);
    const { text } = await c.req.json<{ text?: string }>().catch(() => ({ text: undefined }));
    return c.json(solo.memories.update(agent.id, memoryId(c), text ?? ""));
  });
  api.delete("/agents/:id/memories/:memoryId", adminOnly, (c) => {
    const agent = memoryAgent(c);
    if (!solo.memories.delete(agent.id, memoryId(c))) throw new HttpError(404, "Memory not found");
    return c.json({ ok: true });
  });
  // Clearing every memory needs ?confirm=all, so a stray DELETE can't wipe them.
  api.delete("/agents/:id/memories", adminOnly, (c) => {
    const agent = memoryAgent(c);
    if (c.req.query("confirm") !== "all") throw new HttpError(400, "Add ?confirm=all to delete every memory of this agent");
    return c.json({ ok: true, deleted: solo.memories.clear(agent.id) });
  });

  // MCP servers: everyone reads (secrets are masked); admins change them
  api.get("/mcp-servers", (c) => c.json(solo.mcp.list()));
  api.post("/mcp-servers", adminOnly, async (c) => {
    const input = await c.req.json<McpServerInput>();
    if (input.id && solo.mcp.get(input.id)) throw new HttpError(409, `An MCP server with id "${input.id}" already exists`);
    return c.json(solo.mcp.create(input), 201);
  });
  api.get("/mcp-servers/:id", (c) => {
    const server = solo.mcp.get(c.req.param("id"));
    return server ? c.json(server) : c.json({ error: "MCP server not found" }, 404);
  });
  api.patch("/mcp-servers/:id", adminOnly, async (c) => c.json(solo.mcp.update(c.req.param("id"), await c.req.json<McpServerInput>())));
  api.post("/mcp-servers/:id/test", adminOnly, async (c) => c.json(await solo.mcp.test(c.req.param("id"))));
  api.delete("/mcp-servers/:id", adminOnly, async (c) => {
    await solo.mcp.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Providers (everyone reads model names; admins sign in and out)
  api.get("/providers", async (c) => c.json(await solo.providers.list()));
  api.put("/providers/:id/key", adminOnly, async (c) => {
    const { key } = await c.req.json<{ key?: string }>();
    if (!key?.trim()) throw new HttpError(400, "key is required");
    await solo.providers.setApiKey(c.req.param("id"), key);
    return c.json({ ok: true });
  });
  api.delete("/providers/:id/credential", adminOnly, async (c) => {
    await solo.providers.logout(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.post("/providers/:id/login", adminOnly, async (c) => {
    const { type } = await c.req.json<{ type?: "oauth" | "api_key" }>().catch(() => ({ type: undefined }));
    return c.json(solo.providers.startLogin(c.req.param("id"), type ?? "oauth"));
  });
  api.get("/logins/:id", adminOnly, (c) => {
    const flow = solo.providers.flow(c.req.param("id"));
    return flow ? c.json(flow) : c.json({ error: "Login not found" }, 404);
  });
  api.post("/logins/:id/answer", adminOnly, async (c) => {
    const { value } = await c.req.json<{ value?: string }>();
    return c.json(solo.providers.answer(c.req.param("id"), value ?? ""));
  });
  api.delete("/logins/:id", adminOnly, (c) => c.json(solo.providers.cancel(c.req.param("id"))));

  // Connectors (everyone reads; secrets are masked; admins change)
  api.get("/connector-kinds", (c) => c.json(CONNECTOR_KINDS));
  api.get("/connectors", (c) => c.json(solo.connectors.list()));
  api.post("/connectors", adminOnly, async (c) => c.json(solo.connectors.create(await c.req.json<ConnectorInput>()), 201));
  api.patch("/connectors/:id", adminOnly, async (c) => c.json(solo.connectors.update(c.req.param("id"), await c.req.json<Partial<ConnectorInput>>())));
  api.post("/connectors/:id/restart", adminOnly, async (c) => c.json(await solo.connectors.restart(c.req.param("id"))));
  api.delete("/connectors/:id", adminOnly, async (c) => {
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
  const sendBody = async (c: HonoContext<AuthEnv>) => {
    const body = await c.req.json<{ text?: string; author?: string; source?: Source; whenBusy?: "steer" | "followUp"; attachments?: unknown }>();
    const attachments = parseUploads(body.attachments);
    if (!body.text?.trim() && !attachments.length) throw new HttpError(400, "text is required");
    const source: Source = body.source === "tui" || body.source === "api" ? body.source : "web";
    // Signed-in people always speak as themselves; the admin token may name its author.
    const actor = actorOf(c);
    const author = actor.kind === "user" ? { name: actor.name, id: actor.userId, source } : { name: body.author?.trim() || "You", source };
    return { text: body.text ?? "", author, whenBusy: body.whenBusy, attachments };
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

  // Files & images: what people shared, by content hash. Only raster images render inline; everything else
  // downloads, sandboxed, so an uploaded HTML or SVG file can never run script on the dashboard's origin.
  api.get("/files/:sha256", (c) => {
    const file = solo.files.get(c.req.param("sha256"));
    if (!file) return c.json({ error: "File not found" }, 404);
    const inline = INLINE_TYPES.has(file.mimeType);
    const encoded = encodeURIComponent(file.name);
    const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream, {
      headers: {
        "content-type": inline || file.mimeType.startsWith("text/") ? file.mimeType : "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
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
  api.put("/approval-settings", adminOnly, async (c) => c.json(solo.setApprovalSettings(await c.req.json<Partial<ApprovalSettings>>())));
  api.get("/approvals/:id", (c) => {
    const approval = solo.approvals.get(c.req.param("id"));
    return approval ? c.json(approval) : c.json({ error: "Approval not found" }, 404);
  });
  const decisionBody = async (c: HonoContext) =>
    c.req.json<{ by?: string; reason?: string; via?: string }>().catch(() => ({}) as { by?: string; reason?: string; via?: string });
  /** Signed-in people decide as themselves; the admin token (CLI, scripts) may name who it acts for. */
  const decider = (c: HonoContext, by: string | undefined) => {
    const actor = actorOf(c);
    return actor.kind === "user" ? actor.name : by?.trim() || "admin";
  };
  api.post("/approvals/:id/approve", async (c) => {
    const body = await decisionBody(c);
    return c.json(solo.decideApproval(c.req.param("id"), { approve: true, by: decider(c, body.by), via: body.via === "tui" || body.via === "api" ? body.via : "dashboard" }));
  });
  api.post("/approvals/:id/deny", async (c) => {
    const body = await decisionBody(c);
    return c.json(
      solo.decideApproval(c.req.param("id"), { approve: false, by: decider(c, body.by), reason: body.reason, via: body.via === "tui" || body.via === "api" ? body.via : "dashboard" }),
    );
  });

  // Automations (recurring schedules)
  api.get("/automations", (c) => c.json(solo.automations.list()));
  api.get("/automations/preview", (c) => {
    const cron = c.req.query("cron");
    if (!cron?.trim()) throw new HttpError(400, "cron is required");
    return c.json(solo.automations.preview(cron, c.req.query("tz"), Number(c.req.query("count") ?? 5)));
  });
  api.post("/automations", adminOnly, async (c) => c.json(await solo.automations.create(await c.req.json<AutomationInput>()), 201));
  api.get("/automations/:id", (c) => {
    const automation = solo.automations.get(c.req.param("id"));
    return automation ? c.json(automation) : c.json({ error: "Automation not found" }, 404);
  });
  api.patch("/automations/:id", adminOnly, async (c) => c.json(await solo.automations.update(c.req.param("id"), await c.req.json<Partial<AutomationInput>>())));
  api.post("/automations/:id/run", adminOnly, async (c) => c.json(await solo.automations.runNow(c.req.param("id"))));
  api.delete("/automations/:id", adminOnly, async (c) => {
    if (!(await solo.automations.delete(c.req.param("id")))) throw new HttpError(404, "Automation not found");
    return c.json({ ok: true });
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
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>soloagent</title><body style="margin:0;font:15px/1.6 system-ui,sans-serif;background:#f5f4ef;color:#15140f;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box"><div style="max-width:520px"><h1 style="font-size:22px;margin:0 0 8px">soloagent is running</h1><p style="margin:0;color:#57554c">The dashboard isn't built. Run <code>npm run build</code>, or use the terminal UI: <code>soloagent --url &lt;this server&gt; --token &lt;token&gt;</code>.</p></div>`,
      ),
    );
  }

  return app;
}
