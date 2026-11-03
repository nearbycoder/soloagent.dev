import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, type ConversationId, defineTask, defineTool, type Task } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type {
  Automation,
  AutomationInput,
  AutomationPreview,
  AutomationStatus,
  AutomationTarget,
  AutomationTargetInput,
  ConnectorKind,
} from "@soloagent/client";
import { describeCron, isTimeZone, localTimeZone, nextRun, nextRuns, parseSchedule, presetToCron } from "./cron.ts";
import { newId } from "./db.ts";
import type { SoloAgent } from "./runtime.ts";
import { EVENT_ENTRY, type EventEntryData } from "./transcript.ts";

/**
 * Recurring automations: a prompt that runs on a cron schedule, in an existing thread or a chat channel.
 *
 * Each enabled automation is one durable `solo.automation` task in a dedicated scheduler conversation. The
 * task sleeps until the next fire time, submits the prompt through `SoloAgent.send()` (so connectors deliver
 * the answer as usual), computes the next time, and sleeps again. A run that came due while the server was
 * down fires once on startup, then the schedule continues from the current time: missed slots are not
 * replayed one by one ("catch up once").
 */

type AutomationRow = {
  id: string;
  name: string;
  agent_id: string;
  prompt: string;
  enabled: number;
  cron: string;
  timezone: string;
  target: string;
  thread_id: string | null;
  task_id: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  last_status: AutomationStatus | null;
  last_error: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

type ThreadLookup = { id: string; agent_id: string; source: string; connector_id: string | null; location: string | null; meta: string | null };

/** What the durable task and the agent tools need. */
export interface AutomationHost {
  /** The next fire time after `after`, or undefined when the task should stop (deleted, disabled, or replaced). */
  plan(automationId: string, taskId: string, after: number): number | undefined;
  /** Run the automation for the slot `at`. Idempotent per slot; never throws. */
  fire(automationId: string, taskId: string, at: number): Promise<void>;
  list(): Automation[];
  createFromConversation(conversationId: number, input: { name?: string; prompt: string; schedule: string; timezone?: string; postTo?: "thread" | "channel"; createdBy?: string }): Promise<Automation>;
  delete(id: string): Promise<boolean>;
}

type AutomationState = { phase: "plan" } | { phase: "fire"; at: number };

export type AutomationTask = Task<{ automationId: string }, AutomationState, null, object>;

export function automationTask(host: () => AutomationHost): AutomationTask {
  return defineTask<{ automationId: string }, AutomationState, null>({
    name: "solo.automation",
    version: 1,
    initial: () => ({ phase: "plan" }),
    phases: {
      plan: async (task, runtime, context) => {
        const next = host().plan(task.input.automationId, String(task.id), runtime.now());
        if (next === undefined) return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
        await runtime.sleepUntil(next, { phase: "fire", at: next }, context);
      },
      fire: async (task, runtime, context) => {
        const { at } = task.state.checkpoint;
        const id = task.input.automationId;
        await host().fire(id, String(task.id), at);
        // Plan from now, not from `at`: after downtime, missed slots collapse into the one run above.
        const next = host().plan(id, String(task.id), Math.max(runtime.now(), at));
        if (next === undefined) return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
        await runtime.sleepUntil(next, { phase: "fire", at: next }, context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
}

export function automationTools(host: () => AutomationHost) {
  const format = (a: Automation) =>
    `${a.id} · "${a.name}" · ${a.scheduleText} (${a.timezone})${a.enabled ? "" : " · disabled"} · ${
      a.target.kind === "thread" ? `thread ${a.target.threadId}` : `channel ${a.target.location ?? JSON.stringify(a.target.target)}`
    }${a.nextRunAt ? ` · next ${new Date(a.nextRunAt).toISOString()}` : ""}`;
  return [
    defineTool({
      name: "schedule_recurring",
      description:
        "Create a recurring automation: a prompt you will be given on a schedule, e.g. every weekday at 9:00 post a standup summary. Each run is answered in this conversation by default. Survives restarts.",
      parameters: obj({
        prompt: str({ description: "What to do on each run, written as an instruction to yourself, e.g. 'List the open incidents with owners.'" }),
        schedule: str({
          description:
            "5-field cron (minute hour day month weekday, e.g. '0 9 * * 1-5') or a phrase: 'every 15 minutes', 'every 2 hours', 'daily at 09:00', 'weekdays at 9:00', 'mondays at 9:30'.",
        }),
        name: opt(str({ description: "Short name, e.g. 'Standup summary'" })),
        timezone: opt(str({ description: "IANA time zone, e.g. America/Chicago. Default: the server's." })),
        post_to: opt(
          oneOf(["thread", "channel"], {
            description: "In a chat app: 'thread' (default) answers in this thread; 'channel' posts each run as a new top-level message in this channel.",
          }),
        ),
      }),
      execute: async (args, api, context) => {
        const automation = await host().createFromConversation(Number(api.conversationId), {
          name: args.name,
          prompt: args.prompt,
          schedule: args.schedule,
          timezone: args.timezone,
          postTo: args.post_to,
        });
        await api.commit(async (tx) => {
          await tx.appendEntry(api.conversationId, {
            kind: EVENT_ENTRY,
            data: { text: `Automation "${automation.name}" set: ${automation.scheduleText} (${automation.timezone})`, tone: "info", at: api.now() } satisfies EventEntryData,
          });
        }, context);
        return { output: [{ type: "text", text: `Created automation ${format(automation)}.` }] };
      },
    }),
    defineTool({
      name: "list_automations",
      description: "List recurring automations with their ids, schedules, targets, and next run times.",
      parameters: obj({}),
      replay: "safe",
      execute: async () => {
        const list = host().list();
        return { output: [{ type: "text", text: list.length ? list.map(format).join("\n") : "No automations." }] };
      },
    }),
    defineTool({
      name: "cancel_automation",
      description: "Delete a recurring automation by its id (from list_automations).",
      parameters: obj({ id: str() }),
      execute: async (args) => {
        const ok = await host().delete(args.id.trim());
        return { output: [{ type: "text", text: ok ? `Deleted automation ${args.id}.` : `No automation ${args.id}.` }], isError: !ok };
      },
    }),
  ];
}

/** The reply target for a channel id on a platform. */
export function channelTarget(kind: ConnectorKind, channel: string): Record<string, string> {
  const id = channel.trim();
  switch (kind) {
    case "slack":
      return { channel: id };
    case "discord":
      return { channelId: id };
    case "telegram": {
      // "chatId:topicId" posts into a forum topic.
      const [chatId, threadId] = id.split(":");
      return threadId ? { chatId: chatId!, threadId } : { chatId: chatId! };
    }
    case "webhook":
      return /^https?:\/\//.test(id) ? { callbackUrl: id, thread: "automation" } : { thread: id };
  }
}

/** A thread's reply target without its reply-to parts, so a post starts a new top-level message. */
function topLevel(target: Record<string, string>): Record<string, string> {
  const { thread_ts: _ts, replyTo: _reply, ...rest } = target;
  return rest;
}

export type NextRunFn = (automation: Automation, after: number) => number | undefined;

const ctx = BACKGROUND_CONTEXT;

export class Automations implements AutomationHost {
  readonly #solo: SoloAgent;
  readonly #task: AutomationTask;
  readonly #nextOverride: NextRunFn | undefined;
  #scheduler: Promise<Conversation> | undefined;

  constructor(solo: SoloAgent, task: AutomationTask, nextOverride?: NextRunFn) {
    this.#solo = solo;
    this.#task = task;
    this.#nextOverride = nextOverride;
  }

  // ───────────────────────────── reads ─────────────────────────────

  list(): Automation[] {
    return this.#solo.db.all<AutomationRow>("SELECT * FROM automations ORDER BY created_at ASC").map((r) => this.#toAutomation(r));
  }

  get(id: string): Automation | undefined {
    const row = this.#row(id);
    return row ? this.#toAutomation(row) : undefined;
  }

  /** The next `count` fire times of a schedule, for the dashboard's preview. */
  preview(cron: string, timezone?: string, count = 5): AutomationPreview {
    const expression = parseSchedule(cron);
    const tz = this.#timezone(timezone);
    return { cron: expression, timezone: tz, text: describeCron(expression), next: nextRuns(expression, tz, Date.now(), Math.min(20, Math.max(1, count))) };
  }

  // ───────────────────────────── writes ─────────────────────────────

  async create(input: AutomationInput, createdBy?: string): Promise<Automation> {
    const now = Date.now();
    const draft = this.#validate(input);
    const id = newId("aut");
    this.#solo.db.run(
      `INSERT INTO automations (id, name, agent_id, prompt, enabled, cron, timezone, target, thread_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      draft.name,
      draft.agentId,
      draft.prompt,
      input.enabled === false ? 0 : 1,
      draft.cron,
      draft.timezone,
      JSON.stringify(draft.target),
      draft.target.kind === "thread" ? draft.target.threadId : null,
      createdBy ?? null,
      now,
      now,
    );
    this.#solo.activity({ type: "schedule", text: `Automation "${draft.name}" created: ${describeCron(draft.cron)} (${draft.timezone})`, agentId: draft.agentId });
    await this.#reschedule(id);
    return this.get(id)!;
  }

  async update(id: string, patch: Partial<AutomationInput>): Promise<Automation> {
    const row = this.#row(id);
    if (!row) throw new Error("Automation not found");
    const current = this.#toAutomation(row);
    const merged: AutomationInput = {
      name: patch.name ?? current.name,
      prompt: patch.prompt ?? current.prompt,
      agentId: patch.agentId ?? (patch.target ? undefined : current.agentId),
      cron: patch.preset ? undefined : (patch.cron ?? current.cron),
      preset: patch.preset,
      timezone: patch.timezone ?? current.timezone,
      target: patch.target ?? current.target,
    };
    const draft = this.#validate(merged);
    const enabled = patch.enabled ?? current.enabled;
    // Keep the channel thread when the channel stays on the same connector; follow a new thread target.
    let threadId = row.thread_id;
    if (draft.target.kind === "thread") threadId = draft.target.threadId;
    else if (current.target.kind !== "channel" || current.target.connectorId !== draft.target.connectorId) threadId = null;
    if (threadId && draft.target.kind === "channel") {
      this.#solo.db.run("UPDATE threads SET meta = ?, location = ? WHERE id = ?", JSON.stringify({ target: draft.target.target }), draft.target.location, threadId);
      const thread = this.#solo.thread(threadId);
      if (thread && thread.agentId !== draft.agentId) this.#solo.updateThread(threadId, { agentId: draft.agentId });
    }
    this.#solo.db.run(
      `UPDATE automations SET name = ?, agent_id = ?, prompt = ?, enabled = ?, cron = ?, timezone = ?, target = ?, thread_id = ?, updated_at = ? WHERE id = ?`,
      draft.name,
      draft.agentId,
      draft.prompt,
      enabled ? 1 : 0,
      draft.cron,
      draft.timezone,
      JSON.stringify(draft.target),
      threadId,
      Date.now(),
      id,
    );
    await this.#reschedule(id);
    return this.get(id)!;
  }

  async delete(id: string): Promise<boolean> {
    const row = this.#row(id);
    if (!row) return false;
    if (row.task_id) await this.#abort(row.task_id);
    this.#solo.db.run("DELETE FROM automations WHERE id = ?", id);
    this.#solo.activity({ type: "schedule", text: `Automation "${row.name}" deleted`, agentId: row.agent_id });
    this.#solo.emit({ type: "automation.deleted", automationId: id });
    return true;
  }

  /** Run once now, outside the schedule. Works for disabled automations too. */
  async runNow(id: string): Promise<Automation> {
    const row = this.#row(id);
    if (!row) throw new Error("Automation not found");
    await this.#run(row, `automation:${id}:manual:${Date.now()}`);
    return this.get(id)!;
  }

  async createFromConversation(
    conversationId: number,
    input: { name?: string; prompt: string; schedule: string; timezone?: string; postTo?: "thread" | "channel"; createdBy?: string },
  ): Promise<Automation> {
    const thread = this.#solo.db.get<ThreadLookup>("SELECT id, agent_id, source, connector_id, location, meta FROM threads WHERE conversation_id = ?", conversationId);
    if (!thread) throw new Error("Automations can only be created from a thread");
    let target: AutomationTargetInput = { kind: "thread", threadId: thread.id };
    if (input.postTo === "channel") {
      const replyTarget = (JSON.parse(thread.meta ?? "{}") as { target?: Record<string, string> }).target;
      if (!thread.connector_id || !replyTarget) throw new Error("post_to 'channel' works only in a chat app thread (Slack, Discord, Telegram)");
      target = { kind: "channel", connectorId: thread.connector_id, target: topLevel(replyTarget), location: thread.location };
    }
    const agent = this.#solo.agents.get(thread.agent_id);
    const name = input.name?.trim() || input.prompt.trim().replace(/\s+/g, " ").slice(0, 48);
    return this.create(
      { name, prompt: input.prompt, cron: input.schedule, timezone: input.timezone, agentId: thread.agent_id, target },
      input.createdBy ?? (agent ? `@${agent.handle}` : "agent"),
    );
  }

  // ───────────────────────────── the durable task's callbacks ─────────────────────────────

  plan(automationId: string, taskId: string, after: number): number | undefined {
    const row = this.#row(automationId);
    if (!row || !row.enabled || row.task_id !== taskId) return undefined;
    const next = this.#next(row, after);
    this.#solo.db.run("UPDATE automations SET next_run_at = ? WHERE id = ?", next ?? null, automationId);
    this.#emit(automationId);
    return next;
  }

  async fire(automationId: string, taskId: string, at: number): Promise<void> {
    const row = this.#row(automationId);
    if (!row || !row.enabled || row.task_id !== taskId) return;
    // The slot is the request id: a phase that reruns after a crash finds the same submission.
    await this.#run(row, `automation:${automationId}:${at}`);
  }

  // ───────────────────────────── internals ─────────────────────────────

  async #run(row: AutomationRow, requestId: string) {
    const now = Date.now();
    const target = JSON.parse(row.target) as AutomationTarget;
    try {
      const threadId = await this.#ensureThread(row, target);
      const sent = await this.#solo.send(threadId, {
        text: row.prompt,
        author: { name: `Automation: ${row.name}`, source: "schedule" },
        whenBusy: "followUp",
        requestId,
      });
      this.#solo.db.run("UPDATE automations SET last_run_at = ?, last_status = 'running', last_error = NULL WHERE id = ?", now, row.id);
      this.#solo.activity({ type: "schedule", text: `Automation "${row.name}" ran`, agentId: row.agent_id, threadId });
      this.#emit(row.id);
      void sent
        .wait()
        .then((result) => this.#settle(row.id, now, result.status === "done" ? "ok" : "failed", result.status === "done" ? null : (result.reason ?? "unanswered")))
        .catch((error) => this.#settle(row.id, now, "failed", error instanceof Error ? error.message : String(error)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#solo.db.run("UPDATE automations SET last_run_at = ?, last_status = 'failed', last_error = ? WHERE id = ?", now, message, row.id);
      this.#solo.activity({ type: "error", text: `Automation "${row.name}" failed: ${message}`, agentId: row.agent_id });
      this.#emit(row.id);
    }
  }

  #settle(id: string, runAt: number, status: AutomationStatus, error: string | null) {
    // A later run owns the status once it starts.
    const changed = this.#solo.db.run("UPDATE automations SET last_status = ?, last_error = ? WHERE id = ? AND last_run_at = ?", status, error, id, runAt).changes;
    if (changed) this.#emit(id);
  }

  async #ensureThread(row: AutomationRow, target: AutomationTarget): Promise<string> {
    if (target.kind === "thread") {
      if (!this.#solo.thread(target.threadId)) {
        // Nothing to post into anymore: stop the schedule instead of failing every time.
        // The task sees the row is disabled at its next plan and ends.
        this.#solo.db.run("UPDATE automations SET enabled = 0, task_id = NULL, next_run_at = NULL WHERE id = ?", row.id);
        throw new Error("The target thread was deleted; the automation is now disabled");
      }
      return target.threadId;
    }
    if (row.thread_id && this.#solo.thread(row.thread_id)) return row.thread_id;
    const connector = this.#solo.connectors.get(target.connectorId);
    if (!connector) throw new Error("The target connector was deleted");
    const thread = await this.#solo.createThread({
      agentId: row.agent_id,
      title: row.name,
      source: connector.kind,
      connectorId: connector.id,
      externalKey: `automation:${row.id}`,
      location: target.location,
      target: target.target,
    });
    this.#solo.db.run("UPDATE automations SET thread_id = ? WHERE id = ?", thread.id, row.id);
    return thread.id;
  }

  /** Replace the automation's task: abort the old one, start a new one when enabled. */
  async #reschedule(id: string) {
    const row = this.#row(id);
    if (!row) return;
    if (row.task_id) await this.#abort(row.task_id);
    let taskId: string | null = null;
    if (row.enabled) {
      // Show the next run right away; the task computes the same time when it plans.
      this.#solo.db.run("UPDATE automations SET next_run_at = ? WHERE id = ?", this.#next(row, Date.now()) ?? null, id);
      const scheduler = await this.#schedulerConversation();
      await scheduler.commit(async (tx) => {
        const created = await tx.createTask(this.#task, { automationId: id }, { ownership: { kind: "conversation" }, background: true });
        // Claim the row inside the commit, so the task's first plan already sees itself as the owner.
        taskId = String(created);
        this.#solo.db.run("UPDATE automations SET task_id = ? WHERE id = ?", taskId, id);
      }, ctx);
    } else {
      this.#solo.db.run("UPDATE automations SET task_id = NULL, next_run_at = NULL WHERE id = ?", id);
    }
    this.#emit(id);
  }

  async #abort(taskId: string) {
    await this.#solo.harness.abortTask(Number(taskId) as never, ctx).catch(() => {});
  }

  /** One ownerless conversation hosts every automation task, apart from any thread a person might delete. */
  #schedulerConversation(): Promise<Conversation> {
    this.#scheduler ??= (async () => {
      const stored = this.#solo.db.setting("automation_conversation");
      if (stored) {
        const existing = await this.#solo.harness.conversation(Number(stored) as unknown as ConversationId, ctx);
        if (existing) return existing;
      }
      const created = await this.#solo.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      this.#solo.db.setSetting("automation_conversation", String(created.id));
      return created;
    })().catch((error) => {
      this.#scheduler = undefined;
      throw error;
    });
    return this.#scheduler;
  }

  #validate(input: AutomationInput): { name: string; prompt: string; agentId: string; cron: string; timezone: string; target: AutomationTarget } {
    const name = input.name?.trim();
    if (!name) throw new Error("name is required");
    if (name.length > 120) throw new Error("name is too long (120 characters at most)");
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("prompt is required");
    let cron: string;
    if (input.preset) cron = presetToCron(input.preset);
    else if (input.cron?.trim()) cron = parseSchedule(input.cron);
    else throw new Error("A schedule is required: cron or preset");
    const timezone = this.#timezone(input.timezone);
    if (nextRun(cron, timezone, Date.now()) === undefined) throw new Error(`"${cron}" never fires`);

    const t = input.target;
    if (!t || (t.kind !== "thread" && t.kind !== "channel")) throw new Error("target is required: { kind: 'thread', threadId } or { kind: 'channel', connectorId, channel }");
    let target: AutomationTarget;
    let agentId: string | undefined;
    if (t.kind === "thread") {
      const thread = this.#solo.thread(t.threadId);
      if (!thread) throw new Error("Target thread not found");
      target = { kind: "thread", threadId: thread.id };
      agentId = thread.agentId;
    } else {
      const connector = this.#solo.connectors.get(t.connectorId);
      if (!connector) throw new Error("Target connector not found");
      const replyTarget = t.target && Object.keys(t.target).length ? t.target : t.channel?.trim() ? channelTarget(connector.kind, t.channel) : undefined;
      if (!replyTarget) throw new Error("A channel target needs a channel id");
      target = { kind: "channel", connectorId: connector.id, target: replyTarget, location: t.location?.trim() || t.channel?.trim() || null };
      agentId = input.agentId ?? connector.agentId ?? undefined;
    }
    const agent = agentId ? this.#solo.agents.get(agentId) : this.#solo.agents.default();
    if (!agent) throw new Error(agentId ? "Agent not found" : "No agent available — create one first");
    return { name, prompt, agentId: agent.id, cron, timezone, target };
  }

  #next(row: AutomationRow, after: number): number | undefined {
    try {
      return this.#nextOverride ? this.#nextOverride(this.#toAutomation(row), after) : nextRun(row.cron, row.timezone, after);
    } catch {
      return undefined;
    }
  }

  #timezone(timezone: string | undefined): string {
    const tz = timezone?.trim() || localTimeZone();
    if (!isTimeZone(tz)) throw new Error(`Unknown time zone "${tz}". Use an IANA name like America/Chicago.`);
    return tz;
  }

  #row(id: string): AutomationRow | undefined {
    return this.#solo.db.get<AutomationRow>("SELECT * FROM automations WHERE id = ?", id);
  }

  #emit(id: string) {
    const automation = this.get(id);
    if (automation) this.#solo.emit({ type: "automation.updated", automation });
  }

  #toAutomation(row: AutomationRow): Automation {
    return {
      id: row.id,
      name: row.name,
      agentId: row.agent_id,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      cron: row.cron,
      timezone: row.timezone,
      scheduleText: describeCron(row.cron),
      target: JSON.parse(row.target) as AutomationTarget,
      threadId: row.thread_id,
      lastRunAt: row.last_run_at,
      nextRunAt: row.enabled ? row.next_run_at : null,
      lastStatus: row.last_status,
      lastError: row.last_error,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
