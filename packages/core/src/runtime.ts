import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Provider } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryId,
  createRegistry,
  Harness,
  LiveDoc,
  UsageDoc,
  type WatchHandle,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
  ActivityItem,
  Agent,
  AgentInput,
  Author,
  Connector,
  LiveState,
  Message,
  Overview,
  Schedule,
  ServerEvent,
  Source,
  TaskNode,
  Thread,
  ThreadSnapshot,
  Usage,
  UsageSummary,
} from "@soloagent/client";
import { AgentStore } from "./agents.ts";
import { createBackup, secretFingerprint, type SecretInfo } from "./backup.ts";
import { ConnectorManager } from "./connectors/manager.ts";
import { chunk } from "./connectors/format.ts";
import type { InboundMessage, PostHandle, ReplyTarget } from "./connectors/types.ts";
import { SealedCredentialStore } from "./credentials.ts";
import { Db, newId } from "./db.ts";
import { ProviderHub } from "./providers.ts";
import { Sealer } from "./secrets.ts";
import { demoProvider } from "./demo.ts";
import { createSkills, type SkillHost } from "./skills.ts";
import { EVENT_ENTRY, MESSAGE_ENTRY, type EventEntryData, type MessageEntryData, textOf, toLive, toMessages, usageOf } from "./transcript.ts";

export const VERSION = "0.1.1";

export type SoloAgentOptions = {
  /** Directory for databases and agent workspaces. */
  dataDir: string;
  /** Seals credentials at rest. Default: SOLOAGENT_SECRET, else a generated secret stored in the data dir. */
  secret?: string;
  /** Admin token for the API. Default: SOLOAGENT_TOKEN, else generated once and stored. */
  adminToken?: string;
  /** Start chat connectors on open. Default true. */
  connectors?: boolean;
  /** Extra pi-ai providers, e.g. a self-hosted gateway or the faux provider in tests. */
  providers?: Provider[];
  /** Register the built-in demo model so a fresh install works without any account. Default: SOLOAGENT_DEMO !== "0". */
  demo?: boolean;
  log?: (message: string) => void;
};

type ThreadRow = {
  id: string;
  conversation_id: number;
  agent_id: string;
  source: Source;
  connector_id: string | null;
  external_key: string | null;
  location: string | null;
  title: string;
  preview: string;
  message_count: number;
  agent_version: number;
  meta: string | null;
  created_at: number;
  updated_at: number;
};

type ThreadMeta = { target?: ReplyTarget };

/** A connector reply that is being streamed into a placeholder message. */
type Outbound = { handle?: PostHandle; target: ReplyTarget; lastText: string; lastEdit: number; timer?: ReturnType<typeof setTimeout>; typing?: ReturnType<typeof setInterval> };

const ctx: Context = BACKGROUND_CONTEXT;
/** soloagent stores Pi's branded ids as plain numbers. */
const cid = (id: number) => id as unknown as ConversationId;
const eid = (id: number) => id as unknown as EntryId;
const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/**
 * soloagent's runtime: one Pi Durable Harness, the agents that run on it, the threads that map chat
 * conversations to durable Pi conversations, and the connectors that bring Slack, Discord, and
 * Telegram in. Everything that changes is announced on `events` as `ServerEvent`s.
 */
export class SoloAgent {
  readonly events = new EventEmitter<{ event: [ServerEvent] }>();
  readonly db: Db;
  readonly harness: Harness;
  readonly agents: AgentStore;
  readonly providers: ProviderHub;
  readonly connectors: ConnectorManager;
  readonly adminToken: string;
  readonly dataDir: string;
  readonly startedAt = Date.now();
  #skills: ReturnType<typeof createSkills>;
  #watchers = new Map<string, ThreadWatcher>();
  #busy = new Set<string>();
  #outbound = new Map<string, Outbound>();
  #log: (message: string) => void;
  #taskWatch: WatchHandle<import("@earendil-works/pi-durable").TaskGraph> | undefined;
  #taskSubscribers = 0;
  #tasks: TaskNode[] = [];
  #secret: SecretInfo & { value: string } = { source: "file", fingerprint: "", value: "" };

  private constructor(init: {
    db: Db;
    harness: Harness;
    agents: AgentStore;
    providers: ProviderHub;
    connectors: ConnectorManager;
    skills: ReturnType<typeof createSkills>;
    adminToken: string;
    dataDir: string;
    log: (message: string) => void;
  }) {
    this.db = init.db;
    this.harness = init.harness;
    this.agents = init.agents;
    this.providers = init.providers;
    this.connectors = init.connectors;
    this.#skills = init.skills;
    this.adminToken = init.adminToken;
    this.dataDir = init.dataDir;
    this.#log = init.log;
  }

