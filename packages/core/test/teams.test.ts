import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { Connector, ConnectorAccess, ConnectorLimits } from "@soloagent/client";
import { SoloAgent, type InboundMessage } from "../src/index.ts";
import { DRIVERS } from "../src/connectors/kinds.ts";
import type { ConnectorHost, DriverFactory } from "../src/connectors/types.ts";
import { createApp } from "../../server/src/app.ts";

// A chat connector that records what the bot posts. Registered in place of Telegram for these tests.
const posted: { connectorToken: string; markdown: string }[] = [];
const fakeChat: DriverFactory = (config, host: ConnectorHost) => ({
  maxLength: 4_000,
  async start() {
    host.status("connected", undefined, "@fake");
  },
  async stop() {},
  async post(_target, markdown) {
    posted.push({ connectorToken: config.botToken ?? "", markdown });
    return undefined;
  },
});
DRIVERS.telegram = fakeChat;

/** $1 per token, so any answer has a real price. */
const PRICED = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };

async function open(options: { adminToken?: string } = { adminToken: "t" }) {
  const dir = mkdtempSync(join(tmpdir(), "solo-teams-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false, cost: PRICED }] });
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", ...options, connectors: false, demo: false, providers: [faux.provider], log: () => {} });
  const solo1 = solo.agents.list()[0]!;
  solo.agents.update(solo1.id, { model: { provider: "faux", modelId: "faux-1" } });
  const answer = (text = "ok") => faux.appendResponses([fauxAssistantMessage([fauxText(text)])]);
  return {
    solo,
    faux,
    answer,
    soloAgentId: solo1.id,
    cleanup: async () => {
      await solo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function chatConnector(solo: SoloAgent, token: string, access: Partial<ConnectorAccess> = {}, limits: Partial<ConnectorLimits> = {}): Promise<Connector> {
  const connector = solo.connectors.create({ kind: "telegram", config: { botToken: token }, access, limits });
  for (let i = 0; i < 50 && solo.connectors.get(connector.id)?.status !== "connected"; i++) await new Promise((r) => setTimeout(r, 10));
  return solo.connectors.get(connector.id)!;
}

function inbound(text: string, from: { id: string; name: string }, where: { channel?: { id: string; name: string }; dm?: boolean } = {}): InboundMessage {
  const isDirect = where.dm ?? !where.channel;
  return {
    externalKey: isDirect ? `dm:${from.id}` : where.channel!.id,
    location: isDirect ? `DM with ${from.name}` : where.channel!.name,
    title: text.slice(0, 20),
    author: { id: from.id, name: from.name, source: "telegram" },
    text,
    target: { chatId: isDirect ? from.id : where.channel!.id },
    isDirect,
    channel: isDirect ? undefined : where.channel,
  };
}

const ANN = { id: "U1", name: "ann" };
const BOB = { id: "U2", name: "bob" };
const ENG = { id: "C1", name: "#eng" };
const RANDOM = { id: "C2", name: "#random" };
const repliesTo = (token: string) => posted.filter((p) => p.connectorToken === token).map((p) => p.markdown);

test("connector user lists deny politely, once, and log it; listed users get through", async () => {
  const { solo, answer, cleanup } = await open();
  try {
    const connector = await chatConnector(solo, "users", { users: ["ann"] });
    const denied = await solo.handleInbound(connector, inbound("hello", BOB, { channel: ENG }), { wait: true });
    assert.equal(denied.status, "unanswered");
    assert.equal((denied as { reason?: string }).reason, "access_denied");
    assert.deepEqual(repliesTo("users"), ["You don't have access to @solo here. Ask an admin."]);
    // A second try within the window gets no second notice.
    await solo.handleInbound(connector, inbound("hello??", BOB, { channel: ENG }), { wait: true });
    assert.equal(repliesTo("users").length, 1);
    const logged = solo.recentActivity().filter((a) => a.type === "access");
    assert.equal(logged.length, 1);
    assert.match(logged[0]!.text, /bob in #eng → @solo .*user list/);
    assert.equal(solo.listThreads({ source: "telegram" }).length, 0);

    answer("hi ann");
    const allowed = await solo.handleInbound(connector, inbound("hello", { id: "U1", name: "Ann" }, { channel: ENG }), { wait: true });
    assert.deepEqual(allowed, { status: "done", answer: "hi ann" });
    // Matching by platform id works too.
    answer("hi again");
    const byId = await solo.handleInbound(
      solo.connectors.update(connector.id, { access: { users: ["U2"] } }),
      inbound("hello", BOB, { channel: ENG }),
      { wait: true },
    );
    assert.equal(byId.status, "done");
  } finally {
    await cleanup();
  }
});

test("channel lists allow listed channels; DMs need the user list to name the sender", async () => {
  const { solo, answer, cleanup } = await open();
  try {
    const connector = await chatConnector(solo, "channels", { channels: ["#eng"] });
    answer("eng ok");
    assert.equal((await solo.handleInbound(connector, inbound("hi", BOB, { channel: ENG }), { wait: true })).status, "done");
    assert.equal((await solo.handleInbound(connector, inbound("hi", BOB, { channel: RANDOM }), { wait: true })).status, "unanswered");
    assert.equal((await solo.handleInbound(connector, inbound("hi", BOB, { dm: true }), { wait: true })).status, "unanswered");
    // Name bob explicitly and his DMs get through, but the channel list still applies to channels.
    const named = solo.connectors.update(connector.id, { access: { users: ["bob"] } });
    answer("dm ok");
    assert.equal((await solo.handleInbound(named, inbound("hi", BOB, { dm: true }), { wait: true })).status, "done");
    assert.equal((await solo.handleInbound(named, inbound("hi", BOB, { channel: RANDOM }), { wait: true })).status, "unanswered");
    // Channel ids match as well as names.
    const byId = solo.connectors.update(connector.id, { access: { users: [], channels: ["C2"] } });
    answer("random ok");
    assert.equal((await solo.handleInbound(byId, inbound("hi", ANN, { channel: RANDOM }), { wait: true })).status, "done");
  } finally {
    await cleanup();
  }
});

test("agent lists limit which agents a connector reaches, including !agents", async () => {
  const { solo, answer, cleanup } = await open();
  try {
    const coder = solo.createAgent({ name: "Coder", handle: "coder", model: { provider: "faux", modelId: "faux-1" } });
    const connector = await chatConnector(solo, "agents", { agents: ["@coder"] });
    const denied = await solo.handleInbound(connector, inbound("@solo hi", ANN, { channel: ENG }), { wait: true });
    assert.equal((denied as { reason?: string }).reason, "access_denied");
    assert.deepEqual(repliesTo("agents"), ["You don't have access to @solo here. Ask an admin."]);
    answer("coder here");
    const ok = await solo.handleInbound(connector, inbound("@coder hi", ANN, { channel: ENG }), { wait: true });
    assert.deepEqual(ok, { status: "done", answer: "coder here" });
    assert.equal(solo.listThreads({ source: "telegram" })[0]!.agentId, coder.id);
    const list = await solo.handleInbound(connector, inbound("!agents", ANN, { channel: ENG }), { wait: true });
    assert.match((list as { answer: string }).answer, /@coder/);
    assert.doesNotMatch((list as { answer: string }).answer, /@solo/);
  } finally {
    await cleanup();
  }
});

test("workspace agents are unreachable from chat unless chatAccess is on; webhooks still reach them", async () => {
  const { solo, answer, cleanup } = await open();
  try {
    const ops = solo.createAgent({ name: "Ops", handle: "ops", skills: ["workspace"], model: { provider: "faux", modelId: "faux-1" } });
    assert.equal(ops.chatAccess, false);
    const connector = await chatConnector(solo, "workspace");
    const denied = await solo.handleInbound(connector, inbound("@ops ls", ANN, { channel: ENG }), { wait: true });
    assert.equal((denied as { reason?: string }).reason, "access_denied");
    assert.match(solo.recentActivity().find((a) => a.type === "access")!.text, /workspace skill/);

    const hook = solo.connectors.create({ kind: "webhook", config: { secret: "s3cret" } });
    await new Promise((r) => setTimeout(r, 50));
    answer("from webhook");
    const viaHook = await solo.receiveWebhook(hook.id, "s3cret", { text: "@ops ls", thread: "ci" });
    assert.equal((viaHook as { answer?: string }).answer, "from webhook");

    solo.updateAgent(ops.id, { chatAccess: true });
    answer("from chat");
    const allowed = await solo.handleInbound(connector, inbound("@ops ls", ANN, { channel: ENG }), { wait: true });
    assert.deepEqual(allowed, { status: "done", answer: "from chat" });
  } finally {
    await cleanup();
  }
});

test("webhooks apply only the agent list, and say 403 when it denies", async () => {
  const { solo, answer, cleanup } = await open();
  try {
    solo.createAgent({ name: "Coder", handle: "coder", model: { provider: "faux", modelId: "faux-1" } });
    const hook = solo.connectors.create({ kind: "webhook", config: { secret: "s3cret" }, access: { users: ["nobody"], channels: ["#nowhere"], agents: ["coder"] } });
    await new Promise((r) => setTimeout(r, 50));
    answer("green");
    const ok = await solo.receiveWebhook(hook.id, "s3cret", { text: "@coder status?", thread: "ci", user: "ci-bot" });
    assert.equal((ok as { answer?: string }).answer, "green");
    await assert.rejects(solo.receiveWebhook(hook.id, "s3cret", { text: "@solo status?", thread: "ci" }), (error: Error & { status?: number }) => error.status === 403);
  } finally {
    await cleanup();
  }
});

test("spend is recorded per response and a daily dollar budget stops the next message", async () => {
  const { solo, answer, soloAgentId, cleanup } = await open();
  try {
    solo.updateAgent(soloAgentId, { budget: { dailyUsd: 0.5 } });
    assert.deepEqual(solo.agents.get(soloAgentId)!.budget, { dailyUsd: 0.5, dailyRuns: null });
    const thread = await solo.createThread({ source: "web" });
    answer("first answer");
    assert.equal((await (await solo.send(thread.id, { text: "hi", author: { name: "ann", source: "web" } })).wait()).status, "done");

    const rows = solo.db.all<{ agent_id: string; thread_id: string; model: string; cost: number; input: number }>("SELECT * FROM spend");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.agent_id, soloAgentId);
    assert.equal(rows[0]!.thread_id, thread.id);
    assert.equal(rows[0]!.model, "faux-1");
    assert.ok(rows[0]!.cost > 0.5, `priced from the catalog: ${rows[0]!.cost}`);
    const today = solo.spendToday().find((s) => s.agentId === soloAgentId)!;
    assert.equal(today.runs, 1);
    assert.equal(today.usd, rows[0]!.cost);
    assert.equal(solo.dailyUsage(7).at(-1)!.usage.cost, rows[0]!.cost);

    await assert.rejects(
      solo.send(thread.id, { text: "again", author: { name: "ann", source: "web" } }),
      (error: Error & { status?: number }) => error.status === 429 && /daily budget/.test(error.message),
    );
    assert.match(solo.recentActivity().find((a) => a.type === "access")!.text, /daily budget of \$0\.50 reached/);
    // Raising the budget lets messages through again.
    solo.updateAgent(soloAgentId, { budget: { dailyUsd: null } });
    answer("second answer");
    assert.equal((await (await solo.send(thread.id, { text: "again", author: { name: "ann", source: "web" } })).wait()).status, "done");
  } finally {
    await cleanup();
  }
});

test("a daily run budget and a per-user hourly limit reply in chat instead of running", async () => {
  const { solo, answer, soloAgentId, cleanup } = await open();
  try {
    const connector = await chatConnector(solo, "limits", {}, { perUserPerHour: 1 });
    answer("one");
    assert.equal((await solo.handleInbound(connector, inbound("hi", ANN, { channel: ENG }), { wait: true })).status, "done");
    const limited = await solo.handleInbound(connector, inbound("hi again", ANN, { channel: ENG }), { wait: true });
    assert.equal((limited as { reason?: string }).reason, "rate_limited");
    assert.match(repliesTo("limits").at(-1)!, /1 message in the last hour/);
    // Someone else still gets through.
    answer("two");
    assert.equal((await solo.handleInbound(connector, inbound("hi", BOB, { channel: ENG }), { wait: true })).status, "done");

    solo.updateAgent(soloAgentId, { budget: { dailyRuns: 2 } });
    const capped = await solo.handleInbound(connector, inbound("hi", { id: "U3", name: "cy" }, { channel: ENG }), { wait: true });
    assert.equal((capped as { reason?: string }).reason, "over_budget");
    assert.match(repliesTo("limits").at(-1)!, /limit of 2 messages for today/);
  } finally {
    await cleanup();
  }
});

test("agents and connectors saved before teams read with open defaults", async () => {
  const { solo, soloAgentId, cleanup } = await open();
  try {
    const row = solo.db.get<{ data: string }>("SELECT data FROM agents WHERE id = ?", soloAgentId)!;
    const { budget: _b, chatAccess: _c, ...old } = JSON.parse(row.data) as Record<string, unknown>;
    solo.db.run("UPDATE agents SET data = ? WHERE id = ?", JSON.stringify(old), soloAgentId);
    const agent = solo.agents.get(soloAgentId)!;
    assert.deepEqual(agent.budget, { dailyUsd: null, dailyRuns: null });
    assert.equal(agent.chatAccess, false);
    solo.db.run("INSERT INTO connectors (id, kind, data, secrets, created_at, updated_at) VALUES ('web_old', 'webhook', ?, NULL, 0, 0)", JSON.stringify({ name: "Old", enabled: false, agentId: null, config: {} }));
    const connector = solo.connectors.get("web_old")!;
    assert.deepEqual(connector.access, { users: [], channels: [], agents: [] });
    assert.deepEqual(connector.limits, { perUserPerHour: null });
  } finally {
    await cleanup();
  }
});

// ───────────────────────────── server: roles, sign-in, invites, token rotation ─────────────────────────────

function http(app: ReturnType<typeof createApp>) {
  return async (method: string, path: string, options: { body?: unknown; token?: string; cookie?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.cookie) headers.cookie = options.cookie;
    const response = await app.fetch(new Request(`http://solo.test/api${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }));
    const text = await response.text();
    const cookie = /solo_session=[^;]*/.exec(response.headers.get("set-cookie") ?? "")?.[0];
    return { status: response.status, json: (text ? JSON.parse(text) : undefined) as Record<string, unknown> & { error?: string }, cookie };
  };
}

test("members can chat and read, but only admins manage; the admin token stays the superuser", async () => {
  const { solo, answer, soloAgentId, cleanup } = await open();
  try {
    const call = http(createApp({ solo }));
    await solo.team.createUser({ name: "Mia", role: "member", password: "correct horse" });

    assert.equal((await call("GET", "/agents")).status, 401);
    assert.equal((await call("POST", "/session", { body: { name: "mia", password: "wrong password" } })).status, 401);
    const login = await call("POST", "/session", { body: { name: "mia", password: "correct horse" } });
    assert.equal(login.status, 200);
    const cookie = login.cookie!;
    assert.match(cookie, /^solo_session=sas_/);

    const me = await call("GET", "/me", { cookie });
    assert.deepEqual((me.json as { actor: unknown }).actor, { kind: "user", userId: solo.team.users()[0]!.id, name: "Mia", role: "member" });

    // Reading and chatting
    assert.equal((await call("GET", "/agents", { cookie })).status, 200);
    assert.equal((await call("GET", "/usage", { cookie })).status, 200);
    assert.equal((await call("GET", "/spend/today", { cookie })).status, 200);
    assert.equal((await call("GET", "/mcp-servers", { cookie })).status, 200);
    assert.equal((await call("GET", `/agents/${soloAgentId}/memories`, { cookie })).status, 200);
    const thread = await call("POST", "/threads", { cookie, body: {} });
    assert.equal(thread.status, 201);
    answer("hi mia");
    const asked = await call("POST", `/threads/${thread.json.id}/ask`, { cookie, body: { text: "hello", author: "Someone Else" } });
    assert.equal(asked.json.answer, "hi mia");
    const { messages } = await solo.messages(String(thread.json.id));
    const user = messages.find((m) => m.kind === "user");
    assert.equal(user?.kind === "user" && user.author.name, "Mia", "members always speak as themselves");

    // Managing
    for (const [method, path, body] of [
      ["POST", "/agents", { name: "X" }],
      ["PATCH", `/agents/${soloAgentId}`, { name: "Y" }],
      ["DELETE", `/agents/${soloAgentId}`, undefined],
      ["PUT", "/providers/groq/key", { key: "k" }],
      ["POST", "/connectors", { kind: "webhook" }],
      ["GET", "/users", undefined],
      ["POST", "/invites", { role: "admin" }],
      ["POST", "/admin-token/rotate", undefined],
      ["POST", "/mcp-servers", { id: "gh", transport: "http", url: "https://example.com/mcp" }],
      ["POST", `/agents/${soloAgentId}/memories`, { text: "x" }],
      ["DELETE", `/agents/${soloAgentId}/memories?confirm=all`, undefined],
    ] as const) {
      const response = await call(method, path, { cookie, body });
      assert.equal(response.status, 403, `${method} ${path}`);
    }

    // The admin token can do all of it.
    assert.equal((await call("POST", "/agents", { token: "t", body: { name: "Helper" } })).status, 201);
    assert.equal((await call("GET", "/users", { token: "t" })).status, 200);
    // Promote Mia: her existing session now has admin rights.
    const mia = solo.team.users()[0]!;
    assert.equal((await call("PATCH", `/users/${mia.id}`, { token: "t", body: { role: "admin" } })).status, 200);
    assert.equal((await call("GET", "/users", { cookie })).status, 200);
    // Budget 429 over HTTP
    solo.updateAgent(soloAgentId, { budget: { dailyRuns: 1 } });
    const blocked = await call("POST", `/threads/${thread.json.id}/messages`, { cookie, body: { text: "more" } });
    assert.equal(blocked.status, 429);
    assert.match(blocked.json.error!, /limit of 1 message for today/);
    // Removing a user ends their sessions.
    assert.equal((await call("DELETE", `/users/${mia.id}`, { token: "t" })).status, 200);
    assert.equal((await call("GET", "/me", { cookie })).status, 401);
  } finally {
    await cleanup();
  }
});

test("invite links: one-time, expire, set name and password, and sign the invitee in", async () => {
  const { solo, cleanup } = await open();
  try {
    const call = http(createApp({ solo }));
    const created = await call("POST", "/invites", { token: "t", body: { role: "member", name: "Ann" } });
    assert.equal(created.status, 201);
    const { code, path, url } = created.json as { code: string; path: string; url: string };
    assert.equal(path, `/invite/${code}`);
    assert.equal(url, `http://solo.test/invite/${code}`);
    assert.equal(solo.team.invites()[0]!.usedAt, null);
    assert.ok(solo.team.invites()[0]!.expiresAt - Date.now() > 6.9 * 86_400_000);

    const peek = await call("GET", `/invite/${code}`);
    assert.deepEqual(peek.json, { role: "member", name: "Ann", expiresAt: solo.team.invites()[0]!.expiresAt });
    assert.equal((await call("GET", "/invite/not-a-code")).status, 410);
    assert.equal((await call("POST", `/invite/${code}`, { body: { name: "Ann", password: "short" } })).status, 400);

    const accepted = await call("POST", `/invite/${code}`, { body: { name: "Ann Lee", password: "a long password" } });
    assert.equal(accepted.status, 201);
    assert.ok(accepted.cookie);
    const me = await call("GET", "/me", { cookie: accepted.cookie });
    assert.equal((me.json as { actor: { name: string; role: string } }).actor.name, "Ann Lee");
    assert.equal((me.json as { actor: { name: string; role: string } }).actor.role, "member");
    assert.equal((await call("POST", `/invite/${code}`, { body: { name: "Again", password: "a long password" } })).status, 410);
    assert.equal(solo.team.users().length, 1);
    // Password sign-in works afterwards.
    assert.equal((await call("POST", "/session", { body: { name: "ann lee", password: "a long password" } })).status, 200);

    // Expired and revoked invites are dead.
    const old = await call("POST", "/invites", { token: "t", body: { role: "admin" } });
    solo.db.run("UPDATE invites SET expires_at = ? WHERE id = ?", Date.now() - 1, (old.json as { invite: { id: string } }).invite.id);
    assert.equal((await call("GET", `/invite/${old.json.code}`)).status, 410);
    const revoked = await call("POST", "/invites", { token: "t", body: { role: "member" } });
    assert.equal((await call("DELETE", `/invites/${(revoked.json as { invite: { id: string } }).invite.id}`, { token: "t" })).status, 200);
    assert.equal((await call("POST", `/invite/${revoked.json.code}`, { body: { name: "Zed", password: "a long password" } })).status, 410);
    // Names are unique, case-insensitively.
    const dup = await call("POST", "/invites", { token: "t", body: { role: "member" } });
    assert.equal((await call("POST", `/invite/${dup.json.code}`, { body: { name: "ANN LEE", password: "a long password" } })).status, 409);
  } finally {
    await cleanup();
  }
});

test("the stored admin token rotates; an env or option token does not", async () => {
  const saved = process.env.SOLOAGENT_TOKEN;
  delete process.env.SOLOAGENT_TOKEN;
  const { solo, cleanup } = await open({});
  try {
    const call = http(createApp({ solo }));
    const old = solo.adminToken;
    assert.equal(((await call("GET", "/me", { token: old })).json as { tokenFromEnv: boolean }).tokenFromEnv, false);
    const rotated = await call("POST", "/admin-token/rotate", { token: old });
    assert.equal(rotated.status, 200);
    const fresh = (rotated.json as { token: string }).token;
    assert.notEqual(fresh, old);
    assert.equal((await call("GET", "/me", { token: old })).status, 401);
    assert.equal((await call("GET", "/me", { token: fresh })).status, 200);
    assert.equal(solo.db.setting("admin_token"), fresh);
  } finally {
    await cleanup();
    if (saved !== undefined) process.env.SOLOAGENT_TOKEN = saved;
  }
  const fixed = await open();
  try {
    assert.throws(() => fixed.solo.rotateAdminToken(), /SOLOAGENT_TOKEN/);
  } finally {
    await fixed.cleanup();
  }
});
