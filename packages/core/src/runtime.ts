import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type AssistantMessage, calculateCost, type Provider } from "@earendil-works/pi-ai";
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
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
  ActivityItem,
  Agent,
  AgentInput,
  Approval,
  ApprovalSettings,
  ApprovalStatus,
  AgentSpend,
  DailyUsage,
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
import { ApprovalStore, approvalOutcome, approvalPrompt, canApproveInChat, createApprovalExtensions } from "./approvals.ts";
import {
  ATTACHMENT_LIMITS,
  DownloadError,
  FileStore,
  attachmentContent,
  download,
  expandImageMarkers,
  externalizeImages,
  formatBytes,
  safeName,
  stripMarkers,
  type InboundAttachment,
} from "./attachments.ts";
import { createBackup, secretFingerprint, type SecretInfo } from "./backup.ts";
import { Automations, type NextRunFn } from "./automations.ts";
import { ConnectorManager } from "./connectors/manager.ts";
import { chunk } from "./connectors/format.ts";
import type { ChatDecisionInput, InboundMessage, PostHandle, ReplyTarget } from "./connectors/types.ts";
import { SealedCredentialStore } from "./credentials.ts";
import { Db, newId } from "./db.ts";
import { McpManager } from "./mcp.ts";
import { MemoryStore } from "./memories.ts";
import { ProviderHub } from "./providers.ts";
import { Sealer } from "./secrets.ts";
import { demoProvider } from "./demo.ts";
import { createSkills, type SkillHost } from "./skills.ts";
import { Ledger, listAllows, TeamStore } from "./team.ts";
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
  /** Let attachment URLs point at loopback and private networks. Default: SOLOAGENT_ALLOW_PRIVATE_FILE_URLS === "1". */
  allowPrivateFileUrls?: boolean;
  /** Testing: when automations fire next, instead of their cron schedule. */
  nextAutomationRun?: NextRunFn;
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
type Outbound = {
  handle?: PostHandle;
  /** Settles once the placeholder post has (or has not) produced `handle`. */
  placeholder?: Promise<void>;
  target: ReplyTarget;
  lastText: string;
  lastEdit: number;
  timer?: ReturnType<typeof setTimeout>;
  typing?: ReturnType<typeof setInterval>;
};

const ctx: Context = BACKGROUND_CONTEXT;
/** soloagent stores Pi's branded ids as plain numbers. */
const cid = (id: number) => id as unknown as ConversationId;
const eid = (id: number) => id as unknown as EntryId;
const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
/** One "you can't do that here" notice per person, connector, and reason in this window. */
const NOTICE_WINDOW_MS = 10 * 60_000;