  static async open(options: SoloAgentOptions): Promise<SoloAgent> {
    const dataDir = resolve(options.dataDir);
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    const log = options.log ?? ((message: string) => console.log(`[solo] ${message}`));
    const secret = options.secret ?? process.env.SOLOAGENT_SECRET ?? persistentSecret(join(dataDir, ".secret"));
    const db = new Db(join(dataDir, "soloagent.sqlite"));
    const sealer = new Sealer(secret);

    const adminToken = options.adminToken ?? process.env.SOLOAGENT_TOKEN ?? db.setting("admin_token") ?? `solo_${randomBytes(18).toString("base64url")}`;
    if (!options.adminToken && !process.env.SOLOAGENT_TOKEN) db.setSetting("admin_token", adminToken);

    // Late-bound: the skills, hub, and stores call back into the runtime once it exists.
    let solo: SoloAgent | undefined;
    const emit = (event: ServerEvent) => solo?.emit(event);

    let deviceId = db.setting("device_id");
    if (!deviceId) {
      deviceId = randomUUID();
      db.setSetting("device_id", deviceId);
    }
    const credentials = new SealedCredentialStore(db, sealer, () => {
      emit({ type: "providers.changed" });
      void solo?.autoAssignModels();
    });
    const providers = new ProviderHub(credentials, (flow) => {
      emit({ type: "login.updated", flow });
      if (flow.status === "done") solo?.activity({ type: "provider", text: `Signed in to ${providers.models.getProvider(flow.providerId)?.name ?? flow.providerId}` });
        }, deviceId);
    const demo = options.demo ?? process.env.SOLOAGENT_DEMO !== "0";
    if (demo) providers.models.setProvider(demoProvider());
    for (const provider of options.providers ?? []) providers.models.setProvider(provider);
    const agents = new AgentStore(db, (agent, deleted) => emit(deleted ? { type: "agent.deleted", agentId: agent.id } : { type: "agent.updated", agent }));
    const connectors = new ConnectorManager(db, sealer, {
      changed: (connector, deleted) => emit(deleted ? { type: "connector.deleted", connectorId: connector.id } : { type: "connector.updated", connector }),
      inbound: (connector, message) => void solo?.handleInbound(connector, message).catch((error) => log(`inbound ${connector.name}: ${String(error)}`)),
      log: (connectorId, message, error) => {
        log(message);
        solo?.activity({ type: error ? "error" : "connector", text: message, connectorId });
      },
    });

    const host: SkillHost = {
      agentForConversation: (id) => solo?.agentForConversation(id),
      threadContext: (id) => {
        const row = db.get<ThreadRow>("SELECT * FROM threads WHERE conversation_id = ?", id);
        return row ? { source: row.source, location: row.location, title: row.title } : undefined;
      },
      agents: () => agents.list(),
      agentByHandle: (handle) => agents.get(handle),
      agentChange: (agent, opts) => solo!.agentChange(agent, opts),
      memories: (agentId, limit) =>
        db.all<{ id: number; text: string; created_at: number }>("SELECT * FROM memories WHERE agent_id = ? ORDER BY id DESC LIMIT ?", agentId, limit).map((m) => ({ id: m.id, text: m.text, createdAt: m.created_at })),
      searchMemories: (agentId, query, limit) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
        const where = words.map(() => "LOWER(text) LIKE ?").join(" OR ") || "1";
        return db
          .all<{ id: number; text: string; created_at: number }>(`SELECT * FROM memories WHERE agent_id = ? AND (${where}) ORDER BY id DESC LIMIT ?`, agentId, ...words.map((w) => `%${w}%`), limit)
          .map((m) => ({ id: m.id, text: m.text, createdAt: m.created_at }));
      },
      remember: (agentId, text) => Number(db.run("INSERT INTO memories (agent_id, text, created_at) VALUES (?, ?, ?)", agentId, text, Date.now()).lastInsertRowid),
      forget: (agentId, id) => db.run("DELETE FROM memories WHERE agent_id = ? AND id = ?", agentId, id).changes > 0,
      answerText: async (conversationId, entryId, context) => {
        const conversation = await solo!.harness.conversation(cid(conversationId), context);
        const page = await conversation?.entries({ minEntryId: eid(entryId), maxEntryId: eid(entryId) }, 1, undefined, context);
        return textOf((page?.items[0]?.model?.[0] as { content?: string } | undefined)?.content as never);
      },
      scheduleCreated: ({ taskId, conversationId, text, at }) => {
        const thread = db.get<ThreadRow>("SELECT * FROM threads WHERE conversation_id = ?", conversationId);
        if (!thread) return;
        db.run("INSERT OR REPLACE INTO schedules (task_id, thread_id, agent_id, text, at, status) VALUES (?, ?, ?, ?, ?, 'sleeping')", taskId, thread.id, thread.agent_id, text, at);
        solo?.activity({ type: "schedule", text: `Reminder set for ${new Date(at).toUTCString()}: ${text}`, agentId: thread.agent_id, threadId: thread.id });
      },
      scheduleFired: (taskId) => {
        db.run("UPDATE schedules SET status = 'done' WHERE task_id = ?", taskId);
        const row = db.get<{ thread_id: string; agent_id: string; text: string }>("SELECT * FROM schedules WHERE task_id = ?", taskId);
        if (row) {
          solo?.activity({ type: "schedule", text: `Reminder fired: ${row.text}`, agentId: row.agent_id, threadId: row.thread_id });
          solo?.markBusy(row.thread_id);
        }
      },
      runAnswered: (conversationId, answer, context) => void solo?.runAnswered(conversationId, answer, context).catch((error) => log(`deliver: ${String(error)}`)),
    };

    const skills = createSkills(host);
    const registry = createRegistry();
    for (const extension of skills.all) registry.install(extension);

    const storage = await openNodeSqliteStorage(join(dataDir, "durable.sqlite"));
    const harness = await Harness.open(
      storage,
      {
        models: providers.models,
        registry,
        identity: { attribution: { name: "soloagent", url: "https://soloagent.dev", categories: ["cloud-agent"] } },
        env: ({ cwd }) => (cwd ? new NodeExecutionEnv({ cwd }) : undefined),
        settings: {
          extensions: [skills.Base],
          retry: { maxRetries: 3 },
          afterFailedRun: "continue",
          toolExecution: "parallel",
        },
        onReport: (report) => log(`pi: ${report.kind}${"reason" in report && report.reason ? ` (${String(report.reason)})` : ""}: ${String((report.error as Error | undefined)?.message ?? report.error ?? "")}`),
      },
      ctx,
    );

