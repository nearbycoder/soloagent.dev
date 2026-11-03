import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Automation } from "@soloagent/client";
import { SoloAgent } from "../src/index.ts";
import { describeCron, nextRun, nextRuns, parseCron, parseSchedule, presetToCron, zonedInstant } from "../src/cron.ts";

const iso = (at: number | undefined) => (at === undefined ? undefined : new Date(at).toISOString());
const runs = (cron: string, tz: string, from: string, n: number) => nextRuns(cron, tz, Date.parse(from), n).map((t) => iso(t));

// ───────────────────────────── cron parser ─────────────────────────────

test("cron: parses lists, ranges, steps, names, and macros", () => {
  const c = parseCron("0,30 9-17/2 1,15 jan-mar mon-fri");
  assert.deepEqual(c.minutes, [0, 30]);
  assert.deepEqual(c.hours, [9, 11, 13, 15, 17]);
  assert.deepEqual([...c.days], [1, 15]);
  assert.deepEqual([...c.months], [1, 2, 3]);
  assert.deepEqual([...c.weekdays], [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron("*/15 * * * *").minutes, [0, 15, 30, 45]);
  assert.deepEqual(parseCron("5/20 * * * *").minutes, [5, 25, 45]);
  assert.deepEqual([...parseCron("0 0 * * 7").weekdays], [0], "7 is Sunday");
  assert.deepEqual([...parseCron("0 0 * * SUN,sat").weekdays].sort(), [0, 6]);
  assert.deepEqual([...parseCron("0 0 * * *").weekdays].length, 7);
  assert.equal(parseCron("@daily").minutes.length, 1);
  assert.equal(parseCron("  0   9 *  * 1-5 ").source, "0 9 * * 1-5");
});

test("cron: rejects malformed expressions with a helpful message", () => {
  for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "5-1 * * * *", "*/0 * * * *", "x * * * *", "1,,2 * * * *"]) {
    assert.throws(() => parseCron(bad), Error, bad);
  }
  assert.throws(() => parseCron("61 * * * *"), /out of range/);
});

test("cron: next runs in UTC, with day-of-month OR day-of-week like classic cron", () => {
  assert.deepEqual(runs("0 9 * * 1-5", "UTC", "2026-11-06T10:00:00Z", 3), ["2026-11-09T09:00:00.000Z", "2026-11-10T09:00:00.000Z", "2026-11-11T09:00:00.000Z"]);
  assert.deepEqual(runs("*/20 * * * *", "UTC", "2026-11-03T10:05:30Z", 3), ["2026-11-03T10:20:00.000Z", "2026-11-03T10:40:00.000Z", "2026-11-03T11:00:00.000Z"]);
  // The 13th or any Friday.
  assert.deepEqual(runs("0 0 13 * fri", "UTC", "2026-11-01T00:00:00Z", 3), ["2026-11-06T00:00:00.000Z", "2026-11-13T00:00:00.000Z", "2026-11-20T00:00:00.000Z"]);
  // Strictly after: an exact match is not returned again.
  assert.equal(iso(nextRun("0 9 * * *", "UTC", Date.parse("2026-11-03T09:00:00Z"))), "2026-11-04T09:00:00.000Z");
  // Leap day and impossible dates.
  assert.equal(iso(nextRun("0 0 29 2 *", "UTC", Date.parse("2026-01-01T00:00:00Z"))), "2028-02-29T00:00:00.000Z");
  assert.equal(nextRun("0 0 30 2 *", "UTC", Date.parse("2026-01-01T00:00:00Z")), undefined);
});

