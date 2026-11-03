import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context as HonoContext } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { CONNECTOR_KINDS, HttpError, TeamError, VERSION, type SoloAgent } from "@soloagent/core";
import type { AgentInput, ConnectorInput, Me, Role, Source } from "@soloagent/client";
import { actorOf, adminOnly, type AuthEnv, COOKIE, LoginThrottle, requestToken, requireAuth, tokenMatches } from "./auth.ts";

export { requestToken, tokenMatches } from "./auth.ts";

export type AppOptions = {
  solo: SoloAgent;
  /** Built web GUI (packages/web/dist). Served at / when present. */
  webDir?: string;
};

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

export function createApp({ solo, webDir }: AppOptions) {
  const app = new Hono();

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

  api.post("/hooks/:id", async (c) => {
    const body = await c.req.json<{ text?: string; thread?: string; user?: string; callback_url?: string }>().catch(() => ({}));
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
  api.get("/overview", async (c) => c.json(await solo.overview()));
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
    const body = await c.req.json<{ text?: string; author?: string; source?: Source; whenBusy?: "steer" | "followUp" }>();
    if (!body.text?.trim()) throw new HttpError(400, "text is required");
    const source: Source = body.source === "tui" || body.source === "api" ? body.source : "web";
    // Signed-in people always speak as themselves; the admin token may name its author.
    const actor = actorOf(c);
    const author = actor.kind === "user" ? { name: actor.name, id: actor.userId, source } : { name: body.author?.trim() || "You", source };
    return { text: body.text, author, whenBusy: body.whenBusy };
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