    solo = new SoloAgent({ db, harness, agents, providers, connectors, skills, adminToken, dataDir, log });
    solo.#secret = { source: options.secret || process.env.SOLOAGENT_SECRET ? "env" : "file", fingerprint: secretFingerprint(secret), value: secret };
    harness.resume();
    if (agents.list().length === 0) solo.seed();
    await solo.autoAssignModels();
    if (options.connectors !== false) void connectors.startAll();
    return solo;
  }

  emit(event: ServerEvent) {
    this.events.emit("event", event);
  }

  async close() {
    await this.connectors.stopAll();
    for (const watcher of this.#watchers.values()) await watcher.stop();
    await this.#taskWatch?.stop();
    await this.harness.close(ctx);
    this.db.close();
  }

  /** Which secret seals credentials: SOLOAGENT_SECRET (or one passed in code) or the generated `.secret` file. */
  get secretInfo(): SecretInfo {
    return { source: this.#secret.source, fingerprint: this.#secret.fingerprint };
  }

  /** A consistent `.tar.gz` of the whole data dir, safe to take while running. See backup.ts. */
  backup(options: { includeSecret?: boolean } = {}) {
    return createBackup(this.dataDir, { version: VERSION, secret: this.#secret, includeSecret: options.includeSecret, log: this.#log });
  }

  // ───────────────────────────── agents ─────────────────────────────

  seed() {
    this.agents.create({
      name: "Solo",
      handle: "solo",
      avatar: "●",
      color: "#9cbf10",
      description: "Your everyday generalist. Answers anything not addressed to a specific agent.",
      isDefault: true,
      skills: ["memory", "web", "delegate", "schedule"],
    });
  }

  createAgent(input: AgentInput): Agent {
    const agent = this.agents.create(input);
    this.activity({ type: "agent", text: `Created agent @${agent.handle}`, agentId: agent.id });
    return agent;
  }

  /** Give agents without a model a sensible one from the first configured provider. */
  /**
   * Give agents without a model a sensible one from the first configured provider. Agents that were put
   * on the demo model automatically move to a real provider once one is connected; agents someone put on
   * a model on purpose (including the demo model) are never changed.
   */
  async autoAssignModels() {
    const configured = await this.providers.configured();
    const provider = configured.find((p) => p.id !== "demo") ?? configured.find((p) => p.id === "demo");
    if (!provider) return;
    const auto = this.#autoModelAgents();
    const candidates = this.agents
      .list()
      .filter((a) => !a.model || (auto.has(a.id) && a.model.provider === "demo" && provider.id !== "demo"));
    if (candidates.length === 0) return;
    const model = pickModel(provider.id, provider.models.map((m) => m.id));
    if (!model) return;
    for (const agent of candidates) {
      this.agents.update(agent.id, { model: { provider: provider.id, modelId: model } });
      if (provider.id === "demo") auto.add(agent.id);
      else auto.delete(agent.id);
      this.activity({ type: "agent", text: `@${agent.handle} now runs on ${provider.name} ${model}`, agentId: agent.id });
    }
    this.db.setSetting("auto_model_agents", JSON.stringify([...auto]));
  }

  /** Update an agent on someone's behalf. Choosing a model by hand opts the agent out of auto-assignment. */
  updateAgent(id: string, input: Partial<AgentInput>): Agent {
    const agent = this.agents.update(id, input);
    if (input.model !== undefined) {
      const auto = this.#autoModelAgents();
      if (auto.delete(agent.id)) this.db.setSetting("auto_model_agents", JSON.stringify([...auto]));
    }
    return agent;
  }

  #autoModelAgents(): Set<string> {
    const stored = this.db.setting("auto_model_agents");
    if (stored) return new Set(JSON.parse(stored) as string[]);
    // Installs from before this setting existed: agents on the demo model got there automatically.
    return new Set(this.agents.list().filter((a) => a.model?.provider === "demo").map((a) => a.id));
  }

  agentChange(agent: Agent, options: { nested?: boolean } = {}): AgentChange {
    const skills = agent.skills.filter((s) => !(options.nested && s === "delegate"));
    const cwd = agent.skills.includes("workspace") ? join(this.dataDir, "workspaces", agent.handle) : null;
    if (cwd) mkdirSync(cwd, { recursive: true });
    return {
      model: agent.model,
      thinkingLevel: agent.thinkingLevel as AgentChange["thinkingLevel"],
      extensions: [this.#skills.Base, ...skills.map((s) => this.#skills.extensions[s])],
      tools: null,
      instructions: agent.instructions || null,
      maxTurns: agent.maxTurns,
      cwd,
    };
  }

  agentForConversation(conversationId: number): Agent | undefined {
    const row = this.db.get<{ agent_id: string }>("SELECT agent_id FROM conversation_agents WHERE conversation_id = ?", conversationId);
    return row ? this.agents.get(row.agent_id) : undefined;
  }

  // ───────────────────────────── threads ─────────────────────────────

  listThreads(query: { agentId?: string; source?: string; limit?: number } = {}): Thread[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.agentId) (clauses.push("agent_id = ?"), params.push(query.agentId));
    if (query.source) (clauses.push("source = ?"), params.push(query.source));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .all<ThreadRow>(`SELECT * FROM threads ${where} ORDER BY updated_at DESC LIMIT ?`, ...params, Math.min(query.limit ?? 200, 1000))
      .map((row) => this.#thread(row));
  }

  thread(id: string): Thread | undefined {
    const row = this.#row(id);
    return row ? this.#thread(row) : undefined;
  }

  async createThread(input: {
    agentId?: string;
    title?: string;
    source: Source;
    connectorId?: string | null;
    externalKey?: string | null;
    location?: string | null;
    target?: ReplyTarget;
  }): Promise<Thread> {
    const agent = input.agentId ? this.agents.get(input.agentId) : this.agents.default();
    if (!agent) throw new Error("No agent available — create one first");
    const conversation = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent: this.agentChange(agent) }, ctx);
    const id = newId("thr");
    const now = Date.now();
    this.db.run("INSERT OR REPLACE INTO conversation_agents (conversation_id, agent_id) VALUES (?, ?)", Number(conversation.id), agent.id);
    this.db.run(
      `INSERT INTO threads (id, conversation_id, agent_id, source, connector_id, external_key, location, title, agent_version, meta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      Number(conversation.id),
      agent.id,
      input.source,
      input.connectorId ?? null,
      input.externalKey ?? null,
      input.location ?? null,
      input.title?.trim() || "New conversation",
      this.agents.version(agent),
      JSON.stringify({ target: input.target } satisfies ThreadMeta),
      now,
      now,
    );
    const thread = this.thread(id)!;
    this.emit({ type: "thread.updated", thread });
    return thread;
  }

  updateThread(id: string, input: { title?: string; agentId?: string }): Thread {
    const row = this.#row(id);
    if (!row) throw new Error("Thread not found");
    if (input.title !== undefined) this.db.run("UPDATE threads SET title = ? WHERE id = ?", input.title.trim() || row.title, id);
    if (input.agentId !== undefined && input.agentId !== row.agent_id) {
      const agent = this.agents.get(input.agentId);
      if (!agent) throw new Error("Agent not found");
      // agent_version 0 forces a reconfigure before the next message.
      this.db.run("UPDATE threads SET agent_id = ?, agent_version = 0 WHERE id = ?", agent.id, id);
      this.db.run("INSERT OR REPLACE INTO conversation_agents (conversation_id, agent_id) VALUES (?, ?)", row.conversation_id, agent.id);
    }
    const thread = this.thread(id)!;
    this.emit({ type: "thread.updated", thread });
    return thread;
  }

  async deleteThread(id: string) {
    const row = this.#row(id);
    if (!row) return;
    const conversation = await this.harness.conversation(cid(row.conversation_id), ctx);
    await conversation?.abort(ctx, { background: true }).catch(() => {});
    await this.#watchers.get(id)?.stop();
    this.#watchers.delete(id);
    this.db.run("DELETE FROM threads WHERE id = ?", id);
    this.emit({ type: "thread.deleted", threadId: id });
  }

  async snapshot(id: string): Promise<ThreadSnapshot> {
    const row = this.#row(id);
    if (!row) throw new Error("Thread not found");
    const { messages, hasMore } = await this.messages(id, undefined, 60);
    const conversation = await this.#conversation(row);
    const view = await conversation.watch(ctx, { min: 1, max: 1 });
    const live = toLive(view.value.docs);
    await view.stop();
    return { thread: this.#thread(row), messages, hasMore, live };
  }

  /** Transcript page, oldest first, ending before `before` (an entry id). */
  async messages(id: string, before?: string, limit = 50): Promise<{ messages: Message[]; hasMore: boolean }> {
    const row = this.#row(id);
    if (!row) throw new Error("Thread not found");
    const conversation = await this.#conversation(row);
    const messages: Message[] = [];
    let cursor: Record<string, never> | undefined;
    let maxEntryId = before ? eid(Number(before) - 1) : undefined;
    let hasMore = false;
    // Page backwards until we have `limit` visible messages; bookkeeping entries render as nothing.
    for (let guard = 0; guard < 20 && messages.length < limit; guard++) {
      const page = await conversation.entries({ order: "descending", ...(maxEntryId !== undefined ? { maxEntryId } : {}) }, limit * 2, cursor, ctx);
      for (const entry of page.items) messages.unshift(...toMessages(entry, id, row.agent_id));
      if (!page.next) {
        hasMore = false;
        break;
      }
      hasMore = true;
      cursor = page.next as Record<string, never>;
      maxEntryId = undefined;
    }
    const trimmed = messages.length > limit ? messages.slice(messages.length - limit) : messages;
    return { messages: trimmed, hasMore: hasMore || messages.length > limit };
  }

  /**
   * Hand a message to a thread's agent. Busy threads steer the running work by default, so a quick
   * correction lands mid-run instead of waiting.
   */
  async send(
    threadId: string,
    input: { text: string; author: Author; whenBusy?: "steer" | "followUp"; requestId?: string },
  ): Promise<{ submissionId: string; wait: () => Promise<{ status: "done" | "unanswered"; answer?: string; reason?: string }> }> {
    const row = this.#row(threadId);
    if (!row) throw new Error("Thread not found");
    const agent = this.agents.get(row.agent_id);
    if (!agent) throw new Error("This thread's agent was deleted — switch it to another agent");
    if (!agent.model) throw new Error(`@${agent.handle} has no model yet. Connect a provider (Claude, ChatGPT, Copilot, …) in Providers.`);
    const conversation = await this.#conversation(row);
    if (row.agent_version !== this.agents.version(agent)) {
      await conversation.configure(this.agentChange(agent), ctx);
      this.db.run("UPDATE threads SET agent_version = ? WHERE id = ?", this.agents.version(agent), threadId);
    }
    const text = input.text.trim();
    const at = Date.now();
    const content = row.source === "web" || row.source === "tui" || row.source === "api" ? text : `[${input.author.name}]: ${text}`;
    const submission = await conversation.submit(
      {
        type: "input",
        content,
        whenBusy: input.whenBusy ?? "steer",
        requestId: input.requestId,
        entry: { kind: MESSAGE_ENTRY, data: { author: input.author, text, at } satisfies MessageEntryData },
      },
      ctx,
    );
    const title = row.message_count === 0 && row.title === "New conversation" ? text.replace(/\s+/g, " ").slice(0, 60) : row.title;
    this.db.run("UPDATE threads SET message_count = message_count + 1, preview = ?, title = ?, updated_at = ? WHERE id = ?", text.slice(0, 140), title, at, threadId);
    this.markBusy(threadId);
    this.activity({ type: "message", text: `${input.author.name} → @${agent.handle}: ${text.slice(0, 100)}`, agentId: agent.id, threadId });
    return {
      submissionId: String(submission.id),
      wait: async () => {
        const settled = await submission.wait(ctx);
        if (settled.status === "done") {
          const answer = await this.#answerText(row.conversation_id, Number(settled.answer));
          return { status: "done", answer };
        }
        return { status: "unanswered", reason: settled.reason ?? "unanswered" };
      },
    };
  }

  async stop(threadId: string) {
    const row = this.#row(threadId);
    if (!row) throw new Error("Thread not found");
    const conversation = await this.#conversation(row);
    await conversation.abort(ctx);
  }

  async reset(threadId: string) {
    const row = this.#row(threadId);
    if (!row) throw new Error("Thread not found");
    await (await this.#conversation(row)).reset(undefined, ctx);
  }

  async compact(threadId: string) {
    const row = this.#row(threadId);
    if (!row) throw new Error("Thread not found");
    await (await this.#conversation(row)).compact(undefined, ctx);
  }

  /** Subscribe to a thread's new messages and live state. Watchers are shared and stop with their last listener. */
  async watch(threadId: string, listener: (event: ServerEvent) => void): Promise<() => void> {
    const row = this.#row(threadId);
    if (!row) throw new Error("Thread not found");
    let watcher = this.#watchers.get(threadId);
    if (!watcher) {
      watcher = new ThreadWatcher(threadId, row.agent_id, await this.#conversation(row), (live) => this.#onLive(threadId, live));
      this.#watchers.set(threadId, watcher);
    }
    const w = watcher;
    await w.add(listener);
    return () => {
      if (w.remove(listener) === 0 && !this.#busy.has(threadId)) {
        this.#watchers.delete(threadId);
        void w.stop();
      }
    };
  }

  /** Keep a watcher on a busy thread so its state, and streaming connector replies, stay current. */
  markBusy(threadId: string) {
    if (!this.#busy.has(threadId)) {
      this.#busy.add(threadId);
      const thread = this.thread(threadId);
      if (thread) this.emit({ type: "thread.updated", thread });
    }
    if (!this.#watchers.has(threadId)) void this.watch(threadId, () => {}).catch(() => {});
  }

  #onLive(threadId: string, live: LiveState) {
    const wasBusy = this.#busy.has(threadId);
    if (live.busy && !wasBusy) this.#busy.add(threadId);
    if (!live.busy && wasBusy) {
      this.#busy.delete(threadId);
      const watcher = this.#watchers.get(threadId);
      if (watcher && watcher.size <= 1) {
        // Only the internal keep-alive listener remains.
        this.#watchers.delete(threadId);
        void watcher.stop();
      }
      if (live.failure) void this.#deliverFailure(threadId, live.failure);
    }
    if (live.busy !== wasBusy) {
      const thread = this.thread(threadId);
      if (thread) this.emit({ type: "thread.updated", thread });
    }
    this.#streamOutbound(threadId, live);
  }

  // ───────────────────────────── connectors ─────────────────────────────

  /** A message from Slack, Discord, Telegram, or a webhook. */
  async handleInbound(connector: Connector, message: InboundMessage, options: { wait?: boolean } = {}) {
    const driver = this.connectors.driver(connector.id);
    let text = message.text.trim();
    const reply = async (markdown: string) => {
      if (driver) await driver.post(message.target, markdown).catch((error) => this.#log(`post: ${String(error)}`));
    };

    // Chat commands
    const command = /^[!/](help|agents|reset|stop|new)\b/i.exec(text)?.[1]?.toLowerCase();
    if (command === "help") {
      await reply(helpText(this.agents.list()));
      return { status: "done" as const, answer: helpText(this.agents.list()) };
    }
    if (command === "agents") {
      const list = this.agents.list().map((a) => `${a.avatar} *@${a.handle}* — ${a.name}${a.description ? `: ${a.description}` : ""}${a.model ? "" : " _(no model yet)_"}`).join("\n");
      await reply(list || "No agents yet.");
      return { status: "done" as const, answer: list };
    }

    // Addressing: "@coder fix the build" or "coder: fix the build" picks an agent.
    let agent = connector.agentId ? this.agents.get(connector.agentId) : undefined;
    // A command may come first: "!reset @coder start over".
    const rest = text.replace(/^[!/](reset|stop|new)\s*/i, "");
    const addressed = /^@?([a-z0-9][a-z0-9-]{0,31})[:,]?\s+([\s\S]+)$/i.exec(rest);
    if (addressed) {
      const named = this.agents.get(addressed[1]!.toLowerCase());
      if (named && (rest.startsWith("@") || /^[a-z0-9-]+[:,]/i.test(rest))) {
        agent = named;
        text = addressed[2]!.trim();
      }
    }
    agent ??= this.agents.default();
    if (!agent) {
      await reply("No agents are set up yet. Open your soloagent dashboard to create one.");
      return { status: "unanswered" as const, reason: "no_agent" };
    }

    let row = this.db.get<ThreadRow>("SELECT * FROM threads WHERE connector_id = ? AND external_key = ? AND agent_id = ?", connector.id, message.externalKey, agent.id);
    if (!row) {
      const created = await this.createThread({
        agentId: agent.id,
        source: connector.kind,
        connectorId: connector.id,
        externalKey: message.externalKey,
        location: message.location,
        title: message.title,
        target: message.target,
      });
      row = this.#row(created.id)!;
    } else {
      // Remember the newest reply target (e.g. the message to reply to on Discord).
      this.db.run("UPDATE threads SET meta = ?, location = ? WHERE id = ?", JSON.stringify({ target: message.target } satisfies ThreadMeta), message.location, row.id);
    }

    if (command === "reset" || command === "new") {
      await this.reset(row.id);
      if (!text.replace(/^[!/](reset|new)\s*/i, "")) {
        await reply(`🧹 Fresh start with ${agent.avatar} @${agent.handle}.`);
        return { status: "done" as const, answer: "reset" };
      }
      text = text.replace(/^[!/](reset|new)\s*/i, "");
    }
    if (command === "stop") {
      await this.stop(row.id);
      await reply("⏹ Stopped.");
      return { status: "done" as const, answer: "stopped" };
    }
    if (!text) {
      await reply(`${agent.avatar} @${agent.handle} here — what can I do?`);
      return { status: "done" as const, answer: "" };
    }
    if (!agent.model) {
      await reply(`@${agent.handle} has no model yet — connect Claude, ChatGPT, or another provider in the soloagent dashboard.`);
      return { status: "unanswered" as const, reason: "no_model" };
    }

    // Start the streamed reply before the run so the placeholder appears instantly.
    if (driver && !this.#outbound.has(row.id)) {
      const outbound: Outbound = { target: message.target, lastText: "", lastEdit: 0 };
      this.#outbound.set(row.id, outbound);
      if (driver.typing) {
        void driver.typing(message.target).catch(() => {});
        outbound.typing = setInterval(() => void driver.typing?.(message.target).catch(() => {}), 8_000);
      }
      if (driver.edit) {
        driver
          .post(message.target, `${agent.avatar} _thinking…_`)
          .then((handle) => {
            outbound.handle = handle;
          })
          .catch(() => {});
      }
    }

    const sent = await this.send(row.id, { text, author: message.author });
    if (options.wait) return sent.wait();
    return { status: "done" as const };
  }

  /** `POST /api/hooks/:id`. */
  async receiveWebhook(connectorId: string, secret: string | undefined, body: { text?: string; thread?: string; user?: string; callback_url?: string }) {
    const connector = this.connectors.get(connectorId);
    if (!connector || connector.kind !== "webhook") throw new HttpError(404, "Unknown webhook");
    if (!connector.enabled) throw new HttpError(409, "This webhook is disabled");
    const expected = this.connectors.config(connectorId).secret;
    const given = Buffer.from(secret ?? "");
    const wanted = Buffer.from(expected ?? "");
    if (!expected || given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw new HttpError(401, "Bad secret");
    if (!body.text?.trim()) throw new HttpError(400, "text is required");
    const thread = body.thread?.trim() || newId("once");
    const message: InboundMessage = {
      externalKey: thread,
      location: `webhook ${thread}`,
      title: `${connector.name} · ${body.text.slice(0, 40)}`,
      author: { name: body.user?.trim() || "webhook", source: "webhook" },
      text: body.text,
      target: body.callback_url ? { callbackUrl: body.callback_url, thread } : { thread },
      isDirect: true,
    };
    if (body.callback_url) {
      void this.handleInbound(connector, message).catch((error) => this.#log(`webhook: ${String(error)}`));
      return { accepted: true, thread };
    }
    const result = await this.handleInbound(connector, message, { wait: true });
    return { thread, ...result };
  }

  #streamOutbound(threadId: string, live: LiveState) {
    const outbound = this.#outbound.get(threadId);
    if (!outbound?.handle || !live.busy) return;
    const row = this.#row(threadId);
    const driver = row?.connector_id ? this.connectors.driver(row.connector_id) : undefined;
    if (!driver?.edit) return;
    const agent = row ? this.agents.get(row.agent_id) : undefined;
    const running = live.tools.filter((t) => t.status !== "done").map((t) => `\`${t.name}\``);
    const partial = live.partial?.text?.trim();
    let text = partial ? `${partial} ▍` : `${agent?.avatar ?? "✦"} _thinking…_`;
    if (running.length) text += `\n\n🔧 _running ${running.join(", ")}…_`;
    if (live.retry) text += `\n\n⚠️ _retrying: ${live.retry.error.slice(0, 120)}_`;
    text = text.length > driver.maxLength ? `…${text.slice(text.length - driver.maxLength + 1)}` : text;
    if (text === outbound.lastText) return;
    const flush = () => {
      outbound.timer = undefined;
      outbound.lastEdit = Date.now();
      outbound.lastText = text;
      void driver.edit!(outbound.target, outbound.handle!, text).catch(() => {});
    };
    if (outbound.timer) clearTimeout(outbound.timer);
    const wait = 1_200 - (Date.now() - outbound.lastEdit);
    if (wait <= 0) flush();
    else outbound.timer = setTimeout(flush, wait);
  }

  /** Called by the Base extension's afterRun hook for every answered run in every conversation. */
  async runAnswered(conversationId: number, answerEntryId: number, _context: Context) {
    const row = this.db.get<ThreadRow>("SELECT * FROM threads WHERE conversation_id = ?", conversationId);
    if (!row) return; // a delegate's child conversation
    const text = await this.#answerText(conversationId, answerEntryId);
    const now = Date.now();
    this.db.run("UPDATE threads SET message_count = message_count + 1, preview = ?, updated_at = ? WHERE id = ?", text.slice(0, 140), now, row.id);
    const agent = this.agents.get(row.agent_id);
    this.activity({ type: "reply", text: `@${agent?.handle ?? "agent"}: ${text.slice(0, 120)}`, agentId: row.agent_id, threadId: row.id });
    const thread = this.thread(row.id);
    if (thread) this.emit({ type: "thread.updated", thread });
    if (row.connector_id) await this.#deliver(row, text || "_(no text answer)_");
  }

  async #deliver(row: ThreadRow, markdown: string) {
    const driver = row.connector_id ? this.connectors.driver(row.connector_id) : undefined;
    const outbound = this.#outbound.get(row.id);
    this.#outbound.delete(row.id);
    if (outbound?.timer) clearTimeout(outbound.timer);
    if (outbound?.typing) clearInterval(outbound.typing);
    if (!driver) return;
    const target = outbound?.target ?? (JSON.parse(row.meta ?? "{}") as ThreadMeta).target;
    if (!target) return;
    const parts = chunk(markdown, driver.maxLength);
    let first = 0;
    if (outbound?.handle && driver.edit) {
      await driver.edit(target, outbound.handle, parts[0]!).catch(() => driver.post(target, parts[0]!));
      first = 1;
    }
    for (const part of parts.slice(first)) await driver.post(target, part);
  }

  async #deliverFailure(threadId: string, failure: { reason: string; detail?: string }) {
    const outbound = this.#outbound.get(threadId);
    if (!outbound) return;
    const row = this.#row(threadId);
    if (!row) return;
    if (failure.reason === "aborted") {
      await this.#deliver(row, "⏹ _Stopped._");
      return;
    }
    const detail = failure.detail ? `: ${failure.detail.slice(0, 300)}` : "";
    await this.#deliver(row, `⚠️ I couldn't answer (${failure.reason.replace(/_/g, " ")}${detail}).`);
  }

  // ───────────────────────────── insight ─────────────────────────────

  activity(item: Omit<ActivityItem, "id" | "at">) {
    const at = Date.now();
    const result = this.db.run(
      "INSERT INTO activity (at, type, text, agent_id, thread_id, connector_id) VALUES (?, ?, ?, ?, ?, ?)",
      at,
      item.type,
      item.text,
      item.agentId ?? null,
      item.threadId ?? null,
      item.connectorId ?? null,
    );
    this.emit({ type: "activity", item: { ...item, id: Number(result.lastInsertRowid), at } });
  }

  recentActivity(limit = 50): ActivityItem[] {
    return this.db
      .all<{ id: number; at: number; type: ActivityItem["type"]; text: string; agent_id: string | null; thread_id: string | null; connector_id: string | null }>(
        "SELECT * FROM activity ORDER BY id DESC LIMIT ?",
        limit,
      )
      .map((r) => ({ id: r.id, at: r.at, type: r.type, text: r.text, agentId: r.agent_id ?? undefined, threadId: r.thread_id ?? undefined, connectorId: r.connector_id ?? undefined }));
  }

  async overview(): Promise<Overview> {
    const connectors = this.connectors.list();
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const usage = await this.harness.usage(ctx);
    return {
      agents: this.agents.list().length,
      threads: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads")?.n ?? 0,
      connectorsConnected: connectors.filter((c) => c.status === "connected").length,
      connectorsTotal: connectors.length,
      providersConfigured: (await this.providers.configured()).length,
      messagesToday: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE type = 'message' AND at >= ?", startOfDay.getTime())?.n ?? 0,
      usage: sumUsage(Object.values(usage.models).map((u) => usageOf(u as never) ?? ZERO)),
      activity: this.recentActivity(30),
      version: VERSION,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  async usage(): Promise<UsageSummary> {
    const total = await this.harness.usage(ctx);
    const byModel = Object.entries(total.models).map(([model, u]) => ({ model, usage: usageOf(u as never) ?? ZERO }));
    const perAgent = new Map<string, { usage: Usage[]; threads: number }>();
    for (const row of this.db.all<{ conversation_id: number; agent_id: string }>("SELECT conversation_id, agent_id FROM threads")) {
      const doc = await this.harness.snapshot(UsageDoc, cid(row.conversation_id), ctx).catch(() => undefined);
      const bucket = perAgent.get(row.agent_id) ?? { usage: [], threads: 0 };
      bucket.threads++;
      for (const u of Object.values(doc?.models ?? {})) bucket.usage.push(usageOf(u as never) ?? ZERO);
      perAgent.set(row.agent_id, bucket);
    }
    return {
      total: sumUsage(byModel.map((m) => m.usage)),
      byModel: byModel.sort((a, b) => b.usage.cost - a.usage.cost),
      byAgent: [...perAgent].map(([agentId, b]) => ({ agentId, usage: sumUsage(b.usage), threads: b.threads })),
    };
  }

  schedules(): Schedule[] {
    return this.db
      .all<{ task_id: string; thread_id: string; agent_id: string; text: string; at: number; status: Schedule["status"] }>("SELECT * FROM schedules ORDER BY at DESC LIMIT 200")
      .map((r) => ({ taskId: r.task_id, threadId: r.thread_id, agentId: r.agent_id, text: r.text, at: r.at, status: r.status }));
  }

  async cancelSchedule(taskId: string) {
    await this.harness.abortTask(Number(taskId) as never, ctx).catch(() => {});
    this.db.run("DELETE FROM schedules WHERE task_id = ?", taskId);
  }

  /** Live task graph, for the Tasks view. Ref-counted. */
  async subscribeTasks(listener: (tasks: TaskNode[]) => void): Promise<() => void> {
    const handler = (event: ServerEvent) => {
      if (event.type === "tasks") listener(event.tasks);
    };
    this.events.on("event", handler);
    this.#taskSubscribers++;
    if (!this.#taskWatch) {
      const watch = await this.harness.watchTaskGraph(ctx);
      this.#taskWatch = watch;
      const publish = (graph: import("@earendil-works/pi-durable").TaskGraph) => {
        const threadsByConversation = new Map(this.db.all<{ id: string; conversation_id: number }>("SELECT id, conversation_id FROM threads").map((r) => [r.conversation_id, r.id]));
        this.#tasks = Object.values(graph.tasks).map((node) => ({
          id: String(node.id),
          kind: node.kind,
          status: node.state.status === "waiting" ? `waiting on ${node.state.on.length}` : node.state.status,
          owner: node.owner !== undefined ? String(node.owner) : undefined,
          threadId: threadsByConversation.get(Number(node.conversationId)),
          detail: node.blocked ? `blocked: ${String((node.blocked as { reason?: string }).reason ?? node.blocked)}` : node.background ? "background" : undefined,
        }));
        this.emit({ type: "tasks", tasks: this.#tasks });
      };
      publish(watch.value);
      watch.start(async (call) => {
        if (call.kind === "value") publish(call.value);
      });
    } else {
      listener(this.#tasks);
    }
    return () => {
      this.events.off("event", handler);
      if (--this.#taskSubscribers === 0) {
        void this.#taskWatch?.stop();
        this.#taskWatch = undefined;
      }
    };
  }

  // ───────────────────────────── internals ─────────────────────────────

  #row(id: string): ThreadRow | undefined {
    return this.db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", id);
  }

  #thread(row: ThreadRow): Thread {
    return {
      id: row.id,
      agentId: row.agent_id,
      source: row.source,
      connectorId: row.connector_id,
      location: row.location,
      title: row.title,
      preview: row.preview,
      busy: this.#busy.has(row.id),
      messageCount: row.message_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async #conversation(row: ThreadRow): Promise<Conversation> {
    const conversation = await this.harness.conversation(cid(row.conversation_id), ctx);
    if (!conversation) throw new Error("The durable conversation for this thread is missing");
    return conversation;
  }

  async #answerText(conversationId: number, entryId: number): Promise<string> {
    const conversation = await this.harness.conversation(cid(conversationId), ctx);
    const page = await conversation?.entries({ minEntryId: eid(entryId), maxEntryId: eid(entryId) }, 1, undefined, ctx);
    const message = page?.items[0]?.model?.[0] as { content?: unknown } | undefined;
    return textOf(message?.content as never).trim();
  }
}

