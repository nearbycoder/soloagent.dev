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
  createdAt: number;
  updatedAt: number;
};

export type AgentInput = Partial<Omit<Agent, "id" | "createdAt" | "updatedAt">> & { name: string };

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
  createdAt: number;
  updatedAt: number;
};

export type ConnectorInput = {
  kind: ConnectorKind;
  name?: string;
  enabled?: boolean;
  agentId?: string | null;
  config?: Record<string, string>;
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
      /** Files and images shared with the message (Files & images). */
      attachments?: Attachment[];
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

// ── Files & images ──

/** A file shared with a message. The bytes are served at `GET /api/files/:sha256`. */
export type Attachment = { name: string; mimeType: string; size: number; sha256: string };

/** A file to send with a message: its bytes as base64, or (webhooks and the API) a URL to download. */
export type AttachmentUpload = { name: string; mimeType?: string; data_base64: string } | { name: string; mimeType?: string; url: string };

/** Ephemeral run state for a thread: streamed partials and running tools. */
export type LiveState = {
  busy: boolean;
  queued: number;
  turns: number;
  partial?: { text: string; thinking?: string; toolCalls: ToolCallInfo[] };
  tools: { callId: string; name: string; status: "pending" | "running" | "done"; output?: string }[];
  retry?: { at: number; error: string };
  failure?: { reason: string; detail?: string };
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
  type: "message" | "reply" | "connector" | "agent" | "provider" | "schedule" | "error";
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
  | { type: "tasks"; tasks: TaskNode[] };

/** Client → server WebSocket messages. */
export type ClientEvent =
  | { type: "subscribe"; threadId: string }
  | { type: "unsubscribe"; threadId: string }
  | { type: "tasks.subscribe" }
  | { type: "tasks.unsubscribe" }
  | { type: "ping" };
