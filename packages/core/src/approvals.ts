import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { AgentSkill, Approval, ApprovalPolicy, ApprovalSettings, ApprovalStatus } from "@soloagent/client";
import { type Db, newId } from "./db.ts";

/**
 * Human-in-the-loop tool calls.
 *
 * The gate is a `beforeTool` hook. Pi Durable runs `beforeTool` in the tool task's first phase, before it commits the
 * call's intent, and a phase reruns from its top after a restart. So a call that waits here has not run, a restart
 * reruns the hook (which finds its request again by the tool task's id), and once approved the intent is committed
 * and the tool runs exactly as it would have without approvals: once, under its own replay policy. Agents with
 * approvals off do not select the extension at all.
 */

/** Tools the "risky" policy always asks about. `web_fetch` is GET-only, so it is not on the list. */
export const RISKY_TOOLS: readonly string[] = ["bash", "write", "edit"];
/** Tools even the "all" policy never asks about. */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "recall", "web_search"];
export const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SETTINGS_KEY = "approval_settings";
/** setTimeout's limit; longer waits re-arm. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function defaultApprovalPolicy(skills: readonly AgentSkill[]): ApprovalPolicy {
  return skills.includes("workspace") ? "risky" : "off";
}

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return value === "off" || value === "risky" || value === "all";
}

/** Whether a call to `tool` waits for a human under `policy`. */
export function needsApproval(policy: ApprovalPolicy, tool: string, riskyTools: readonly string[] = []): boolean {
  if (policy === "off") return false;
  if (policy === "all") return !READ_ONLY_TOOLS.includes(tool);
  return RISKY_TOOLS.includes(tool) || riskyTools.includes(tool);
}

/** Whether a chat user may decide: matched by platform user id or display name (case-insensitive, `@` optional). */
export function canApproveInChat(approvers: readonly string[], user: { id?: string; name: string }): boolean {
  const norm = (value: string) => value.trim().replace(/^@/, "").toLowerCase();
  const wanted = new Set(approvers.map(norm).filter(Boolean));
  if (wanted.size === 0) return false;
  return (user.id !== undefined && wanted.has(norm(user.id))) || wanted.has(norm(user.name));
}

/** Button payloads: `sa:a:<id>` approves, `sa:d:<id>` denies. Short enough for Telegram's 64-byte callback data. */
export function approvalAction(id: string, approve: boolean): string {
  return `sa:${approve ? "a" : "d"}:${id}`;
}

export function parseApprovalAction(data: string): { id: string; approve: boolean } | undefined {
  const match = /^sa:([ad]):([A-Za-z0-9_]+)$/.exec(data);
  return match ? { id: match[2]!, approve: match[1] === "a" } : undefined;
}

/** What the model and the transcript see for a call that did not run. */
export function denialText(approval: Approval): string {
  if (approval.status === "expired") return `Denied: nobody approved this call within ${duration(approval.expiresAt - approval.createdAt)}.`;
  if (approval.status === "cancelled") return "Cancelled before anyone approved it.";
  return `Denied by ${approval.decidedBy ?? "someone"}${approval.reason ? `: ${approval.reason}` : "."}`;
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)} days`;
}

/** A short, human preview of a call's arguments for chat messages and the TUI. */
export function argsPreview(tool: string, args: unknown, max = 900): string {
  const a = (args ?? {}) as Record<string, unknown>;
  let text: string;
  if (tool === "bash" && typeof a.command === "string") text = a.command;
  else if (tool === "write" && typeof a.path === "string") text = `${a.path}\n${typeof a.content === "string" ? a.content : ""}`;
  else if (tool === "edit" && typeof a.path === "string") {
    const edits = Array.isArray(a.edits) ? (a.edits as { oldText?: string; newText?: string }[]) : [];
    text = [a.path, ...edits.map((e) => `- ${e.oldText ?? ""}\n+ ${e.newText ?? ""}`)].join("\n");
  } else text = JSON.stringify(args, null, 2) ?? "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The chat message that asks for a decision (markdown; drivers convert it). */
export function approvalPrompt(approval: Approval, agentLabel: string): string {
  const fence = "```";
  return [
    `🔐 **${agentLabel} wants to run \`${approval.tool}\`**`,
    `${fence}\n${argsPreview(approval.tool, approval.args).replace(/```/g, "ˋˋˋ")}\n${fence}`,
    `Approve or deny below. Auto-denied in ${duration(approval.expiresAt - approval.createdAt)}.`,
  ].join("\n");
}

/** The same message once decided. */
export function approvalOutcome(approval: Approval, agentLabel: string): string {
  const head =
    approval.status === "approved"
      ? `✅ **Approved** by ${approval.decidedBy ?? "someone"}`
      : approval.status === "denied"
        ? `🚫 **Denied** by ${approval.decidedBy ?? "someone"}${approval.reason ? `: ${approval.reason}` : ""}`
        : approval.status === "expired"
          ? "⌛ **Expired**: nobody answered in time, so it was denied"
          : "⏹ **Cancelled**";
  return `${head} · ${agentLabel} \`${approval.tool}\`\n${"```"}\n${argsPreview(approval.tool, approval.args, 300).replace(/```/g, "ˋˋˋ")}\n${"```"}`;
}