/** One shared Pi Durable watch per open thread, fanned out to WebSocket clients and the connector streamer. */
class ThreadWatcher {
  #listeners = new Set<(event: ServerEvent) => void>();
  #watch: WatchHandle<ConversationView> | undefined;
  #starting: Promise<void> | undefined;
  #seen = new Set<string>();
  #lastLive = "";
  #live: LiveState | undefined;

  readonly threadId: string;
  readonly agentId: string;
  readonly conversation: Conversation;
  readonly onLive: (live: LiveState) => void;

  constructor(threadId: string, agentId: string, conversation: Conversation, onLive: (live: LiveState) => void) {
    this.threadId = threadId;
    this.agentId = agentId;
    this.conversation = conversation;
    this.onLive = onLive;
  }

  get size() {
    return this.#listeners.size;
  }

  async add(listener: (event: ServerEvent) => void) {
    this.#listeners.add(listener);
    this.#starting ??= this.#start();
    await this.#starting;
    if (this.#live) listener({ type: "thread.live", threadId: this.threadId, live: this.#live });
  }

  remove(listener: (event: ServerEvent) => void): number {
    this.#listeners.delete(listener);
    return this.#listeners.size;
  }

  async #start() {
    const watch = await this.conversation.watch(BACKGROUND_CONTEXT, { min: 20, max: 60 });
    this.#watch = watch;
    for (const entry of watch.value.entries) this.#seen.add(String(entry.id));
    this.#publishLive(watch.value);
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      const fresh: Message[] = [];
      for (const entry of call.value.entries) {
        const id = String(entry.id);
        if (this.#seen.has(id)) continue;
        this.#seen.add(id);
        fresh.push(...toMessages(entry, this.threadId, this.agentId));
      }
      if (fresh.length) this.#broadcast({ type: "thread.messages", threadId: this.threadId, messages: fresh });
      this.#publishLive(call.value);
    });
  }

  #publishLive(view: ConversationView) {
    const live = toLive(view.docs);
    const key = JSON.stringify(live);
    if (key === this.#lastLive) return;
    this.#lastLive = key;
    this.#live = live;
    this.#broadcast({ type: "thread.live", threadId: this.threadId, live });
    this.onLive(live);
  }

  #broadcast(event: ServerEvent) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // a broken client never stops the others
      }
    }
  }

  async stop() {
    this.#listeners.clear();
    await this.#watch?.stop();
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function persistentSecret(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

function sumUsage(items: Usage[]): Usage {
  return items.reduce(
    (a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost + b.cost }),
    { ...ZERO },
  );
}

const PREFERRED: RegExp[] = [/^claude-sonnet-\d/, /^claude-opus-\d/, /^gpt-5\.\d+-sol$/, /^gpt-5(\.\d+)?$/, /^gemini-3[\d.]*-pro/, /^gemini-2\.5-pro/, /^grok-4/, /sonnet/, /gpt-5/, /^claude/];

/** A good default model for a provider: the latest mid/high tier chat model it lists. */
export function pickModel(_providerId: string, ids: string[]): string | undefined {
  for (const pattern of PREFERRED) {
    const matches = ids.filter((id) => pattern.test(id) && !/preview|mini|nano|lite|deep-research|computer-use|image|audio|tts|embed/.test(id));
    if (matches.length) return matches.sort(compareVersionsDesc)[0];
  }
  return ids.find((id) => !/preview|deep-research|computer-use|image|audio|embed/.test(id)) ?? ids[0];
}

function compareVersionsDesc(a: string, b: string): number {
  const na = (a.match(/\d+/g) ?? []).map(Number);
  const nb = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] ?? 0) - (na[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function helpText(agents: Agent[]): string {
  const names = agents.map((a) => `@${a.handle}`).join(", ");
  return [
    "*soloagent* — talk to your agents right here.",
    `• Address an agent: \`@handle your message\` or \`handle: your message\` (${names || "no agents yet"})`,
    "• `!agents` list agents · `!reset` fresh context · `!stop` stop the current run · `!help` this message",
    "Messages sent while an agent works steer it mid-run.",
  ].join("\n");
}

export type { InboundMessage, ReplyTarget } from "./connectors/types.ts";
export { EVENT_ENTRY, type EventEntryData };