test("cron: next runs follow the time zone, including half-hour offsets and the date line", () => {
  assert.deepEqual(runs("0 9 * * 1-5", "America/Chicago", "2026-11-03T20:00:00Z", 2), ["2026-11-04T15:00:00.000Z", "2026-11-05T15:00:00.000Z"]);
  assert.deepEqual(runs("0 9 * * *", "Asia/Kolkata", "2026-11-03T00:00:00Z", 1), ["2026-11-03T03:30:00.000Z"]);
  assert.deepEqual(runs("0 9 * * *", "Pacific/Auckland", "2026-11-03T00:00:00Z", 1), ["2026-11-03T20:00:00.000Z"]);
  // Monday in Tokyo is still Sunday in UTC.
  assert.deepEqual(runs("0 8 * * mon", "Asia/Tokyo", "2026-11-01T00:00:00Z", 1), ["2026-11-01T23:00:00.000Z"]);
});

test("cron: DST spring forward fires a skipped time once, right after the jump", () => {
  // America/Chicago jumps 02:00 → 03:00 on 2026-03-08.
  assert.deepEqual(runs("30 2 * * *", "America/Chicago", "2026-03-07T00:00:00Z", 3), [
    "2026-03-07T08:30:00.000Z", // 02:30 CST
    "2026-03-08T08:00:00.000Z", // 03:00 CDT: 02:30 does not exist
    "2026-03-09T07:30:00.000Z", // 02:30 CDT
  ]);
  // Daily at 9 keeps its wall time across the change.
  assert.deepEqual(runs("0 9 * * *", "America/Chicago", "2026-03-07T00:00:00Z", 2), ["2026-03-07T15:00:00.000Z", "2026-03-08T14:00:00.000Z"]);
  // Intervals stay monotonic through the gap.
  assert.deepEqual(runs("*/20 * * * *", "America/Chicago", "2026-03-08T07:30:00Z", 4), [
    "2026-03-08T07:40:00.000Z",
    "2026-03-08T08:00:00.000Z",
    "2026-03-08T08:20:00.000Z",
    "2026-03-08T08:40:00.000Z",
  ]);
  // Southern hemisphere: Sydney jumps 02:00 → 03:00 on 2026-10-04.
  assert.deepEqual(runs("15 2 * * *", "Australia/Sydney", "2026-10-02T00:00:00Z", 3), ["2026-10-02T16:15:00.000Z", "2026-10-03T16:00:00.000Z", "2026-10-04T15:15:00.000Z"]);
});