type Row = {
  id: string;
  task_id: string;
  call_id: string;
  conversation_id: number;
  thread_id: string | null;
  agent_id: string | null;
  tool: string;
  args: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_via: string | null;
  reason: string | null;
  chat: string | null;
  created_at: number;
  decided_at: number | null;
  expires_at: number;
};

/** Where an approval's chat message lives, to edit it once decided. */
export type ApprovalChat = { connectorId: string; target: Record<string, string>; handle: Record<string, string> };

export type Decision = { status: "approved" | "denied" | "expired" | "cancelled"; by: string; via: string; reason?: string };

/**
 * Approval records (table `approvals`) and the in-memory waiters of the hooks that wait on them. Every change is
 * reported to `onChange`, which the runtime turns into events, chat updates, and live state.
 */
export class ApprovalStore {
  #db: Db;
  #onChange: (approval: Approval, created: boolean) => void;
  #waiters = new Map<string, Set<(approval: Approval) => void>>();

  constructor(db: Db, onChange: (approval: Approval, created: boolean) => void) {
    this.#db = db;
    this.#onChange = onChange;
  }

  settings(): ApprovalSettings {
    const stored = this.#db.setting(SETTINGS_KEY);
    const parsed = stored ? (JSON.parse(stored) as Partial<ApprovalSettings>) : {};
    return {
      timeoutMs: typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0 ? parsed.timeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS,
      riskyTools: Array.isArray(parsed.riskyTools) ? parsed.riskyTools.filter((t) => typeof t === "string") : [],
    };
  }

  setSettings(input: Partial<ApprovalSettings>): ApprovalSettings {
    const current = this.settings();
    const next: ApprovalSettings = {
      timeoutMs: input.timeoutMs !== undefined ? Math.max(1_000, Math.min(30 * 24 * 3_600_000, Math.round(Number(input.timeoutMs) || 0))) : current.timeoutMs,
      riskyTools: input.riskyTools !== undefined ? [...new Set(input.riskyTools.map((t) => String(t).trim()).filter(Boolean))] : current.riskyTools,
    };
    this.#db.setSetting(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  get(id: string): Approval | undefined {
    const row = this.#db.get<Row>("SELECT * FROM approvals WHERE id = ?", id);
    return row ? fromRow(row) : undefined;
  }

  forTask(taskId: string): Approval | undefined {
    const row = this.#db.get<Row>("SELECT * FROM approvals WHERE task_id = ?", taskId);
    return row ? fromRow(row) : undefined;
  }