/** Why a message was not admitted. `detail` is for the activity log, `message` for the person. */
type Denial = { reason: "access_denied" | "over_budget" | "rate_limited"; message: string; detail: string };

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
  readonly approvals: ApprovalStore;
  /** Dashboard users, invites, and sessions. */
  readonly team: TeamStore;
  /** Recorded spend and admitted messages, for budgets and rate limits. */
  readonly ledger: Ledger;
  /** Where the admin token comes from: SOLOAGENT_TOKEN / an option (rotate it there), or stored in settings. */
  readonly adminTokenSource: "env" | "option" | "stored";
  readonly automations: Automations;
  readonly mcp: McpManager;
  readonly memories: MemoryStore;
  readonly dataDir: string;
  #adminToken: string;
  #notices = new Map<string, number>();
  /** Files and images people shared, under `<dataDir>/files`. */
  readonly files: FileStore;
  readonly startedAt = Date.now();
  #allowPrivateFileUrls = process.env.SOLOAGENT_ALLOW_PRIVATE_FILE_URLS === "1";
  #images: Promise<import("@earendil-works/pi-durable/tools").ImageProcessor | undefined> | undefined;
  #skills: ReturnType<typeof createSkills>;
  #approvalExtensions: ReturnType<typeof createApprovalExtensions>;
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
    approvals: ApprovalStore;
    mcp: McpManager;
    skills: ReturnType<typeof createSkills>;
    approvalExtensions: ReturnType<typeof createApprovalExtensions>;
    adminToken: string;
    adminTokenSource: "env" | "option" | "stored";
    dataDir: string;
    log: (message: string) => void;
    nextAutomationRun?: NextRunFn;
  }) {
    this.db = init.db;
    this.harness = init.harness;
    this.agents = init.agents;
    this.providers = init.providers;
    this.connectors = init.connectors;
    this.approvals = init.approvals;
    this.mcp = init.mcp;
    this.memories = new MemoryStore(init.db);
    this.#skills = init.skills;
    this.#approvalExtensions = init.approvalExtensions;
    this.#adminToken = init.adminToken;
    this.adminTokenSource = init.adminTokenSource;
    this.team = new TeamStore(init.db);
    this.ledger = new Ledger(init.db);
    this.dataDir = init.dataDir;
    this.files = new FileStore(join(init.dataDir, "files"), init.db);
    this.#log = init.log;
    this.automations = new Automations(this, init.skills.Automation, init.nextAutomationRun);
  }

  static async open(options: SoloAgentOptions): Promise<SoloAgent> {
    const dataDir = resolve(options.dataDir);
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    const log = options.log ?? ((message: string) => console.log(`[solo] ${message}`));
    const secret = options.secret ?? process.env.SOLOAGENT_SECRET ?? persistentSecret(join(dataDir, ".secret"));
    const db = new Db(join(dataDir, "soloagent.sqlite"));
    const sealer = new Sealer(secret);

    const adminToken = options.adminToken ?? process.env.SOLOAGENT_TOKEN ?? db.setting("admin_token") ?? `solo_${randomBytes(18).toString("base64url")}`;
    const adminTokenSource = options.adminToken ? "option" : process.env.SOLOAGENT_TOKEN ? "env" : "stored";
    if (adminTokenSource === "stored") db.setSetting("admin_token", adminToken);

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
      decide: async (connector, input) => solo?.decideFromChat(connector.id, input) ?? { ok: false, message: "soloagent is starting up; try again in a moment." },
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
      automations: () => solo!.automations,
      runAnswered: (conversationId, answer, context) => void solo?.runAnswered(conversationId, answer, context).catch((error) => log(`deliver: ${String(error)}`)),
      responded: (conversationId, key, message) => {
        try {
          solo?.recordResponse(conversationId, key, message);
        } catch (error) {
          log(`spend: ${String(error)}`);
        }
      },
      delegated: (conversationId, agentId) => db.run("INSERT OR IGNORE INTO conversation_agents (conversation_id, agent_id) VALUES (?, ?)", conversationId, agentId),
      expandFiles: async (messages) => (solo ? expandImageMarkers(messages, solo.files) : messages),
    };

    const skills = createSkills(host);
    const approvals = new ApprovalStore(db, (approval, created) => solo?.approvalChanged(approval, created));
    const approvalExtensions = createApprovalExtensions({
      store: approvals,
      locate: (conversationId) => solo!.locateConversation(conversationId),
      waiting: (approval) => solo?.approvalWaiting(approval),
    });
    const registry = createRegistry();
    for (const extension of skills.all) registry.install(extension);
    for (const extension of Object.values(approvalExtensions)) registry.install(extension);
    const mcp = new McpManager(db, sealer, registry, {
      changed: (server, deleted) => emit(deleted ? { type: "mcp.deleted", serverId: server.id } : { type: "mcp.updated", server }),
      log: (message, error) => {
        log(message);
        if (error) solo?.activity({ type: "error", text: message });
      },
    }, { version: VERSION });

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

    solo = new SoloAgent({ db, harness, agents, providers, connectors, approvals, mcp, skills, approvalExtensions, adminToken, adminTokenSource, dataDir, log, nextAutomationRun: options.nextAutomationRun });
    if (options.allowPrivateFileUrls !== undefined) solo.#allowPrivateFileUrls = options.allowPrivateFileUrls;
    solo.#secret = { source: options.secret || process.env.SOLOAGENT_SECRET ? "env" : "file", fingerprint: secretFingerprint(secret), value: secret };
    harness.resume();
    void solo.reconcileApprovals();
    if (agents.list().length === 0) solo.seed();
    await solo.autoAssignModels();
    if (options.connectors !== false) void connectors.startAll();
    void mcp.startAll();
    return solo;
  }

  emit(event: ServerEvent) {
    this.events.emit("event", event);
  }

  /** The superuser token for the API, the CLI, and the dashboard. */
  get adminToken(): string {
    return this.#adminToken;
  }

  /** Replace a stored admin token. Sessions signed in with the old token end at their next request. */
  rotateAdminToken(): string {
    if (this.adminTokenSource !== "stored") {
      throw new HttpError(409, "The admin token is set by SOLOAGENT_TOKEN. Change it there and restart the server.");
    }
    const token = `solo_${randomBytes(18).toString("base64url")}`;
    this.db.setSetting("admin_token", token);
    this.#adminToken = token;
    this.activity({ type: "access", text: "The admin token was rotated" });
    return token;
  }

  async close() {
    await this.connectors.stopAll();
    await this.mcp.stopAll();
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
      extensions: [
        this.#skills.Base,
        ...skills.map((s) => this.#skills.extensions[s]),
        ...this.mcp.extensionsFor(agent.mcpServers ?? []),
        // Approvals: a beforeTool gate; agents with approvals off run exactly as before.
        ...(agent.approvals === "risky" || agent.approvals === "all" ? [this.#approvalExtensions[agent.approvals]] : []),
      ],
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
    const waiting = this.approvals.pendingThreads();
    return this.db
      .all<ThreadRow>(`SELECT * FROM threads ${where} ORDER BY updated_at DESC LIMIT ?`, ...params, Math.min(query.limit ?? 200, 1000))
      .map((row) => this.#thread(row, waiting));
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
    const live = withApprovals(toLive(view.value.docs), this.approvals.list({ status: "pending", threadId: id }));
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
    input: { text: string; author: Author; whenBusy?: "steer" | "followUp"; requestId?: string; attachments?: InboundAttachment[] },
  ): Promise<{ submissionId: string; wait: () => Promise<{ status: "done" | "unanswered"; answer?: string; reason?: string }> }> {
    const row = this.#row(threadId);
    if (!row) throw new Error("Thread not found");
    const agent = this.agents.get(row.agent_id);
    if (!agent) throw new Error("This thread's agent was deleted — switch it to another agent");
    if (!agent.model) throw new Error(`@${agent.handle} has no model yet. Connect a provider (Claude, ChatGPT, Copilot, …) in Providers.`);
    const userKey = input.author.id ?? input.author.name;
    const denied = this.checkLimits(agent, row.connector_id, userKey);
    if (denied) {
      this.activity({ type: "access", text: `${input.author.name} → @${agent.handle}: ${denied.detail}`, agentId: agent.id, threadId, connectorId: row.connector_id ?? undefined });
      throw new HttpError(429, denied.message);
    }
    const conversation = await this.#conversation(row);
    if (row.agent_version !== this.agents.version(agent)) {
      await conversation.configure(this.agentChange(agent), ctx);
      this.db.run("UPDATE threads SET agent_version = ? WHERE id = ?", this.agents.version(agent), threadId);
    }
    const text = stripMarkers(input.text).trim();
    const at = Date.now();
    const self = row.source === "web" || row.source === "tui" || row.source === "api";
    const head = self ? text : text ? `[${input.author.name}]: ${text}` : `[${input.author.name}] shared:`;
    const files = input.attachments?.length ? await this.#attach(input.attachments, agent, head) : undefined;
    if (!text && !files) throw new HttpError(400, "text or attachments are required");
    const summary = text || files!.refs.map((f) => f.name).join(", ") || "(attachments)";
    const submission = await conversation.submit(
      {
        type: "input",
        content: files?.content ?? head,
        whenBusy: input.whenBusy ?? "steer",
        requestId: input.requestId,
        entry: { kind: MESSAGE_ENTRY, data: { author: input.author, text, at, ...(files?.refs.length ? { attachments: files.refs } : {}) } satisfies MessageEntryData },
      },
      ctx,
    );
    const title = row.message_count === 0 && row.title === "New conversation" ? summary.replace(/\s+/g, " ").slice(0, 60) : row.title;
    this.db.run("UPDATE threads SET message_count = message_count + 1, preview = ?, title = ?, updated_at = ? WHERE id = ?", summary.slice(0, 140), title, at, threadId);
    this.ledger.recordAdmission({ agentId: agent.id, connectorId: row.connector_id, userKey, threadId, at });
    this.markBusy(threadId);
    const fileNote = files?.refs.length ? ` (+${files.refs.length} file${files.refs.length === 1 ? "" : "s"})` : "";
    this.activity({ type: "message", text: `${input.author.name} → @${agent.handle}: ${summary.slice(0, 100)}${fileNote}`, agentId: agent.id, threadId });
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

  /**
   * Store shared files and build the model content for them: the message text, then each file's image block,
   * fenced text, or note. Image blocks become markers that point at stored files (see `externalizeImages`).
   */
  async #attach(list: InboundAttachment[], agent: Agent, head: string) {
    const max = ATTACHMENT_LIMITS.maxFileBytes;
    const notes: string[] = [];
    const loaded = await Promise.all(
      list.map(async (attachment, index) => {
        const name = safeName(attachment.name);
        if (index >= ATTACHMENT_LIMITS.maxFiles) {
          notes.push(`[attached: ${name}: left out, at most ${ATTACHMENT_LIMITS.maxFiles} files per message]`);
          return undefined;
        }
        try {
          if (attachment.size > max || (attachment.data && attachment.data.byteLength > max)) throw new DownloadError(`larger than the ${formatBytes(max)} limit`);
          const bytes = attachment.data ?? (attachment.url ? await download(attachment.url, { allowPrivate: this.#allowPrivateFileUrls }) : undefined);
          if (!bytes) throw new DownloadError("no file data");
          return { ref: this.files.put(bytes, { name, mimeType: attachment.mimeType }), bytes };
        } catch (error) {
          notes.push(`[attached: ${name}: could not be read (${error instanceof DownloadError ? error.message : "failed"})]`);
          return undefined;
        }
      }),
    );
    const stored = loaded.filter((f) => f !== undefined);
    const images = stored.some((f) => f.ref.mimeType.startsWith("image/")) ? await this.#imageProcessor() : undefined;
    const resize = agent.model ? this.providers.models.getModel(agent.model.provider, agent.model.modelId)?.inputLimits?.images?.resize : undefined;
    const workspace = agent.skills.includes("workspace") ? join(this.dataDir, "workspaces", agent.handle, "attachments") : undefined;
    const blocks = await attachmentContent(
      stored.map((f) => ({ name: f.ref.name, mimeType: f.ref.mimeType, bytes: f.bytes, sha256: f.ref.sha256 })),
      {
        images,
        limits: resize ? { ...DEFAULT_IMAGE_LIMITS, ...Object.fromEntries(Object.entries(resize).filter(([key]) => key !== "jpegQuality")) } : undefined,
        savedAs: workspace
          ? (file) => {
              const name = `${(file.sha256 ?? "").slice(0, 8)}-${safeName(file.name)}`;
              try {
                mkdirSync(workspace, { recursive: true });
                if (!existsSync(join(workspace, name))) writeFileSync(join(workspace, name), file.bytes);
                return `attachments/${name}`;
              } catch {
                return undefined;
              }
            }
          : undefined,
      },
    );
    const content = externalizeImages(
      [...(head ? [{ type: "text" as const, text: head }] : []), ...blocks, ...notes.map((text) => ({ type: "text" as const, text }))],
      this.files,
      () => "image",
    );
    return { refs: stored.map((f) => f.ref), content };
  }

  #imageProcessor() {
    this.#images ??= import("@earendil-works/pi-durable/images/node").then(
      (m) => m.createNodePhotonImages(),
      (error) => {
        this.#log(`images: the Photon image processor is unavailable, images pass through unresized (${String(error)})`);
        return undefined;
      },
    );
    return this.#images;
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
      watcher = new ThreadWatcher(threadId, row.agent_id, await this.#conversation(row), (live) => this.#onLive(threadId, live), () =>
        this.approvals.list({ status: "pending", threadId }),
      );
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
    const deny = async (denial: Denial, agent: Agent | undefined) => {
      const userKey = message.author.id ?? message.author.name;
      if (this.#firstNotice(`${connector.id}:${userKey}:${denial.reason}`)) {
        await reply(denial.message);
        this.activity({
          type: "access",
          text: `${message.author.name}${message.channel?.name ? ` in ${message.channel.name}` : message.isDirect ? " (DM)" : ""} → ${agent ? `@${agent.handle}` : "soloagent"} on ${connector.name}: ${denial.detail}`,
          agentId: agent?.id,
          connectorId: connector.id,
        });
      }
      return { status: "unanswered" as const, reason: denial.reason, detail: denial.message };
    };

    // Addressing: "@coder fix the build" or "coder: fix the build" picks an agent.
    // A command may come first: "!reset @coder start over".
    const command = /^[!/](help|agents|reset|stop|new)\b/i.exec(text)?.[1]?.toLowerCase();
    let agent = connector.agentId ? this.agents.get(connector.agentId) : undefined;
    const rest = text.replace(/^[!/](reset|stop|new)\s*/i, "");
    const addressed = /^@?([a-z0-9][a-z0-9-]{0,31})[:,]?\s+([\s\S]+)$/i.exec(rest);
    let addressedAgent: Agent | undefined;
    if (addressed) {
      const named = this.agents.get(addressed[1]!.toLowerCase());
      if (named && (rest.startsWith("@") || /^[a-z0-9-]+[:,]/i.test(rest))) addressedAgent = named;
    }

    // Access: who may talk here, and from where. Webhooks are secret-authenticated: only `agents` applies.
    const here = this.#accessHere(connector, message);
    if (!here.ok) {
      const target = addressedAgent ?? agent ?? this.agents.default();
      return deny({ ...here.denial, message: `You don't have access to ${target ? `@${target.handle}` : "soloagent"} here. Ask an admin.` }, target);
    }

    if (command === "help") {
      const reachable = this.agents.list().filter((a) => !this.#agentDenied(connector, a));
      await reply(helpText(reachable));
      return { status: "done" as const, answer: helpText(reachable) };
    }
    if (command === "agents") {
      const list = this.agents
        .list()
        .filter((a) => !this.#agentDenied(connector, a))
        .map((a) => `${a.avatar} *@${a.handle}* — ${a.name}${a.description ? `: ${a.description}` : ""}${a.model ? "" : " _(no model yet)_"}`)
        .join("\n");
      await reply(list || "No agents are available here.");
      return { status: "done" as const, answer: list };
    }

    if (addressedAgent && addressed) {
      agent = addressedAgent;
      text = addressed[2]!.trim();
    }
    agent ??= this.agents.default();
    if (!agent) {
      await reply("No agents are set up yet. Open your soloagent dashboard to create one.");
      return { status: "unanswered" as const, reason: "no_agent" };
    }
    const agentDenied = this.#agentDenied(connector, agent);
    if (agentDenied) return deny(agentDenied, agent);

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
    if (!text && !message.attachments?.length) {
      await reply(`${agent.avatar} @${agent.handle} here — what can I do?`);
      return { status: "done" as const, answer: "" };
    }
    if (!agent.model) {
      await reply(`@${agent.handle} has no model yet — connect Claude, ChatGPT, or another provider in the soloagent dashboard.`);
      return { status: "unanswered" as const, reason: "no_model" };
    }
    const limited = this.checkLimits(agent, connector.id, message.author.id ?? message.author.name);
    if (limited) return deny(limited, agent);

    // Start the streamed reply before the run so the placeholder appears instantly.
    if (driver && !this.#outbound.has(row.id)) {
      const outbound: Outbound = { target: message.target, lastText: "", lastEdit: 0 };
      this.#outbound.set(row.id, outbound);
      if (driver.typing) {
        void driver.typing(message.target).catch(() => {});
        outbound.typing = setInterval(() => void driver.typing?.(message.target).catch(() => {}), 8_000);
      }
      if (driver.edit) {
        outbound.placeholder = driver
          .post(message.target, `${agent.avatar} _thinking…_`)
          .then((handle) => {
            outbound.handle = handle;
          })
          .catch(() => {});
      }
    }

    const sent = await this.send(row.id, { text, author: message.author, attachments: message.attachments });
    if (options.wait) return sent.wait();
    return { status: "done" as const };
  }

  /** `POST /api/hooks/:id`. */
  async receiveWebhook(connectorId: string, secret: string | undefined, body: { text?: string; thread?: string; user?: string; callback_url?: string; attachments?: unknown }) {
    const connector = this.connectors.get(connectorId);
    if (!connector || connector.kind !== "webhook") throw new HttpError(404, "Unknown webhook");
    if (!connector.enabled) throw new HttpError(409, "This webhook is disabled");
    const expected = this.connectors.config(connectorId).secret;
    const given = Buffer.from(secret ?? "");
    const wanted = Buffer.from(expected ?? "");
    if (!expected || given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw new HttpError(401, "Bad secret");
    const attachments = parseUploads(body.attachments);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim() && !attachments.length) throw new HttpError(400, "text is required");
    const thread = body.thread?.trim() || newId("once");
    const message: InboundMessage = {
      externalKey: thread,
      location: `webhook ${thread}`,
      title: `${connector.name} · ${(text.trim() || attachments.map((a) => a.name).join(", ")).slice(0, 40)}`,
      author: { name: body.user?.trim() || "webhook", source: "webhook" },
      text,
      target: body.callback_url ? { callbackUrl: body.callback_url, thread } : { thread },
      isDirect: true,
      ...(attachments.length ? { attachments } : {}),
    };
    if (body.callback_url) {
      void this.handleInbound(connector, message).catch((error) => this.#log(`webhook: ${String(error)}`));
      return { accepted: true, thread };
    }
    const result = await this.handleInbound(connector, message, { wait: true });
    if (result.status === "unanswered" && "detail" in result && result.detail) {
      if (result.reason === "access_denied") throw new HttpError(403, result.detail);
      if (result.reason === "over_budget" || result.reason === "rate_limited") throw new HttpError(429, result.detail);
    }
    return { thread, ...result };
  }

  // ───────────────────────────── teams: access, budgets, spend ─────────────────────────────

  /** The connector's user and channel lists. Webhooks are secret-authenticated and skip them. */
  #accessHere(connector: Connector, message: InboundMessage): { ok: true } | { ok: false; denial: Denial } {
    if (connector.kind === "webhook") return { ok: true };
    const { users, channels } = connector.access;
    const author = message.author;
    const userOk = listAllows(users, author.id, author.name);
    // A DM (or a message without a channel) is no channel at all: with a channel list set, only people the user list names explicitly get through.
    const channel = message.isDirect ? undefined : message.channel;
    const channelOk = channel
      ? listAllows(channels, channel.id, channel.name, channel.parent?.id, channel.parent?.name)
      : channels.length === 0 || (users.length > 0 && userOk);
    if (userOk && channelOk) return { ok: true };
    return {
      ok: false,
      denial: {
        reason: "access_denied",
        message: "You don't have access here. Ask an admin.",
        detail: !userOk ? "not on this connection's user list" : channel ? "this channel is not on the channel list" : "DMs need the user list to name this person",
      },
    };
  }

  /** Whether this connector may reach an agent: its agent list, and workspace safety for chat apps. */
  #agentDenied(connector: Connector, agent: Agent): Denial | undefined {
    const message = `You don't have access to @${agent.handle} here. Ask an admin.`;
    if (!listAllows(connector.access.agents, agent.id, agent.handle)) return { reason: "access_denied", message, detail: "agent is not on this connection's agent list" };
    if (connector.kind !== "webhook" && agent.skills.includes("workspace") && !agent.chatAccess) {
      return { reason: "access_denied", message, detail: "agents with the workspace skill are not reachable from chat unless chat access is on" };
    }
    return undefined;
  }

  /** Daily budget and per-user rate limit, checked before a message reaches the model. */
  checkLimits(agent: Agent, connectorId: string | null, userKey: string | null): Denial | undefined {
    const { dailyUsd, dailyRuns } = agent.budget;
    if (dailyUsd !== null && this.ledger.spentToday(agent.id) >= dailyUsd) {
      return {
        reason: "over_budget",
        message: `@${agent.handle} has used its daily budget ($${dailyUsd.toFixed(2)}). It resets at midnight UTC, or an admin can raise it.`,
        detail: `daily budget of $${dailyUsd.toFixed(2)} reached`,
      };
    }
    if (dailyRuns !== null && this.ledger.runsToday(agent.id) >= dailyRuns) {
      return {
        reason: "over_budget",
        message: `@${agent.handle} has reached its limit of ${dailyRuns} message${dailyRuns === 1 ? "" : "s"} for today. It resets at midnight UTC, or an admin can raise it.`,
        detail: `daily limit of ${dailyRuns} message${dailyRuns === 1 ? "" : "s"} reached`,
      };
    }
    const limit = connectorId ? this.connectors.get(connectorId)?.limits.perUserPerHour : null;
    if (connectorId && userKey && limit !== null && limit !== undefined && this.ledger.userMessagesLastHour(connectorId, userKey) >= limit) {
      return {
        reason: "rate_limited",
        message: `You've sent ${limit} message${limit === 1 ? "" : "s"} in the last hour, the limit here. Try again a little later.`,
        detail: `rate limit of ${limit} per hour reached`,
      };
    }
    return undefined;
  }

  /** True once per key per window, so a denied person can't make the bot spam the channel. */
  #firstNotice(key: string): boolean {
    const now = Date.now();
    const last = this.#notices.get(key);
    if (last !== undefined && now - last < NOTICE_WINDOW_MS) return false;
    if (this.#notices.size > 5_000) for (const [k, at] of this.#notices) if (now - at >= NOTICE_WINDOW_MS) this.#notices.delete(k);
    this.#notices.set(key, now);
    return true;
  }

  /** Called by the Base extension's afterResponse hook for every provider response, nested delegates included. */
  recordResponse(conversationId: number, key: string, message: AssistantMessage) {
    const u = message.usage;
    if (!u) return;
    let cost = u.cost?.total ?? 0;
    const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
    if (!cost && tokens > 0) {
      // Providers that report no price (subscriptions, the faux provider) are priced from the catalog.
      const model = this.providers.models.getModel(message.provider, message.model);
      if (model) cost = calculateCost(model, structuredClone(u)).total;
    }
    if (tokens === 0 && cost === 0) return;
    const row = this.db.get<ThreadRow>("SELECT * FROM threads WHERE conversation_id = ?", conversationId);
    this.ledger.recordSpend({
      key,
      agentId: this.agentForConversation(conversationId)?.id ?? row?.agent_id ?? null,
      connectorId: row?.connector_id ?? null,
      threadId: row?.id ?? null,
      conversationId,
      provider: message.provider,
      model: message.model,
      usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost },
      at: Date.now(),
    });
  }

  /** Today's (UTC) spend and messages for every agent, with their budgets. */
  spendToday(): AgentSpend[] {
    return this.ledger.today(this.agents.list().map((a) => ({ agentId: a.id, budget: a.budget })));
  }

  dailyUsage(days = 14): DailyUsage[] {
    return this.ledger.daily(days);
  }

  #streamOutbound(threadId: string, live: LiveState) {
    const outbound = this.#outbound.get(threadId);
    if (!outbound?.handle || !live.busy) return;
    const row = this.#row(threadId);
    const driver = row?.connector_id ? this.connectors.driver(row.connector_id) : undefined;
    if (!driver?.edit) return;
    const agent = row ? this.agents.get(row.agent_id) : undefined;
    const waiting = new Set((live.approvals ?? []).map((a) => a.callId));
    const running = live.tools.filter((t) => t.status !== "done" && !waiting.has(t.callId)).map((t) => `\`${t.name}\``);
    const partial = live.partial?.text?.trim();
    let text = partial ? `${partial} ▍` : `${agent?.avatar ?? "✦"} _thinking…_`;
    if (running.length) text += `\n\n🔧 _running ${running.join(", ")}…_`;
    if (live.approvals?.length) text += `\n\n🔐 _waiting for approval to run ${live.approvals.map((a) => `\`${a.tool}\``).join(", ")}…_`;
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
    // A quick answer can beat the placeholder post: wait for it (briefly), so the answer replaces the placeholder
    // instead of arriving as a second message under a "thinking…" that never goes away.
    if (outbound?.placeholder) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([outbound.placeholder, new Promise<void>((resolve) => (timer = setTimeout(resolve, 10_000)))]);
      clearTimeout(timer);
    }
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

  // ───────────────────────────── approvals ─────────────────────────────

  listApprovals(query: { status?: ApprovalStatus | "decided"; threadId?: string; limit?: number } = {}): Approval[] {
    return this.approvals.list(query);
  }

  approvalSettings(): ApprovalSettings {
    return this.approvals.settings();
  }

  setApprovalSettings(input: Partial<ApprovalSettings>): ApprovalSettings {
    return this.approvals.setSettings(input);
  }

  /**
   * Approve or deny a waiting tool call from the dashboard, the API, or the TUI. `by` names who decided; until
   * users exist it defaults to "dashboard".
   */
  decideApproval(id: string, input: { approve: boolean; by?: string; via?: string; reason?: string }): Approval {
    const approval = this.approvals.get(id);
    if (!approval) throw new HttpError(404, "Approval not found");
    if (approval.status !== "pending") throw new HttpError(409, `Already ${approval.status}${approval.decidedBy ? ` by ${approval.decidedBy}` : ""}`);
    const decided = this.approvals.decide(id, {
      status: input.approve ? "approved" : "denied",
      by: input.by?.trim() || "dashboard",
      via: input.via ?? "dashboard",
      reason: input.approve ? undefined : input.reason,
    });
    if (!decided) throw new HttpError(409, "Someone else decided it first");
    return decided;
  }

  /** A button press in Slack, Discord, or Telegram. Only the connector's approvers count. */
  async decideFromChat(connectorId: string, input: ChatDecisionInput): Promise<{ ok: boolean; message: string }> {
    const connector = this.connectors.get(connectorId);
    const approval = this.approvals.get(input.approvalId);
    const thread = approval?.threadId ? this.#row(approval.threadId) : undefined;
    if (!connector || !approval || thread?.connector_id !== connectorId) return { ok: false, message: "This approval request no longer exists." };
    if (approval.status !== "pending") {
      return { ok: false, message: `This was already ${approval.status}${approval.decidedBy && approval.decidedBy !== "timeout" ? ` by ${approval.decidedBy}` : ""}.` };
    }
    if (!canApproveInChat(connector.approvers, input.user)) {
      return {
        ok: false,
        message: connector.approvers.length
          ? `Sorry ${input.user.name}, you are not an approver for this connector. Ask an approver, or decide in the soloagent dashboard.`
          : "Approvals for this connector happen in the soloagent dashboard. An admin can add chat approvers in Connections.",
      };
    }
    const decided = this.approvals.decide(approval.id, {
      status: input.approve ? "approved" : "denied",
      by: input.user.name,
      via: connector.kind,
      reason: input.approve ? undefined : input.reason,
    });
    if (!decided) return { ok: false, message: "Someone else decided it first." };
    return { ok: true, message: input.approve ? "Approved." : "Denied." };
  }

  /** The thread and agent of a conversation; a delegate's child conversation belongs to its owner's thread. */
  async locateConversation(conversationId: number): Promise<{ threadId: string | null; agentId: string | null }> {
    const own = this.agentForConversation(conversationId)?.id ?? null;
    let id = conversationId;
    for (let depth = 0; depth < 8; depth++) {
      const row = this.db.get<ThreadRow>("SELECT * FROM threads WHERE conversation_id = ?", id);
      if (row) return { threadId: row.id, agentId: own ?? row.agent_id };
      const record = await this.harness.commit((tx) => tx.conversation(cid(id)), ctx).catch(() => undefined);
      if (record?.owner === undefined) break;
      id = Number(record.owner.conversationId);
    }
    return { threadId: null, agentId: own };
  }

  /** Called by the gate whenever a call waits, also again after a restart. */
  approvalWaiting(approval: Approval) {
    if (approval.threadId) {
      this.markBusy(approval.threadId);
      void this.#postApproval(approval).catch((error) => this.#log(`approval post: ${String(error)}`));
    }
  }

  /** Every created or decided approval: events, activity, the thread's live state, and its chat message. */
  approvalChanged(approval: Approval, created: boolean) {
    this.emit({ type: "approval.updated", approval });
    const agent = approval.agentId ? this.agents.get(approval.agentId) : undefined;
    const who = agent ? `@${agent.handle}` : "An agent";
    if (created) {
      this.activity({ type: "approval", text: `${who} is waiting for approval to run ${approval.tool}`, agentId: approval.agentId ?? undefined, threadId: approval.threadId ?? undefined });
    } else if (approval.status !== "cancelled") {
      const what = approval.status === "expired" ? "expired (denied)" : `${approval.status} by ${approval.decidedBy ?? "someone"}`;
      this.activity({ type: "approval", text: `${who} ${approval.tool}: ${what}`, agentId: approval.agentId ?? undefined, threadId: approval.threadId ?? undefined });
    }
    if (approval.threadId) {
      void this.#watchers.get(approval.threadId)?.refresh();
      const thread = this.thread(approval.threadId);
      if (thread) this.emit({ type: "thread.updated", thread });
    }
    if (!created) void this.#resolveApprovalMessage(approval).catch((error) => this.#log(`approval update: ${String(error)}`));
  }

  /** Requests whose tool task ended without a decision (a stop, a restart limit) are cancelled. */
  async reconcileApprovals() {
    for (const approval of this.approvals.list({ status: "pending", limit: 500 })) {
      const task = await this.harness.getTask(Number(approval.taskId) as never, ctx).catch(() => undefined);
      if (!task || task.state.status === "terminal") this.approvals.decide(approval.id, { status: "cancelled", by: "system", via: "system" });
    }
  }

  #agentLabel(approval: Approval): string {
    const agent = approval.agentId ? this.agents.get(approval.agentId) : undefined;
    return agent ? `${agent.avatar} @${agent.handle}` : "An agent";
  }

  async #postApproval(approval: Approval) {
    if (this.approvals.chat(approval.id)) return; // posted before a restart
    const row = approval.threadId ? this.#row(approval.threadId) : undefined;
    if (!row?.connector_id) return;
    const driver = this.connectors.driver(row.connector_id);
    if (!driver?.requestApproval) return;
    const target = this.#outbound.get(row.id)?.target ?? (JSON.parse(row.meta ?? "{}") as ThreadMeta).target;
    if (!target) return;
    const handle = await driver.requestApproval(target, approval.id, approvalPrompt(approval, this.#agentLabel(approval)));
    if (handle) this.approvals.setChat(approval.id, { connectorId: row.connector_id, target, handle });
  }

  async #resolveApprovalMessage(approval: Approval) {
    const chat = this.approvals.chat(approval.id);
    if (!chat) return;
    const driver = this.connectors.driver(chat.connectorId);
    await driver?.resolveApproval?.(chat.target, chat.handle, approvalOutcome(approval, this.#agentLabel(approval)));
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

  #thread(row: ThreadRow, waiting?: Set<string>): Thread {
    const waitingApproval = waiting ? waiting.has(row.id) : this.approvals.list({ status: "pending", threadId: row.id, limit: 1 }).length > 0;
    return {
      id: row.id,
      agentId: row.agent_id,
      source: row.source,
      connectorId: row.connector_id,
      location: row.location,
      title: row.title,
      preview: row.preview,
      busy: this.#busy.has(row.id),
      ...(waitingApproval ? { waitingApproval: true } : {}),
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
  #docs: Readonly<Record<string, unknown>> | undefined;

  readonly threadId: string;
  readonly agentId: string;
  readonly conversation: Conversation;
  readonly onLive: (live: LiveState) => void;
  readonly approvals: () => Approval[];

  constructor(threadId: string, agentId: string, conversation: Conversation, onLive: (live: LiveState) => void, approvals: () => Approval[]) {
    this.threadId = threadId;
    this.agentId = agentId;
    this.conversation = conversation;
    this.onLive = onLive;
    this.approvals = approvals;
  }

  /** Republish live state after something outside the view changed (an approval). */
  async refresh() {
    await this.#starting;
    if (this.#docs) this.#publishLive(this.#docs);
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
    this.#publishLive(watch.value.docs);
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
      this.#publishLive(call.value.docs);
    });
  }

  #publishLive(docs: Readonly<Record<string, unknown>>) {
    this.#docs = docs;
    const live = withApprovals(toLive(docs), this.approvals());
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

/** Approvals: attach a thread's pending requests to its live state. */
function withApprovals(live: LiveState, approvals: Approval[]): LiveState {
  return approvals.length ? { ...live, approvals } : live;
}

/**
 * Validate uploaded attachments from a JSON body: `[{ name, mimeType?, data_base64 } | { name, mimeType?, url }]`.
 * Used by the message routes and webhooks.
 */
export function parseUploads(value: unknown): InboundAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "attachments must be an array");
  if (value.length > ATTACHMENT_LIMITS.maxFiles) throw new HttpError(400, `At most ${ATTACHMENT_LIMITS.maxFiles} attachments per message`);
  return value.map((item: unknown, index) => {
    const upload = (item ?? {}) as { name?: unknown; mimeType?: unknown; data_base64?: unknown; url?: unknown };
    const name = typeof upload.name === "string" && upload.name.trim() ? upload.name : `file-${index + 1}`;
    const mimeType = typeof upload.mimeType === "string" ? upload.mimeType : "";
    if (typeof upload.data_base64 === "string") {
      const b64 = upload.data_base64.replace(/^data:[^,]*,/, "");
      if (Math.floor((b64.length * 3) / 4) > ATTACHMENT_LIMITS.maxFileBytes + 3) throw new HttpError(413, `${safeName(name)} is larger than the ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)} limit`);
      const data = Buffer.from(b64, "base64");
      return { name, mimeType, size: data.byteLength, data };
    }
    if (typeof upload.url === "string" && /^https?:\/\//i.test(upload.url)) return { name, mimeType, size: 0, url: upload.url };
    throw new HttpError(400, `Attachment ${index + 1} needs data_base64 or an http(s) url`);
  });
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