test("cron: DST fall back runs a repeated time once, on its first occurrence", () => {
  // America/Chicago repeats 01:00-02:00 on 2026-11-01.
  assert.deepEqual(runs("30 1 * * *", "America/Chicago", "2026-10-31T00:00:00Z", 3), ["2026-10-31T06:30:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-02T07:30:00.000Z"]);
  // Europe/London repeats 01:00-02:00 on 2026-10-25: hourly runs at 01:00 BST, then 02:00 GMT.
  assert.deepEqual(runs("0 * * * *", "Europe/London", "2026-10-24T23:30:00Z", 3), ["2026-10-25T00:00:00.000Z", "2026-10-25T02:00:00.000Z", "2026-10-25T03:00:00.000Z"]);
  assert.equal(iso(zonedInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/Chicago")), "2026-11-01T06:30:00.000Z");
});

test("schedules: presets and phrases become cron, and cron reads back as words", () => {
  assert.equal(presetToCron({ kind: "minutes", every: 15 }), "*/15 * * * *");
  assert.equal(presetToCron({ kind: "hours", every: 2 }), "0 */2 * * *");
  assert.equal(presetToCron({ kind: "daily", time: "17:30" }), "30 17 * * *");
  assert.equal(presetToCron({ kind: "weekdays", time: "09:00" }), "0 9 * * 1-5");
  assert.equal(presetToCron({ kind: "weekly", day: 1, time: "9:05" }), "5 9 * * 1");
  assert.throws(() => presetToCron({ kind: "minutes", every: 0 }));
  assert.throws(() => presetToCron({ kind: "daily", time: "25:00" }));

  assert.equal(parseSchedule("weekdays at 9:00"), "0 9 * * 1-5");
  assert.equal(parseSchedule("Every 15 minutes"), "*/15 * * * *");
  assert.equal(parseSchedule("every hour"), "0 * * * *");
  assert.equal(parseSchedule("mondays at 9:30am"), "30 9 * * 1");
  assert.equal(parseSchedule("every friday at 4pm"), "0 16 * * 5");
  assert.equal(parseSchedule("daily at 12am"), "0 0 * * *");
  assert.equal(parseSchedule("0 9 * * MON-FRI"), "0 9 * * mon-fri");
  assert.throws(() => parseSchedule("whenever you feel like it"), /Could not read/);

  assert.equal(describeCron("0 9 * * 1-5"), "Weekdays at 09:00");
  assert.equal(describeCron("0 9 * * mon-fri"), "Weekdays at 09:00");
  assert.equal(describeCron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(describeCron("0 */2 * * *"), "Every 2 hours");
  assert.equal(describeCron("0 * * * *"), "Every hour");
  assert.equal(describeCron("30 17 * * *"), "Daily at 17:30");
  assert.equal(describeCron("0 9 * * 1"), "Mondays at 09:00");
  assert.equal(describeCron("0 9 * * 1,3"), "Mon, Wed at 09:00");
  assert.equal(describeCron("0 8 1 * *"), "Monthly on day 1 at 08:00");
  assert.equal(describeCron("0 9 1-7 * 1"), "Cron 0 9 1-7 * 1");
});

// ───────────────────────────── runtime ─────────────────────────────

type Opened = Awaited<ReturnType<typeof openAt>>;

async function openAt(dir: string, nextAutomationRun?: (a: Automation, after: number) => number | undefined) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false }] });
  // Answer every run, numbered. Set before opening: an overdue automation fires during open().
  let n = 0;
  faux.setResponses(Array.from({ length: 50 }, () => () => fauxAssistantMessage([fauxText(`report ${++n}`)])));
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "t", connectors: false, demo: false, providers: [faux.provider], log: () => {}, nextAutomationRun });
  const agent = solo.agents.list()[0]!;
  if (agent.model?.provider !== "faux") solo.agents.update(agent.id, { model: { provider: "faux", modelId: "faux-1" } });
  return { solo, faux, agentId: agent.id };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function automationMessages(solo: SoloAgent, threadId: string) {
  const { messages } = await solo.messages(threadId, undefined, 200);
  return messages.filter((m) => m.kind === "user" && m.author.name.startsWith("Automation:") && m.author.source === "schedule");
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "solo-automations-"));
}