  list(query: { status?: ApprovalStatus | "decided"; threadId?: string; limit?: number } = {}): Approval[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.status === "decided") clauses.push("status != 'pending'");
    else if (query.status) (clauses.push("status = ?"), params.push(query.status));
    if (query.threadId) (clauses.push("thread_id = ?"), params.push(query.threadId));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const order = query.status === "pending" ? "created_at ASC" : "COALESCE(decided_at, created_at) DESC";
    return this.#db
      .all<Row>(`SELECT * FROM approvals ${where} ORDER BY ${order} LIMIT ?`, ...params, Math.min(query.limit ?? 100, 500))
      .map(fromRow);
  }

  pendingCount(): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")?.n ?? 0;
  }

  /** Thread ids with a pending approval. */
  pendingThreads(): Set<string> {
    return new Set(this.#db.all<{ thread_id: string }>("SELECT DISTINCT thread_id FROM approvals WHERE status = 'pending' AND thread_id IS NOT NULL").map((r) => r.thread_id));
  }

  /** The request of one tool task: created on first ask, found again on every rerun. */
  open(input: { taskId: string; callId: string; conversationId: number; threadId: string | null; agentId: string | null; tool: string; args: unknown; timeoutMs: number }): {
    approval: Approval;
    created: boolean;
  } {
    const now = Date.now();
    const result = this.#db.run(
      `INSERT OR IGNORE INTO approvals (id, task_id, call_id, conversation_id, thread_id, agent_id, tool, args, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      newId("apr"),
      input.taskId,
      input.callId,
      input.conversationId,
      input.threadId,
      input.agentId,
      input.tool,
      JSON.stringify(input.args ?? {}),
      now,
      now + input.timeoutMs,
    );
    const approval = this.forTask(input.taskId)!;
    const created = result.changes > 0;
    if (created) this.#onChange(approval, true);
    return { approval, created };
  }

  /** Decide a pending request. Returns undefined when it is unknown or already decided. */
  decide(id: string, decision: Decision): Approval | undefined {
    const result = this.#db.run(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_via = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      decision.status,
      decision.by,
      decision.via,
      decision.reason?.trim() || null,
      Date.now(),
      id,
    );
    if (result.changes === 0) return undefined;
    const approval = this.get(id)!;
    for (const wake of this.#waiters.get(id) ?? []) wake(approval);
    this.#waiters.delete(id);
    this.#onChange(approval, false);
    return approval;
  }

  chat(id: string): ApprovalChat | undefined {
    const row = this.#db.get<{ chat: string | null }>("SELECT chat FROM approvals WHERE id = ?", id);
    return row?.chat ? (JSON.parse(row.chat) as ApprovalChat) : undefined;
  }

  setChat(id: string, chat: ApprovalChat) {
    this.#db.run("UPDATE approvals SET chat = ? WHERE id = ?", JSON.stringify(chat), id);
  }

  /**
   * Resolve once the request is decided, without polling: `decide()` wakes the waiter, and a timer expires it at
   * `expiresAt`. Aborting `signal` (a stop, or the Harness closing) rejects and leaves the request as it is.
   */
  wait(id: string, signal: AbortSignal | undefined): Promise<Approval> {
    return new Promise((resolve, reject) => {
      const current = this.get(id);
      if (!current) return reject(new Error(`Approval ${id} is gone`));
      if (current.status !== "pending") return resolve(current);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiters.get(id)?.delete(wake);
      };
      const wake = (approval: Approval) => {
        cleanup();
        resolve(approval);
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("aborted"));
      };
      const arm = () => {
        const left = current.expiresAt - Date.now();
        if (left > 0) {
          timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
          timer.unref?.();
          return;
        }
        const expired = this.decide(id, { status: "expired", by: "timeout", via: "timeout" });
        if (!expired) wake(this.get(id) ?? current);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let set = this.#waiters.get(id);
      if (!set) this.#waiters.set(id, (set = new Set()));
      set.add(wake);
      arm();
    });
  }
}

function fromRow(row: Row): Approval {
  return {
    id: row.id,
    tool: row.tool,
    args: JSON.parse(row.args) as unknown,
    callId: row.call_id,
    taskId: row.task_id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    status: row.status,
    decidedBy: row.decided_by ?? undefined,
    decidedVia: row.decided_via ?? undefined,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
    expiresAt: row.expires_at,
  };
}

/** What the gate needs from the runtime. */
export interface ApprovalHost {
  readonly store: ApprovalStore;
  /** The thread (and agent) a conversation belongs to, following delegate children up to their thread. */
  locate(conversationId: number, context: Context): Promise<{ threadId: string | null; agentId: string | null }>;
  /** A request is waiting (also again after a restart): make sure UIs and chat show it. */
  waiting(approval: Approval): void;
}

/** Codes of results the Harness writes when a call ends without running (or without finishing). */
const ENDED_CODES = new Set(["aborted", "abandoned", "interrupted", "restart_limit"]);

/** One extension per policy, so the policy travels with the conversation's agent selection (delegates too). */
export function createApprovalExtensions(host: ApprovalHost): Record<Exclude<ApprovalPolicy, "off">, Extension> {
  const make = (policy: Exclude<ApprovalPolicy, "off">) =>
    defineExtension({
      name: `solo.approvals.${policy}`,
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, api, context) => {
            const settings = host.store.settings();
            if (!needsApproval(policy, call.name, settings.riskyTools)) return undefined;
            const taskId = String(api.taskId);
            let approval = host.store.forTask(taskId);
            if (!approval) {
              const where = await host.locate(Number(api.conversationId), context);
              approval = host.store.open({
                taskId,
                callId: call.id,
                conversationId: Number(api.conversationId),
                threadId: where.threadId,
                agentId: where.agentId,
                tool: call.name,
                args: call.arguments,
                timeoutMs: settings.timeoutMs,
              }).approval;
            }
            if (approval.status === "pending") {
              host.waiting(approval);
              approval = await host.store.wait(approval.id, context.abortSignal);
            }
            return approval.status === "approved" ? undefined : { block: denialText(approval) };
          },
          afterTool: (_call, result, api) => {
            const approval = host.store.forTask(String(api.taskId));
            if (!approval) return undefined;
            const codes = new Set((result.diagnostics ?? []).map((d) => d.code));
            // A stop, or the call ending some other way while it waited: the request is moot.
            if (approval.status === "pending" && [...codes].some((c) => c !== undefined && ENDED_CODES.has(c))) {
              host.store.decide(approval.id, { status: "cancelled", by: "system", via: "system" });
              return undefined;
            }
            // Say plainly why the call did not run, instead of "Tool call blocked: …".
            if (codes.has("blocked") && approval.status !== "approved" && approval.status !== "pending") {
              return { ...result, output: [{ type: "text", text: denialText(approval) }], diagnostics: [], isError: true };
            }
            return undefined;
          },
        }),
      ],
    });
  return { risky: make("risky"), all: make("all") };
}
