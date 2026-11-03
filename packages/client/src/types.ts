/**
 * The soloagent wire protocol. Everything the web GUI, the TUI, and third-party
 * clients see is defined here. No runtime dependencies: safe in browsers and Node.
 */

/** Where a message or thread came from. */
export type Source = "web" | "tui" | "api" | "slack" | "discord" | "telegram" | "webhook" | "schedule" | "agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelRef = { provider: string; modelId: string };

/** Capabilities an agent can be granted. Each maps to a Pi Durable extension or tool set. */
export type AgentSkill =
  | "memory" // remember / recall / forget long-term notes
  | "web" // fetch web pages
  | "delegate" // ask other agents for help (durable subagents)
  | "schedule" // durable reminders and follow-ups that survive restarts
  | "workspace"; // read / write / edit / bash in a private workspace directory

export const AGENT_SKILLS: readonly { id: AgentSkill; label: string; description: string; dangerous?: boolean }[] = [
  { id: "memory", label: "Memory", description: "Keeps long-term notes about people, preferences, and facts across every conversation." },
  { id: "web", label: "Web", description: "Fetches and reads web pages and APIs." },
  { id: "delegate", label: "Delegate", description: "Hands sub-tasks to your other agents and waits for their answers." },
  { id: "schedule", label: "Schedule", description: "Sets durable reminders and follow-ups that fire even after restarts." },
  {
    id: "workspace",
    label: "Workspace",
    description: "Reads, writes, and edits files and runs shell commands in a private workspace folder.",
    dangerous: true,
  },
];

export type Agent = {
  id: string;
  /** Unique handle used for @mentions, e.g. "coder". Lowercase letters, digits, dashes. */
  handle: string;
  name: string;
  /** A single emoji or short glyph shown as the avatar. */
  avatar: string;
  /** Accent color, hex. */
  color: string;
  description: string;
  instructions: string;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  skills: AgentSkill[];
  /** Upper bound on tool rounds per run. */
  maxTurns: number;
  /** Default agent answers anything not addressed to a specific agent. */
  isDefault: boolean;
  /** Approvals: which tool calls wait for a human first. See `ApprovalPolicy`. */
  approvals: ApprovalPolicy;
  // Teams: spend limits, and whether chat connectors may reach an agent that has the workspace skill.
  budget: AgentBudget;
  chatAccess: boolean;
  createdAt: number;
  updatedAt: number;
};

export type AgentInput = Partial<Omit<Agent, "id" | "createdAt" | "updatedAt" | "budget">> & { name: string; budget?: Partial<AgentBudget> };

export type ProviderModel = {
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  /** USD per million tokens. */
  cost: { input: number; output: number };
};

export type ProviderInfo = {
  id: string;
  name: string;
  /** Supports an OAuth login, usually a consumer subscription (Claude Pro/Max, ChatGPT, Copilot). */
  oauth: { label: string; subscription: boolean } | null;
  apiKey: boolean;
  /** How it is configured right now, if at all. */
  configured: { type: "api_key" | "oauth"; source?: string } | null;
  /** Popular providers are shown first in pickers. */
  featured: boolean;
  models: ProviderModel[];
};

export type LoginFlowState = {
  id: string;
  providerId: string;
  type: "oauth" | "api_key";
  status: "running" | "waiting" | "done" | "failed" | "cancelled";
  /** What the flow currently asks the user, if anything. */
  prompt?: {
    type: "text" | "secret" | "select" | "manual_code";
    message: string;
    placeholder?: string;
    options?: { id: string; label: string; description?: string }[];
  };
  authUrl?: { url: string; instructions?: string };
  deviceCode?: { userCode: string; verificationUri: string };
  log: { at: number; message: string; links?: { url: string; label?: string }[] }[];
  error?: string;
};

export type ConnectorKind = "slack" | "discord" | "telegram" | "webhook";

export type ConnectorField = {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  optional?: boolean;
};

export type ConnectorKindInfo = {
  kind: ConnectorKind;
  name: string;
  tagline: string;
  fields: ConnectorField[];
  /** Markdown setup guide. */
  setup: string;
};

export type ConnectorStatus = "stopped" | "starting" | "connected" | "error";