test("a recurring automation runs repeatedly in its thread and records its status", async () => {
  const dir = tempDir();
  let opened: Opened | undefined;
  try {
    opened = await openAt(dir, (_a, after) => after + 1_200);
    const { solo } = opened;
    const thread = await solo.createThread({ source: "web" });
    const events: string[] = [];
    solo.events.on("event", (e) => {
      if (e.type === "automation.updated") events.push(e.automation.lastStatus ?? "new");
    });
    const automation = await solo.automations.create({ name: "Standup", prompt: "Post the standup summary", preset: { kind: "weekdays", time: "09:00" }, timezone: "America/Chicago", target: { kind: "thread", threadId: thread.id } });
    assert.equal(automation.cron, "0 9 * * 1-5");
    assert.equal(automation.scheduleText, "Weekdays at 09:00");
    assert.equal(automation.agentId, thread.agentId);
    await until(async () => (await automationMessages(solo, thread.id)).length >= 3);
    const user = (await automationMessages(solo, thread.id))[0]!;
    assert.equal(user.kind === "user" && user.author.name, "Automation: Standup");
    assert.equal(user.kind === "user" && user.text, "Post the standup summary");
    await until(() => solo.automations.get(automation.id)?.lastStatus === "ok");
    const after = solo.automations.get(automation.id)!;
    assert.ok(after.lastRunAt && after.nextRunAt && after.nextRunAt > after.lastRunAt);
    assert.ok(events.includes("ok"), "automation.updated events are emitted");
    const { messages } = await solo.messages(thread.id, undefined, 200);
    assert.ok(messages.some((m) => m.kind === "assistant" && /^report \d+$/.test(m.text)));
  } finally {
    await opened?.solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabling stops an automation, enabling resumes it, deleting removes it", async () => {
  const dir = tempDir();
  let opened: Opened | undefined;
  try {
    opened = await openAt(dir, (_a, after) => after + 800);
    const { solo } = opened;
    const thread = await solo.createThread({ source: "web" });
    const automation = await solo.automations.create({ name: "Ping", prompt: "ping", cron: "every 5 minutes", target: { kind: "thread", threadId: thread.id } });
    await until(async () => (await automationMessages(solo, thread.id)).length >= 1);
    const disabled = await solo.automations.update(automation.id, { enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, null);
    const count = (await automationMessages(solo, thread.id)).length;
    await new Promise((r) => setTimeout(r, 2_500));
    assert.equal((await automationMessages(solo, thread.id)).length, count, "no runs while disabled");

    await solo.automations.update(automation.id, { enabled: true });
    await until(async () => (await automationMessages(solo, thread.id)).length > count);

    assert.equal(await solo.automations.delete(automation.id), true);
    assert.equal(solo.automations.get(automation.id), undefined);
    const afterDelete = (await automationMessages(solo, thread.id)).length;
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal((await automationMessages(solo, thread.id)).length, afterDelete, "no runs after delete");
    assert.equal(await solo.automations.delete(automation.id), false);
  } finally {
    await opened?.solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an automation survives a restart and catches up once for missed slots", async () => {
  const dir = tempDir();
  try {
    // First process: the run is due in 1.5 s, but the process "dies" before then.
    const first = await openAt(dir, (_a, after) => after + 1_500);
    const thread = await first.solo.createThread({ source: "web" });
    const automation = await first.solo.automations.create({ name: "Digest", prompt: "Write the digest", cron: "* * * * *", target: { kind: "thread", threadId: thread.id } });
    const due = first.solo.automations.get(automation.id)!.nextRunAt!;
    assert.ok(due > Date.now());
    // Close once the task's sleep is stored.
    await until(async () => (await first.solo.harness.inspect(BACKGROUND_CONTEXT)).tasks.some((t) => t.record.kind === "solo.automation" && t.state.kind === "sleeping"));
    await first.solo.close();

    // Down long enough to miss the slot (and, on a real every-minute schedule, many more).
    await new Promise((r) => setTimeout(r, 2_500));

    const HOUR = 3_600_000;
    const second = await openAt(dir, (_a, after) => after + HOUR);
    try {
      await until(async () => (await automationMessages(second.solo, thread.id)).length >= 1);
      await new Promise((r) => setTimeout(r, 1_500));
      assert.equal((await automationMessages(second.solo, thread.id)).length, 1, "missed slots fire once, not once each");
      const after = second.solo.automations.get(automation.id)!;
      // The next run is planned from now, not from the missed slot.
      assert.ok(after.nextRunAt! > Date.now() + HOUR - 60_000);
      await until(() => second.solo.automations.get(automation.id)?.lastStatus === "ok");
    } finally {
      await second.solo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run now runs immediately and validation rejects bad input", async () => {
  const dir = tempDir();
  let opened: Opened | undefined;
  try {
    opened = await openAt(dir);
    const { solo } = opened;
    const thread = await solo.createThread({ source: "web" });
    await assert.rejects(() => solo.automations.create({ name: "", prompt: "x", cron: "* * * * *", target: { kind: "thread", threadId: thread.id } }), /name is required/);
    await assert.rejects(() => solo.automations.create({ name: "x", prompt: "x", cron: "nope", target: { kind: "thread", threadId: thread.id } }), /Could not read/);
    await assert.rejects(() => solo.automations.create({ name: "x", prompt: "x", cron: "0 0 30 2 *", target: { kind: "thread", threadId: thread.id } }), /never fires/);
    await assert.rejects(() => solo.automations.create({ name: "x", prompt: "x", cron: "* * * * *", timezone: "Mars/Olympus", target: { kind: "thread", threadId: thread.id } }), /Unknown time zone/);
    await assert.rejects(() => solo.automations.create({ name: "x", prompt: "x", cron: "* * * * *", target: { kind: "thread", threadId: "thr_missing" } }), /not found/);

    const automation = await solo.automations.create({ name: "Weekly", prompt: "Summarize last week's deploys", cron: "0 9 * * mon", timezone: "UTC", enabled: false, target: { kind: "thread", threadId: thread.id } });
    assert.equal(automation.nextRunAt, null);
    await solo.automations.runNow(automation.id);
    await until(async () => (await automationMessages(solo, thread.id)).length === 1);
    await until(() => solo.automations.get(automation.id)?.lastStatus === "ok");

    const preview = solo.automations.preview("weekdays at 9:00", "America/Chicago");
    assert.equal(preview.cron, "0 9 * * 1-5");
    assert.equal(preview.text, "Weekdays at 09:00");
    assert.equal(preview.next.length, 5);
  } finally {
    await opened?.solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a channel automation keeps one thread and delivers each run through the connector", async () => {
  const dir = tempDir();
  const received: { thread: string; text: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body) as { thread: string; text: string });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  let opened: Opened | undefined;
  try {
    opened = await openAt(dir, (_a, after) => after + 1_000);
    const { solo } = opened;
    const connector = solo.connectors.create({ kind: "webhook", name: "Ops hook", config: { secret: "s3cret" } });
    const automation = await solo.automations.create({
      name: "Status check",
      prompt: "Check the status page",
      cron: "every hour",
      target: { kind: "channel", connectorId: connector.id, channel: `http://127.0.0.1:${port}/cb`, location: "#ops" },
    });
    assert.deepEqual(automation.target, { kind: "channel", connectorId: connector.id, target: { callbackUrl: `http://127.0.0.1:${port}/cb`, thread: "automation" }, location: "#ops" });
    await until(() => received.length >= 2);
    const threadId = solo.automations.get(automation.id)!.threadId!;
    const thread = solo.thread(threadId)!;
    assert.equal(thread.source, "webhook");
    assert.equal(thread.location, "#ops");
    assert.equal(solo.listThreads().filter((t) => t.connectorId === connector.id).length, 1, "one thread per automation");
    assert.match(received[0]!.text, /^report \d+$/);
  } finally {
    await opened?.solo.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the schedule skill creates, lists, and cancels automations", async () => {
  const dir = tempDir();
  let opened: Opened | undefined;
  try {
    opened = await openAt(dir);
    const { solo, faux } = opened;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("schedule_recurring", { prompt: "List the open incidents", schedule: "weekdays at 9:00", timezone: "America/Chicago", name: "Incidents" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Done: weekdays at 9.")]),
    ]);
    const thread = await solo.createThread({ source: "web" });
    const result = await (await solo.send(thread.id, { text: "every weekday at 9 post the open incidents here", author: { name: "ann", source: "web" } })).wait();
    assert.equal(result.status, "done");
    const [automation] = solo.automations.list();
    assert.ok(automation);
    assert.equal(automation.name, "Incidents");
    assert.equal(automation.cron, "0 9 * * 1-5");
    assert.equal(automation.timezone, "America/Chicago");
    assert.deepEqual(automation.target, { kind: "thread", threadId: thread.id });
    assert.equal(automation.createdBy, "@solo");
    assert.ok(automation.nextRunAt && automation.nextRunAt > Date.now());

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_automations", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("cancel_automation", { id: automation.id })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Cancelled.")]),
    ]);
    await (await solo.send(thread.id, { text: "list and cancel it", author: { name: "ann", source: "web" } })).wait();
    const { messages } = await solo.messages(thread.id, undefined, 200);
    const tools = messages.filter((m) => m.kind === "tool");
    assert.ok(tools.some((m) => m.kind === "tool" && m.name === "list_automations" && m.text.includes("Weekdays at 09:00 (America/Chicago)")));
    assert.ok(tools.some((m) => m.kind === "tool" && m.name === "cancel_automation" && !m.isError));
    assert.equal(solo.automations.list().length, 0);
  } finally {
    await opened?.solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
