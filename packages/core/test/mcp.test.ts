import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createApp } from "@soloagent/server";
import type { Memory, Message } from "@soloagent/client";
import { SECRET_MASK, SoloAgent } from "../src/index.ts";

const SERVER = join(import.meta.dirname, "mcp-test-server.mjs");

async function open() {
  const dir = mkdtempSync(join(tmpdir(), "solo-mcp-test-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false }] });
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "t", connectors: false, demo: false, providers: [faux.provider], log: () => {} });
  const agent = solo.agents.list()[0]!;
  solo.agents.update(agent.id, { model: { provider: "faux", modelId: "faux-1" } });
  return {
    solo,
    faux,
    agentId: agent.id,
    cleanup: async () => {
      await solo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function run(solo: SoloAgent, agentId: string, text: string) {
  const thread = await solo.createThread({ source: "web", agentId });
  const result = await (await solo.send(thread.id, { text, author: { name: "ann", source: "web" } })).wait();
  const { messages } = await solo.messages(thread.id);
  return { result, tools: messages.filter((m): m is Extract<Message, { kind: "tool" }> => m.kind === "tool") };
}

test("an agent with an MCP server selected calls its tools through the MCP client", async () => {
  const { solo, faux, agentId, cleanup } = await open();
  process.env.SOLO_TEST_LEAK = "should-not-reach-the-server";
  try {
    const created = solo.mcp.create({ id: "test", name: "Test", command: process.execPath, args: [SERVER], env: { TEST_TOKEN: "tok_123" } });
    assert.equal(created.env.TEST_TOKEN, SECRET_MASK);
    const tested = await solo.mcp.test("test");
    assert.equal(tested.ok, true, tested.error ?? "");
    assert.equal(tested.server.status, "connected");
    assert.equal(tested.server.serverInfo, "test-server 1.0.0");
    assert.deepEqual(
      tested.tools.map((t) => t.toolName),
      ["mcp__test__echo", "mcp__test__env", "mcp__test__fail", "mcp__test__crash"],
    );
    assert.equal(tested.server.deferred, false);
    // Env values are sealed at rest.
    const row = solo.db.get<{ data: string; secrets: string }>("SELECT * FROM mcp_servers WHERE id = 'test'")!;
    assert.ok(!row.secrets.includes("tok_123") && !row.data.includes("tok_123"));

    solo.agents.update(agentId, { mcpServers: ["test"] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("mcp__test__echo", { text: "hi" }), fauxToolCall("mcp__test__env", {}), fauxToolCall("mcp__test__fail", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const { result, tools } = await run(solo, agentId, "use the test server");
    assert.equal(result.status, "done");
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.equal(byName.get("mcp__test__echo")?.text, "echo: hi");
    assert.equal(byName.get("mcp__test__echo")?.isError, false);
    // The server got its own env, not soloagent's.
    assert.deepEqual(JSON.parse(byName.get("mcp__test__env")!.text), { token: "tok_123", leak: null });
    assert.equal(byName.get("mcp__test__fail")?.isError, true);
    assert.equal(byName.get("mcp__test__fail")?.text, "something broke");

    // Saving the masked value keeps the secret.
    solo.mcp.update("test", { env: { TEST_TOKEN: SECRET_MASK } });
    assert.equal((await solo.mcp.test("test")).ok, true);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__test__env", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
    const again = await run(solo, agentId, "env again");
    assert.equal(JSON.parse(again.tools[0]!.text).token, "tok_123");
  } finally {
    delete process.env.SOLO_TEST_LEAK;
    await cleanup();
  }
});

test("an agent without the server selected cannot call its tools", async () => {
  const { solo, faux, agentId, cleanup } = await open();
  try {
    solo.mcp.create({ id: "test", command: process.execPath, args: [SERVER] });
    assert.equal((await solo.mcp.test("test")).ok, true);
    const other = solo.createAgent({ name: "Other", handle: "other", model: { provider: "faux", modelId: "faux-1" } });
    solo.agents.update(agentId, { mcpServers: ["test"] });
    assert.deepEqual(other.mcpServers, []);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__test__echo", { text: "hi" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
    const { tools } = await run(solo, other.id, "try it");
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.isError, true);
    assert.ok(!tools[0]!.text.includes("echo: hi"), tools[0]!.text);
  } finally {
    await cleanup();
  }
});

test("broken servers get an error status instead of throwing", async () => {
  const { solo, cleanup } = await open();
  try {
    solo.mcp.create({ id: "missing", command: "/definitely/not/a/real/mcp-server" });
    solo.mcp.create({ id: "crashes", command: process.execPath, args: ["-e", "console.error('boom: bad config'); process.exit(3)"] });
    const port = await closedPort();
    solo.mcp.create({ id: "remote", transport: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer x" } });
    assert.throws(() => solo.mcp.create({ id: "Bad Id!", command: "x" }), /id must be/);
    assert.throws(() => solo.mcp.create({ id: "nourl", transport: "http", url: "ftp://x" }), /http/);

    const missing = await solo.mcp.test("missing");
    assert.equal(missing.ok, false);
    assert.equal(missing.server.status, "error");
    assert.match(missing.error!, /not found/i);
    const crashes = await solo.mcp.test("crashes");
    assert.equal(crashes.server.status, "error");
    assert.match(crashes.server.statusDetail!, /boom: bad config/);
    const remote = await solo.mcp.test("remote");
    assert.equal(remote.server.status, "error");
    assert.equal(remote.server.headers.Authorization, SECRET_MASK);
    // A retry is scheduled, and nothing is registered for agents.
    assert.match(solo.mcp.get("missing")!.statusDetail!, /retrying in/);
    assert.deepEqual(solo.mcp.extensionsFor(["missing"]).map((e) => e.tools?.length ?? 0), [0]);

    // Disabling stops the retries.
    solo.mcp.update("missing", { enabled: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(solo.mcp.get("missing")!.status, "stopped");
  } finally {
    await cleanup();
  }
});

test("a server that exits is reconnected with backoff", async () => {
  const { solo, faux, agentId, cleanup } = await open();
  try {
    solo.mcp.create({ id: "test", command: process.execPath, args: [SERVER] });
    assert.equal((await solo.mcp.test("test")).ok, true);
    solo.agents.update(agentId, { mcpServers: ["test"] });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__test__crash", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
    const { tools } = await run(solo, agentId, "crash it");
    assert.equal(tools[0]!.text, "bye");
    const seen = new Set<string>();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const status = solo.mcp.get("test")!.status;
      seen.add(status);
      if (seen.has("error") && status === "connected") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(seen.has("error"), [...seen].join());
    assert.equal(solo.mcp.get("test")!.status, "connected");
    faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__test__echo", { text: "back" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
    assert.equal((await run(solo, agentId, "again")).tools[0]!.text, "echo: back");
  } finally {
    await cleanup();
  }
});

test("large tool sets are deferred behind tool_search", async () => {
  const { solo, faux, agentId, cleanup } = await open();
  try {
    solo.mcp.create({ id: "big", command: process.execPath, args: [SERVER], env: { EXTRA_TOOLS: "20" } });
    const tested = await solo.mcp.test("big");
    assert.equal(tested.tools.length, 24);
    assert.equal(tested.server.deferred, true);
    const extension = solo.mcp.extensionsFor(["big"])[0]!;
    assert.ok(extension.tools!.some((t) => t.name === "tool_search"));
    assert.ok(extension.tools!.filter((t) => t.name.startsWith("mcp__")).every((t) => t.deferred === true));

    solo.agents.update(agentId, { mcpServers: ["big"] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo text back" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__big__echo", { text: "loaded" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const { tools } = await run(solo, agentId, "find the echo tool");
    assert.equal(tools[0]!.name, "tool_search");
    assert.match(tools[0]!.text, /mcp__big__echo/);
    assert.equal(tools[1]!.text, "echo: loaded");
    assert.equal(tools[1]!.isError, false);
  } finally {
    await cleanup();
  }
});

test("MCP server and memory routes", async () => {
  const { solo, faux, agentId, cleanup } = await open();
  const app = createApp({ solo });
  const call = async <T = unknown>(method: string, path: string, body?: unknown) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { authorization: "Bearer t", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as T };
  };
  try {
    // MCP servers
    const created = await call<{ id: string; env: Record<string, string> }>("POST", "/mcp-servers", { id: "test", command: process.execPath, args: [SERVER], env: { TEST_TOKEN: "abc" } });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.env, { TEST_TOKEN: SECRET_MASK });
    assert.equal((await call("POST", "/mcp-servers", { id: "test", command: "x" })).status, 409);
    const tested = await call<{ ok: boolean; tools: { name: string; description: string }[] }>("POST", "/mcp-servers/test/test");
    assert.equal(tested.body.ok, true);
    assert.deepEqual(tested.body.tools[0], { name: "echo", toolName: "mcp__test__echo", description: "Echo the given text back." });
    const listed = await call<{ id: string; env: Record<string, string> }[]>("GET", "/mcp-servers");
    assert.equal(JSON.stringify(listed.body).includes("abc"), false);
    const renamed = await call<{ name: string }>("PATCH", "/mcp-servers/test", { name: "Renamed" });
    assert.equal(renamed.body.name, "Renamed");
    const agent = await call<{ mcpServers: string[] }>("PATCH", `/agents/${agentId}`, { mcpServers: ["test", "test", "NOT VALID"] });
    assert.deepEqual(agent.body.mcpServers, ["test"]);
    assert.equal((await call("DELETE", "/mcp-servers/test")).status, 200);
    assert.equal((await call("GET", "/mcp-servers/test")).status, 404);

    // Memories, including ones the agent saved itself
    faux.setResponses([fauxAssistantMessage([fauxToolCall("remember", { note: "ann prefers tea" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Noted.")])]);
    await run(solo, agentId, "remember I like tea");
    const added = await call<Memory>("POST", `/agents/${agentId}/memories`, { text: "  the deploy key lives in 1Password  " });
    assert.equal(added.status, 201);
    assert.equal(added.body.text, "the deploy key lives in 1Password");
    assert.equal((await call("POST", `/agents/${agentId}/memories`, { text: "  " })).status, 400);
    const all = await call<Memory[]>("GET", `/agents/${agentId}/memories`);
    assert.deepEqual(all.body.map((m) => m.text), ["the deploy key lives in 1Password", "ann prefers tea"]);
    const found = await call<Memory[]>("GET", `/agents/${agentId}/memories?q=${encodeURIComponent("TEA ann")}`);
    assert.deepEqual(found.body.map((m) => m.text), ["ann prefers tea"]);
    assert.deepEqual((await call<Memory[]>("GET", `/agents/${agentId}/memories?q=100%25`)).body, []);
    const edited = await call<Memory>("PATCH", `/agents/${agentId}/memories/${added.body.id}`, { text: "deploy key: 1Password vault Ops" });
    assert.equal(edited.body.text, "deploy key: 1Password vault Ops");
    assert.equal(edited.body.createdAt, added.body.createdAt);
    assert.deepEqual((await call("GET", "/memories/counts")).body, { [agentId]: 2 });
    // The handle works too, and other agents' memories are out of reach.
    const other = solo.createAgent({ name: "Other", handle: "other" });
    assert.equal((await call("PATCH", `/agents/${other.id}/memories/${added.body.id}`, { text: "x" })).status, 404);
    assert.equal((await call("DELETE", `/agents/other/memories/${added.body.id}`)).status, 404);
    assert.equal((await call("DELETE", `/agents/solo/memories/${added.body.id}`)).status, 200);
    assert.equal((await call("GET", `/agents/nobody/memories`)).status, 404);
    // Clearing needs confirmation.
    assert.equal((await call("DELETE", `/agents/${agentId}/memories`)).status, 400);
    const cleared = await call<{ deleted: number }>("DELETE", `/agents/${agentId}/memories?confirm=all`);
    assert.equal(cleared.body.deleted, 1);
    assert.deepEqual((await call<Memory[]>("GET", `/agents/${agentId}/memories`)).body, []);
    assert.equal((await app.request(`/api/agents/${agentId}/memories`)).status, 401);
  } finally {
    await cleanup();
  }
});

/** A local port with nothing listening on it. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
