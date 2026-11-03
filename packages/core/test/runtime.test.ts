import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SoloAgent } from "../src/index.ts";

async function open() {
  const dir = mkdtempSync(join(tmpdir(), "solo-test-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false }] });
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "t", connectors: false, demo: false, providers: [faux.provider], log: () => {} });
  const agent = solo.agents.list()[0]!;
  solo.agents.update(agent.id, { model: { provider: "faux", modelId: "faux-1" } });
  return { solo, faux, dir, agentId: agent.id, cleanup: async () => { await solo.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("seeds a default agent and answers in a web thread", async () => {
  const { solo, faux, agentId, cleanup } = await open();
  try {
    assert.equal(solo.agents.list().length, 1);
    faux.setResponses([fauxAssistantMessage([fauxText("Hello from solo!")])]);
    const thread = await solo.createThread({ source: "web" });
    assert.equal(thread.agentId, agentId);
    const sent = await solo.send(thread.id, { text: "hi there", author: { name: "ann", source: "web" } });
    const result = await sent.wait();
    assert.deepEqual(result, { status: "done", answer: "Hello from solo!" });
    const { messages } = await solo.messages(thread.id);
    assert.deepEqual(messages.map((m) => m.kind), ["user", "assistant"]);
    assert.equal(messages[0]!.kind === "user" && messages[0]!.author.name, "ann");
    const t = solo.thread(thread.id)!;
    assert.equal(t.title, "hi there");
    assert.equal(t.preview, "Hello from solo!");
  } finally {
    await cleanup();
  }
});

test("memory skill tool calls persist and render", async () => {
  const { solo, faux, agentId, cleanup } = await open();
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("remember", { note: "ann prefers tea" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Noted.")]),
    ]);
    const thread = await solo.createThread({ source: "web" });
    const result = await (await solo.send(thread.id, { text: "remember I like tea", author: { name: "ann", source: "web" } })).wait();
    assert.equal(result.status, "done");
    const rows = solo.db.all<{ text: string }>("SELECT text FROM memories WHERE agent_id = ?", agentId);
    assert.deepEqual(rows.map((r) => r.text), ["ann prefers tea"]);
    const { messages } = await solo.messages(thread.id);
    assert.deepEqual(messages.map((m) => m.kind), ["user", "assistant", "tool", "assistant"]);
  } finally {
    await cleanup();
  }
});

test("ask_agent delegates to another agent through a durable child conversation", async () => {
  const { solo, faux, cleanup } = await open();
  try {
    solo.createAgent({ name: "Coder", handle: "coder", model: { provider: "faux", modelId: "faux-1" } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ask_agent", { agent: "coder", task: "what is 2+2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("4")]),
      fauxAssistantMessage([fauxText("Coder says 4.")]),
    ]);
    const thread = await solo.createThread({ source: "web" });
    const result = await (await solo.send(thread.id, { text: "ask coder", author: { name: "ann", source: "web" } })).wait();
    assert.deepEqual(result, { status: "done", answer: "Coder says 4." });
    const { messages } = await solo.messages(thread.id);
    const tool = messages.find((m) => m.kind === "tool");
    assert.ok(tool && tool.kind === "tool" && tool.text.includes("@coder answered"));
  } finally {
    await cleanup();
  }
});

test("webhook connector routes @handles and answers synchronously", async () => {
  const { solo, faux, cleanup } = await open();
  try {
    solo.createAgent({ name: "Coder", handle: "coder", model: { provider: "faux", modelId: "faux-1" } });
    const hook = solo.connectors.create({ kind: "webhook", config: { secret: "s3cret" } });
    await new Promise((r) => setTimeout(r, 50));
    faux.setResponses([fauxAssistantMessage([fauxText("deploy looks green")])]);
    await assert.rejects(solo.receiveWebhook(hook.id, "nope", { text: "x" }));
    const result = await solo.receiveWebhook(hook.id, "s3cret", { text: "@coder how is the deploy?", thread: "ci", user: "ci-bot" });
    assert.equal((result as { answer?: string }).answer, "deploy looks green");
    const threads = solo.listThreads({ source: "webhook" });
    assert.equal(threads.length, 1);
    assert.equal(solo.agents.get(threads[0]!.agentId)!.handle, "coder");
  } finally {
    await cleanup();
  }
});

test("a scheduled reminder survives a restart and fires afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "solo-test-"));
  const openAt = async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false }] });
    const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "t", connectors: false, demo: false, providers: [faux.provider], log: () => {} });
    return { solo, faux };
  };
  try {
    const first = await openAt();
    const agent = first.solo.agents.list()[0]!;
    first.solo.agents.update(agent.id, { model: { provider: "faux", modelId: "faux-1" } });
    const at = new Date(Date.now() + 6_500).toISOString();
    first.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("schedule_reminder", { message: "stretch", at })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Reminder set.")]),
    ]);
    const thread = await first.solo.createThread({ source: "web" });
    await (await first.solo.send(thread.id, { text: "remind me to stretch", author: { name: "ann", source: "web" } })).wait();
    assert.equal(first.solo.schedules()[0]?.status, "sleeping");
    await first.solo.close(); // the process "dies" while the reminder sleeps

    const second = await openAt();
    second.faux.setResponses([fauxAssistantMessage([fauxText("⏰ Time to stretch, ann!")])]);
    const deadline = Date.now() + 15_000;
    while (second.solo.thread(thread.id)?.preview !== "⏰ Time to stretch, ann!" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.equal(second.solo.thread(thread.id)?.preview, "⏰ Time to stretch, ann!");
    assert.equal(second.solo.schedules()[0]?.status, "done");
    await second.solo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