export type Connector = {
  id: string;
  kind: ConnectorKind;
  name: string;
  enabled: boolean;
  /** Agent that answers messages not addressed to a specific agent. null: the default agent. */
  agentId: string | null;
  /** Non-secret config values; secrets are returned as "••••" when set. */
  config: Record<string, string>;
  status: ConnectorStatus;
  statusDetail?: string;
  /** Who the connector is signed in as on the platform, e.g. "@solo in Acme". */
  identity?: string;
  /** Approvals: platform user ids or display names allowed to approve tool calls in chat. Empty: dashboard only. */
  approvers: string[];
  // Teams: who may use this connector, where, which agents they reach, and how often.
  access: ConnectorAccess;
  limits: ConnectorLimits;
  createdAt: number;
  updatedAt: number;
};

export type ConnectorInput = {
  kind: ConnectorKind;
  name?: string;
  enabled?: boolean;
  agentId?: string | null;
  config?: Record<string, string>;
  /** Approvals: see `Connector.approvers`. */
  approvers?: string[];
  access?: Partial<ConnectorAccess>;
  limits?: Partial<ConnectorLimits>;
};

export type Thread = {
  id: string;
  agentId: string;
  source: Source;
  connectorId: string | null;
  /** Platform location, e.g. "#general" or "DM with ann". */
  location: string | null;
  title: string;
  preview: string;
  busy: boolean;
  /** Approvals: a tool call in this thread waits for someone to approve it. */
  waitingApproval?: boolean;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type Author = { name: string; id?: string; source: Source; avatarUrl?: string };

export type ToolCallInfo = { id: string; name: string; args: unknown };

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

/** One transcript item, normalized from Pi Durable entries. */
export type Message =
  | {
      id: string;
      kind: "user";
      threadId: string;
      author: Author;
      text: string;
      at: number;
    }
  | {
      id: string;
      kind: "assistant";
      threadId: string;
      agentId: string;
      text: string;
      thinking?: string;
      toolCalls: ToolCallInfo[];
      model?: string;
      usage?: Usage;
      stopReason?: string;
      error?: string;
      at: number;
    }
  | {
      id: string;
      kind: "tool";
      threadId: string;
      callId: string;
      name: string;
      text: string;
      isError: boolean;
      at: number;
    }
  | {
      id: string;
      kind: "event";
      threadId: string;
      text: string;
      tone: "info" | "warn" | "error";
      at: number;
    };

/** Ephemeral run state for a thread: streamed partials and running tools. */
export type LiveState = {
  busy: boolean;
  queued: number;
  turns: number;
  partial?: { text: string; thinking?: string; toolCalls: ToolCallInfo[] };
  tools: { callId: string; name: string; status: "pending" | "running" | "done"; output?: string }[];
  retry?: { at: number; error: string };
  failure?: { reason: string; detail?: string };
  /** Approvals: tool calls of this thread waiting for a decision. The run is paused on them. */
  approvals?: Approval[];
};

export type ThreadSnapshot = { thread: Thread; messages: Message[]; hasMore: boolean; live: LiveState };

export type UsageSummary = {
  total: Usage;
  byModel: { model: string; usage: Usage }[];
  byAgent: { agentId: string; usage: Usage; threads: number }[];
};

export type TaskNode = {
  id: string;
  kind: string;
  status: string;
  owner?: string;
  threadId?: string;
  detail?: string;
};

export type ActivityItem = {
  id: number;
  at: number;
  type: "message" | "reply" | "connector" | "agent" | "provider" | "schedule" | "error" | "approval" | "access";
  text: string;
  agentId?: string;
  threadId?: string;
  connectorId?: string;
};

export type Overview = {
  agents: number;
  threads: number;
  connectorsConnected: number;
  connectorsTotal: number;
  providersConfigured: number;
  messagesToday: number;
  usage: Usage;
  activity: ActivityItem[];
  version: string;
  uptimeMs: number;
};

export type Schedule = {
  taskId: string;
  threadId: string;
  agentId: string;
  text: string;
  at: number;
  status: "sleeping" | "running" | "done";
};

// ───────────── Approvals (human-in-the-loop tool calls) ─────────────

/**
 * Which of an agent's tool calls wait for a human: none, the risky ones (`bash`, `write`, `edit`, plus the
 * names in `ApprovalSettings.riskyTools`), or all but read-only ones (`read`, `recall`, `web_search`).
 */
export type ApprovalPolicy = "off" | "risky" | "all";

export const APPROVAL_POLICIES: readonly { id: ApprovalPolicy; label: string; description: string }[] = [
  { id: "off", label: "Off", description: "Tools run without asking." },
  { id: "risky", label: "Risky tools", description: "Ask before shell commands, file writes and edits, and tools on the risky list." },
  { id: "all", label: "Every tool", description: "Ask before every tool call except read-only ones (read, recall, web_search)." },
];

/** `expired`: nobody answered before the timeout (a denial). `cancelled`: the run was stopped or the call ended. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export type Approval = {
  id: string;
  /** The tool call: its name, arguments, and call id (matches `ToolCallInfo.id` and `LiveState.tools[].callId`). */
  tool: string;
  args: unknown;
  callId: string;
  /** The durable tool task that waits. */
  taskId: string;
  threadId: string | null;
  agentId: string | null;
  status: ApprovalStatus;
  /** Who decided: "dashboard", a chat display name, or "timeout". */
  decidedBy?: string;
  /** Where the decision came from: "dashboard", "api", "slack", "discord", "telegram", "tui", "timeout". */
  decidedVia?: string;
  reason?: string;
  createdAt: number;
  decidedAt?: number;
  /** Auto-denied at this time. */
  expiresAt: number;
};

