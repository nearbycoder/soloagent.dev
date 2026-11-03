import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Approval } from "@soloagent/client";
import { SoloAgent } from "../src/index.ts";
import { approvalAction, canApproveInChat, needsApproval, parseApprovalAction } from "../src/approvals.ts";

const BASH = { command: "echo ran >> ran.txt" };

async function openAt(dir: string) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false }] });
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "t", connectors: false, demo: false, providers: [faux.provider], log: () => {} });
  return { solo, faux };
}

/** A fresh install whose default agent has the workspace skill (so approvals default to "risky"). */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "solo-approvals-"));
  const { solo, faux } = await openAt(dir);
  const seeded = solo.agents.list()[0]!;
  const agent = solo.agents.update(seeded.id, { model: { provider: "faux", modelId: "faux-1" }, skills: [...seeded.skills, "workspace"] });
  const ranFile = join(dir, "workspaces", agent.handle, "ran.txt");
  return { dir, solo, faux, agent, ranFile, runs: () => (existsSync(ranFile) ? readFileSync(ranFile, "utf8").split("\n").filter(Boolean).length : 0) };
}

async function until<T>(get: () => T | undefined | false, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const pending = (solo: SoloAgent) => () => solo.listApprovals({ status: "pending" })[0];

test("policy helpers", () => {
  assert.equal(needsApproval("off", "bash"), false);
  assert.equal(needsApproval("risky", "bash"), true);
  assert.equal(needsApproval("risky", "read"), false);
  assert.equal(needsApproval("risky", "web_fetch"), false);
  assert.equal(needsApproval("risky", "forget", ["forget"]), true);
  assert.equal(needsApproval("all", "remember"), true);
  assert.equal(needsApproval("all", "web_search"), false);
  assert.equal(canApproveInChat([], { id: "U1", name: "ann" }), false);
  assert.equal(canApproveInChat(["U1"], { id: "U1", name: "someone" }), true);
  assert.equal(canApproveInChat(["@Ann"], { id: "U9", name: "ann" }), true);
  assert.equal(canApproveInChat(["ann"], { id: "U9", name: "bob" }), false);
  assert.deepEqual(parseApprovalAction(approvalAction("apr_abc123", true)), { id: "apr_abc123", approve: true });
  assert.deepEqual(parseApprovalAction(approvalAction("apr_abc123", false)), { id: "apr_abc123", approve: false });
  assert.equal(parseApprovalAction("something else"), undefined);
  assert.ok(approvalAction("apr_mf3k2xxxxxxxxxx", true).length <= 64); // Telegram callback_data limit
});

test("approvals default to risky with the workspace skill and off without", async () => {
  const { solo, dir, agent } = await setup();
  try {
    assert.equal(agent.approvals, "risky");
    assert.equal(solo.createAgent({ name: "Plain" }).approvals, "off");
    assert.equal(solo.createAgent({ name: "Builder", skills: ["workspace"] }).approvals, "risky");
    assert.equal(solo.createAgent({ name: "Yolo", skills: ["workspace"], approvals: "off" }).approvals, "off");
  } finally {
    await solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a risky tool waits for approval, then runs once", async () => {
  const { solo, faux, dir, runs } = await setup();
  try {
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", BASH)], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Done.")])]);
    const thread = await solo.createThread({ source: "web" });
    const sent = await solo.send(thread.id, { text: "run it", author: { name: "ann", source: "web" } });
    const approval = await until(pending(solo));
    assert.equal(approval.tool, "bash");
    assert.deepEqual(approval.args, BASH);
    assert.equal(approval.threadId, thread.id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(runs(), 0, "nothing runs before approval");
    assert.equal(solo.thread(thread.id)?.waitingApproval, true);
    const snapshot = await solo.snapshot(thread.id);
    assert.equal(snapshot.live.approvals?.[0]?.id, approval.id);
    assert.equal(snapshot.live.tools[0]?.callId, approval.callId);

    const decided = solo.decideApproval(approval.id, { approve: true });
    assert.equal(decided.status, "approved");
    assert.equal(decided.decidedBy, "dashboard");
    assert.throws(() => solo.decideApproval(approval.id, { approve: false }), /Already approved/);
    assert.deepEqual(await sent.wait(), { status: "done", answer: "Done." });
    assert.equal(runs(), 1);
    assert.equal(solo.thread(thread.id)?.waitingApproval, undefined);
  } finally {
    await solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a denied call returns an error result and the model continues", async () => {
  const { solo, faux, dir, runs } = await setup();
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", BASH)], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("OK, I won't.")]),
    ]);
    const thread = await solo.createThread({ source: "web" });
    const sent = await solo.send(thread.id, { text: "run it", author: { name: "ann", source: "web" } });
    const approval = await until(pending(solo));
    solo.decideApproval(approval.id, { approve: false, by: "ann", reason: "not on prod" });
    assert.deepEqual(await sent.wait(), { status: "done", answer: "OK, I won't." });
    assert.equal(runs(), 0);
    const { messages } = await solo.messages(thread.id);
    const tool = messages.find((m) => m.kind === "tool");
    assert.ok(tool && tool.kind === "tool");
    assert.equal(tool.isError, true);
    assert.equal(tool.text, "Denied by ann: not on prod");
  } finally {
    await solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pending approval survives a restart and the tool runs exactly once", async () => {
  const { solo, faux, dir, runs } = await setup();
  faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", BASH)], { stopReason: "toolUse" })]);
  const thread = await solo.createThread({ source: "web" });
  await solo.send(thread.id, { text: "run it", author: { name: "ann", source: "web" } });
  const approval = await until(pending(solo));
  await solo.close(); // the process "dies" while the call waits
  try {
    const second = await openAt(dir);
    try {
      second.faux.setResponses([fauxAssistantMessage([fauxText("Ran it after the restart.")])]);
      // Still pending: neither the close nor the reopen decided it.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(second.solo.approvals.get(approval.id)?.status, "pending");
      assert.equal(runs(), 0);
      assert.equal((await second.solo.snapshot(thread.id)).live.approvals?.[0]?.id, approval.id);
      second.solo.decideApproval(approval.id, { approve: true, by: "ann" });
      await until(() => second.solo.thread(thread.id)?.preview === "Ran it after the restart.");
      assert.equal(runs(), 1);
      // A third open must not run it again.
      await second.solo.close();
      const third = await openAt(dir);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(runs(), 1);
      await third.solo.close();
    } catch (error) {
      await second.solo.close().catch(() => {});
      throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unanswered request is auto-denied after the timeout", async () => {
  const { solo, faux, dir, runs } = await setup();
  try {
    solo.setApprovalSettings({ timeoutMs: 1_000 });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", BASH)], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Nobody answered.")]),
    ]);
    const thread = await solo.createThread({ source: "web" });
    const sent = await solo.send(thread.id, { text: "run it", author: { name: "ann", source: "web" } });
    const approval = await until(pending(solo));
    assert.ok(approval.expiresAt - approval.createdAt === 1_000);
    assert.deepEqual(await sent.wait(), { status: "done", answer: "Nobody answered." });
    assert.equal(runs(), 0);
    const expired = solo.approvals.get(approval.id)!;
    assert.equal(expired.status, "expired");
    const tool = (await solo.messages(thread.id)).messages.find((m) => m.kind === "tool");
    assert.ok(tool?.kind === "tool" && /nobody approved/.test(tool.text));
  } finally {
    await solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping the thread cancels a pending request", async () => {
  const { solo, faux, dir, runs } = await setup();
  try {
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", BASH)], { stopReason: "toolUse" })]);
    const thread = await solo.createThread({ source: "web" });
    await solo.send(thread.id, { text: "run it", author: { name: "ann", source: "web" } });
    const approval = await until(pending(solo));
    await solo.stop(thread.id);
    await until(() => solo.approvals.get(approval.id)?.status === "cancelled");
    assert.equal(runs(), 0);
  } finally {
    await solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approvals off runs the tool at once", async () => {
  const { solo, faux, dir, agent, runs } = await setup();
  try {
    solo.agents.update(agent.id, { approvals: "off" });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", BASH)], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Done.")])]);
    const thread = await solo.createThread({ source: "web" });
    const result = await (await solo.send(thread.id, { text: "run it", author: { name: "ann", source: "web" } })).wait();
    assert.deepEqual(result, { status: "done", answer: "Done." });
    assert.equal(runs(), 1);
    assert.equal(solo.listApprovals().length, 0);
  } finally {
    await solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat buttons only count for the connector's approvers", async () => {
  const { solo, faux, dir, runs } = await setup();
  try {
    const hook = solo.connectors.create({ kind: "webhook", config: { secret: "s3cret" } });
    await new Promise((r) => setTimeout(r, 50));
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", BASH)], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Done.")])]);
    await solo.handleInbound(hook, {
      externalKey: "deploys",
      location: "webhook deploys",
      title: "deploys",
      author: { name: "ann", source: "webhook" },
      text: "run it",
      target: { thread: "deploys" },
      isDirect: true,
    });
    const approval: Approval = await until(pending(solo));
    const ann = { id: "U1", name: "Ann" };

    const nobody = await solo.decideFromChat(hook.id, { approvalId: approval.id, approve: true, user: ann });
    assert.equal(nobody.ok, false);
    assert.match(nobody.message, /dashboard/);

    solo.connectors.update(hook.id, { approvers: ["U1", "carol"] });
    assert.deepEqual(solo.connectors.get(hook.id)!.approvers, ["U1", "carol"]);
    const bob = await solo.decideFromChat(hook.id, { approvalId: approval.id, approve: true, user: { id: "U2", name: "bob" } });
    assert.equal(bob.ok, false);
    assert.match(bob.message, /not an approver/);
    const other = await solo.decideFromChat("web_other", { approvalId: approval.id, approve: true, user: ann });
    assert.equal(other.ok, false);
    assert.equal(solo.approvals.get(approval.id)?.status, "pending");

    const ok = await solo.decideFromChat(hook.id, { approvalId: approval.id, approve: true, user: ann });
    assert.deepEqual(ok, { ok: true, message: "Approved." });
    const decided = solo.approvals.get(approval.id)!;
    assert.equal(decided.decidedBy, "Ann");
    assert.equal(decided.decidedVia, "webhook");
    const again = await solo.decideFromChat(hook.id, { approvalId: approval.id, approve: false, user: { id: "x", name: "carol" } });
    assert.equal(again.ok, false);
    assert.match(again.message, /already approved by Ann/);
    await until(() => runs() === 1);
  } finally {
    await solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