export type ApprovalSettings = {
  /** How long a request waits before it is auto-denied. Default 24 hours. */
  timeoutMs: number;
  /** Extra tool names the "risky" policy asks about, e.g. "forget" or an MCP tool. */
  riskyTools: string[];
};
// ───────────────────────────── Teams ─────────────────────────────

/** Per-agent spend limits for the current UTC day. null: unlimited. */
export type AgentBudget = { dailyUsd: number | null; dailyRuns: number | null };

/**
 * Who may use a connector. Each empty list means everyone, everywhere, or every agent.
 * `users` match the platform user id or display name, `channels` the channel id or name ("#eng"),
 * `agents` agent ids or handles.
 */
export type ConnectorAccess = { users: string[]; channels: string[]; agents: string[] };

export type ConnectorLimits = { perUserPerHour: number | null };

export type Role = "admin" | "member";

/** Who is making a request: the admin token (superuser) or a signed-in user. */
export type Actor = { kind: "token" | "user"; userId?: string; name: string; role: Role };

export type Me = {
  ok: true;
  version: string;
  actor: Actor;
  /** The admin token comes from SOLOAGENT_TOKEN and has to be rotated there. */
  tokenFromEnv: boolean;
};

export type User = {
  id: string;
  name: string;
  role: Role;
  hasPassword: boolean;
  createdAt: number;
  lastSeenAt: number | null;
};

export type Invite = {
  id: string;
  role: Role;
  /** Suggested name for the invitee. */
  name: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
};

/** Returned once, when an invite is created: the code is never stored in plain text. */
export type CreatedInvite = { invite: Invite; code: string; path: string; url: string };

/** Today's (UTC) spend for one agent against its budget. */
export type AgentSpend = { agentId: string; usd: number; runs: number; budget: AgentBudget };

/** Recorded provider spend for one UTC day. */
export type DailyUsage = { day: string; usage: Usage; responses: number; byAgent: { agentId: string; cost: number }[] };

/** Server → client WebSocket events. */
export type ServerEvent =
  | { type: "hello"; version: string }
  | { type: "thread.updated"; thread: Thread }
  | { type: "thread.deleted"; threadId: string }
  | { type: "thread.snapshot"; snapshot: ThreadSnapshot }
  | { type: "thread.messages"; threadId: string; messages: Message[] }
  | { type: "thread.live"; threadId: string; live: LiveState }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.deleted"; agentId: string }
  | { type: "connector.updated"; connector: Connector }
  | { type: "connector.deleted"; connectorId: string }
  | { type: "providers.changed" }
  | { type: "login.updated"; flow: LoginFlowState }
  | { type: "activity"; item: ActivityItem }
  | { type: "tasks"; tasks: TaskNode[] }
  // Approvals
  | { type: "approval.updated"; approval: Approval };

/** Client → server WebSocket messages. */
export type ClientEvent =
  | { type: "subscribe"; threadId: string }
  | { type: "unsubscribe"; threadId: string }
  | { type: "tasks.subscribe" }
  | { type: "tasks.unsubscribe" }
  | { type: "ping" };
