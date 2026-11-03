import type {
  Agent,
  AttachmentUpload,
  AgentExport,
  AgentImportMode,
  AgentImportResult,
  AgentInput,
  Approval,
  ApprovalSettings,
  ApprovalStatus,
  AgentSpend,
  CreatedInvite,
  DailyUsage,
  Invite,
  Me,
  Role,
  User,
  Automation,
  AutomationInput,
  AutomationPreview,
  ClientEvent,
  Connector,
  ConnectorInput,
  ConnectorKindInfo,
  LoginFlowState,
  McpServer,
  McpServerInput,
  McpTestResult,
  Memory,
  Message,
  Overview,
  ProviderInfo,
  Schedule,
  ServerEvent,
  Thread,
  ThreadSnapshot,
  UsageSummary,
  VersionInfo,
} from "./types.ts";

export class SoloApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SoloApiError";
    this.status = status;
  }
}

export type SoloClientOptions = {
  /** Base URL of the soloagent server, e.g. "https://my-solo.up.railway.app". Empty string: same origin. */
  baseUrl: string;
  /** Admin token. Omit in the browser when the session cookie is set. */
  token?: string;
  fetch?: typeof fetch;
  /** WebSocket constructor; defaults to globalThis.WebSocket (Node 22+ and browsers). */
  WebSocket?: typeof WebSocket;
};

export type SendOptions = {
  /** Display name of the sender. */
  author?: string;
  source?: "web" | "tui" | "api";
  /** While a run is going: steer it (default) or queue as a follow-up. */
  whenBusy?: "steer" | "followUp";
  /** Files and images, as base64 (`data_base64`) or URLs. Up to 10 files of 20 MB each. */
  attachments?: AttachmentUpload[];
};

type Listener = (event: ServerEvent) => void;

/**
 * Typed client for the soloagent HTTP + WebSocket API. Used by the web GUI and the TUI,
 * and usable from any script:
 *
 * ```ts
 * const solo = new SoloClient({ baseUrl: "http://localhost:7420", token: process.env.SOLOAGENT_TOKEN });
 * const thread = await solo.createThread({ agentId: "coder" });
 * await solo.send(thread.id, "Summarize today's deploys");
 * ```
 */
export class SoloClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  #fetch: typeof fetch;
  #WebSocket: typeof WebSocket | undefined;

  constructor(options: SoloClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#WebSocket = options.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.#fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const message = (data as { error?: string } | undefined)?.error ?? `${response.status} ${response.statusText}`;
      throw new SoloApiError(response.status, message);
    }
    return data as T;
  }

  // Session
  me() {
    return this.request<Me>("GET", "/me");
  }
  login(token: string) {
    return this.request<{ ok: true }>("POST", "/session", { token });
  }
  /** Sign in as a team member with the name and password they chose. */
  loginPassword(name: string, password: string) {
    return this.request<{ ok: true }>("POST", "/session", { name, password });
  }
  logout() {
    return this.request<{ ok: true }>("DELETE", "/session");
  }

  // Overview
  overview() {
    return this.request<Overview>("GET", "/overview");
  }
  usage() {
    return this.request<UsageSummary>("GET", "/usage");
  }

  // Agents
  agents() {
    return this.request<Agent[]>("GET", "/agents");
  }
  createAgent(input: AgentInput) {
    return this.request<Agent>("POST", "/agents", input);
  }
  updateAgent(id: string, input: Partial<AgentInput>) {
    return this.request<Agent>("PATCH", `/agents/${encodeURIComponent(id)}`, input);
  }
  deleteAgent(id: string) {
    return this.request<{ ok: true }>("DELETE", `/agents/${encodeURIComponent(id)}`);
  }

  // Backups, export/import, upgrade notices
  version() {
    return this.request<VersionInfo>("GET", "/version");
  }
  exportAgents() {
    return this.request<AgentExport>("GET", "/agents/export");
  }
  /** Import agents matched by handle. `dryRun` returns what would change without writing. */
  importAgents(input: { agents: unknown[]; mode?: AgentImportMode }, options: { dryRun?: boolean } = {}) {
    return this.request<AgentImportResult>("POST", `/agents/import${options.dryRun ? "?dryRun=1" : ""}`, input);
  }
  /** Stream a backup archive (`.tar.gz`). The caller reads `response.body`. */
  async backup(options: { includeSecret?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.#fetch(`${this.baseUrl}/api/backup${options.includeSecret ? "?includeSecret=1" : ""}`, { headers, credentials: "include" });
    if (!response.ok) {
      const data = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new SoloApiError(response.status, data?.error ?? `${response.status} ${response.statusText}`);
    }
    return response;
  }

  // Memories: an agent's long-term notes
  memories(agentId: string, query: { q?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.limit) params.set("limit", String(query.limit));
    const qs = params.toString();
    return this.request<Memory[]>("GET", `/agents/${encodeURIComponent(agentId)}/memories${qs ? `?${qs}` : ""}`);
  }
  addMemory(agentId: string, text: string) {
    return this.request<Memory>("POST", `/agents/${encodeURIComponent(agentId)}/memories`, { text });
  }
  updateMemory(agentId: string, memoryId: number, text: string) {
    return this.request<Memory>("PATCH", `/agents/${encodeURIComponent(agentId)}/memories/${memoryId}`, { text });
  }
  deleteMemory(agentId: string, memoryId: number) {
    return this.request<{ ok: true }>("DELETE", `/agents/${encodeURIComponent(agentId)}/memories/${memoryId}`);
  }
  /** Delete every memory of an agent. */
  clearMemories(agentId: string) {
    return this.request<{ ok: true; deleted: number }>("DELETE", `/agents/${encodeURIComponent(agentId)}/memories?confirm=all`);
  }
  /** Memory count per agent id. */
  memoryCounts() {
    return this.request<Record<string, number>>("GET", "/memories/counts");
  }

  // MCP servers 
  mcpServers() {
    return this.request<McpServer[]>("GET", "/mcp-servers");
  }
  mcpServer(id: string) {
    return this.request<McpServer>("GET", `/mcp-servers/${encodeURIComponent(id)}`);
  }
  createMcpServer(input: McpServerInput) {
    return this.request<McpServer>("POST", "/mcp-servers", input);
  }
  updateMcpServer(id: string, input: McpServerInput) {
    return this.request<McpServer>("PATCH", `/mcp-servers/${encodeURIComponent(id)}`, input);
  }
  deleteMcpServer(id: string) {
    return this.request<{ ok: true }>("DELETE", `/mcp-servers/${encodeURIComponent(id)}`);
  }
  /** Connect if needed and list the server's tools live. */
  testMcpServer(id: string) {
    return this.request<McpTestResult>("POST", `/mcp-servers/${encodeURIComponent(id)}/test`);
  }

  // Providers & subscriptions
  providers() {
    return this.request<ProviderInfo[]>("GET", "/providers");
  }
  setApiKey(providerId: string, key: string) {
    return this.request<{ ok: true }>("PUT", `/providers/${encodeURIComponent(providerId)}/key`, { key });
  }
  logoutProvider(providerId: string) {
    return this.request<{ ok: true }>("DELETE", `/providers/${encodeURIComponent(providerId)}/credential`);
  }
  startLogin(providerId: string, type: "oauth" | "api_key" = "oauth") {
    return this.request<LoginFlowState>("POST", `/providers/${encodeURIComponent(providerId)}/login`, { type });
  }
  loginFlow(flowId: string) {
    return this.request<LoginFlowState>("GET", `/logins/${encodeURIComponent(flowId)}`);
  }
  answerLogin(flowId: string, value: string) {
    return this.request<LoginFlowState>("POST", `/logins/${encodeURIComponent(flowId)}/answer`, { value });
  }
  cancelLogin(flowId: string) {
    return this.request<LoginFlowState>("DELETE", `/logins/${encodeURIComponent(flowId)}`);
  }

  // Connectors
  connectorKinds() {
    return this.request<ConnectorKindInfo[]>("GET", "/connector-kinds");
  }
  connectors() {
    return this.request<Connector[]>("GET", "/connectors");
  }
  createConnector(input: ConnectorInput) {
    return this.request<Connector>("POST", "/connectors", input);
  }
  updateConnector(id: string, input: Partial<ConnectorInput>) {
    return this.request<Connector>("PATCH", `/connectors/${encodeURIComponent(id)}`, input);
  }
  deleteConnector(id: string) {
    return this.request<{ ok: true }>("DELETE", `/connectors/${encodeURIComponent(id)}`);
  }
  restartConnector(id: string) {
    return this.request<Connector>("POST", `/connectors/${encodeURIComponent(id)}/restart`);
  }

  // Threads
  threads(query: { agentId?: string; source?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const qs = params.toString();
    return this.request<Thread[]>("GET", `/threads${qs ? `?${qs}` : ""}`);
  }
  createThread(input: { agentId?: string; title?: string; source?: "web" | "tui" | "api" } = {}) {
    return this.request<Thread>("POST", "/threads", input);
  }
  thread(id: string) {
    return this.request<ThreadSnapshot>("GET", `/threads/${encodeURIComponent(id)}`);
  }
  messages(id: string, before?: string, limit = 50) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    return this.request<{ messages: Message[]; hasMore: boolean }>("GET", `/threads/${encodeURIComponent(id)}/messages?${params}`);
  }
  send(id: string, text: string, options: SendOptions = {}) {
    return this.request<{ submissionId: string }>("POST", `/threads/${encodeURIComponent(id)}/messages`, { text, ...options });
  }
  /** Send and wait for the agent's answer. */
  ask(id: string, text: string, options: SendOptions = {}) {
    return this.request<{ status: "done" | "unanswered"; answer?: string; reason?: string }>(
      "POST",
      `/threads/${encodeURIComponent(id)}/ask`,
      { text, ...options },
    );
  }
  /** URL of a shared file, for `<img src>` and downloads (same-origin cookie or a Bearer token). */
  fileUrl(sha256: string) {
    return `${this.baseUrl}/api/files/${encodeURIComponent(sha256)}`;
  }
  updateThread(id: string, input: { title?: string; agentId?: string }) {
    return this.request<Thread>("PATCH", `/threads/${encodeURIComponent(id)}`, input);
  }
  stop(id: string) {
    return this.request<{ ok: true }>("POST", `/threads/${encodeURIComponent(id)}/stop`);
  }
  reset(id: string) {
    return this.request<{ ok: true }>("POST", `/threads/${encodeURIComponent(id)}/reset`);
  }
  compact(id: string) {
    return this.request<{ ok: true }>("POST", `/threads/${encodeURIComponent(id)}/compact`);
  }
  deleteThread(id: string) {
    return this.request<{ ok: true }>("DELETE", `/threads/${encodeURIComponent(id)}`);
  }

  // Schedules
  schedules() {
    return this.request<Schedule[]>("GET", "/schedules");
  }
  cancelSchedule(taskId: string) {
    return this.request<{ ok: true }>("DELETE", `/schedules/${encodeURIComponent(taskId)}`);
  }

  // Approvals
  approvals(query: { status?: ApprovalStatus | "decided"; threadId?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const qs = params.toString();
    return this.request<Approval[]>("GET", `/approvals${qs ? `?${qs}` : ""}`);
  }
  /** `by` names who decided (default "dashboard"); `via` is "dashboard", "tui", or "api". */
  approve(id: string, options: { by?: string; via?: "dashboard" | "tui" | "api" } = {}) {
    return this.request<Approval>("POST", `/approvals/${encodeURIComponent(id)}/approve`, options);
  }
  deny(id: string, options: { reason?: string; by?: string; via?: "dashboard" | "tui" | "api" } = {}) {
    return this.request<Approval>("POST", `/approvals/${encodeURIComponent(id)}/deny`, options);
  }
  approvalSettings() {
    return this.request<ApprovalSettings>("GET", "/approval-settings");
  }
  updateApprovalSettings(input: Partial<ApprovalSettings>) {
    return this.request<ApprovalSettings>("PUT", "/approval-settings", input);
  }
  // Teams: users, invites, the admin token, and spend
  users() {
    return this.request<User[]>("GET", "/users");
  }
  updateUser(id: string, input: { role?: Role; name?: string }) {
    return this.request<User>("PATCH", `/users/${encodeURIComponent(id)}`, input);
  }
  deleteUser(id: string) {
    return this.request<{ ok: true }>("DELETE", `/users/${encodeURIComponent(id)}`);
  }
  invites() {
    return this.request<Invite[]>("GET", "/invites");
  }
  createInvite(input: { role: Role; name?: string }) {
    return this.request<CreatedInvite>("POST", "/invites", input);
  }
  revokeInvite(id: string) {
    return this.request<{ ok: true }>("DELETE", `/invites/${encodeURIComponent(id)}`);
  }
  /** Public: what an invite link offers, before accepting it. */
  invite(code: string) {
    return this.request<{ role: Role; name: string | null; expiresAt: number }>("GET", `/invite/${encodeURIComponent(code)}`);
  }
  /** Public: accept an invite, create the account, and sign in (sets the session cookie). */
  acceptInvite(code: string, input: { name: string; password: string }) {
    return this.request<{ ok: true; user: User }>("POST", `/invite/${encodeURIComponent(code)}`, input);
  }
  rotateAdminToken() {
    return this.request<{ token: string }>("POST", "/admin-token/rotate");
  }
  spendToday() {
    return this.request<AgentSpend[]>("GET", "/spend/today");
  }
  dailyUsage(days = 14) {
    return this.request<DailyUsage[]>("GET", `/usage/daily?days=${days}`);
  }
  // Automations (recurring schedules)
  automations() {
    return this.request<Automation[]>("GET", "/automations");
  }
  automation(id: string) {
    return this.request<Automation>("GET", `/automations/${encodeURIComponent(id)}`);
  }
  createAutomation(input: AutomationInput) {
    return this.request<Automation>("POST", "/automations", input);
  }
  updateAutomation(id: string, input: Partial<AutomationInput>) {
    return this.request<Automation>("PATCH", `/automations/${encodeURIComponent(id)}`, input);
  }
  deleteAutomation(id: string) {
    return this.request<{ ok: true }>("DELETE", `/automations/${encodeURIComponent(id)}`);
  }
  /** Run once now, outside the schedule. */
  runAutomation(id: string) {
    return this.request<Automation>("POST", `/automations/${encodeURIComponent(id)}/run`);
  }
  /** The next fire times of a cron expression (or a phrase like "weekdays at 9:00") in a time zone. */
  previewAutomation(cron: string, timezone?: string, count = 5) {
    const params = new URLSearchParams({ cron, count: String(count) });
    if (timezone) params.set("tz", timezone);
    return this.request<AutomationPreview>("GET", `/automations/preview?${params}`);
  }

  /** Open the live event stream. Reconnects automatically until `close()`. */
  connect(): SoloStream {
    if (!this.#WebSocket) throw new Error("No WebSocket implementation available");
    const origin = (globalThis as { location?: { origin: string } }).location?.origin ?? "";
    const base = this.baseUrl || origin;
    const url = new URL(`${base}/api/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.token) url.searchParams.set("token", this.token);
    return new SoloStream(url.toString(), this.#WebSocket);
  }
}

/** A reconnecting WebSocket that remembers its subscriptions. */
export class SoloStream {
  #url: string;
  #WebSocket: typeof WebSocket;
  #socket: WebSocket | undefined;
  #listeners = new Set<Listener>();
  #statusListeners = new Set<(connected: boolean) => void>();
  #endedListeners = new Set<() => void>();
  #threads = new Set<string>();
  #tasks = false;
  #closed = false;
  #retry = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;
  connected = false;

  constructor(url: string, WebSocketImpl: typeof WebSocket) {
    this.#url = url;
    this.#WebSocket = WebSocketImpl;
    this.#open();
  }

  #open() {
    if (this.#closed) return;
    const socket = new this.#WebSocket(this.#url);
    this.#socket = socket;
    socket.onopen = () => {
      this.#retry = 0;
      this.#setConnected(true);
      for (const threadId of this.#threads) this.#send({ type: "subscribe", threadId });
      if (this.#tasks) this.#send({ type: "tasks.subscribe" });
      this.#ping = setInterval(() => this.#send({ type: "ping" }), 25_000);
    };
    socket.onmessage = (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        return;
      }
      for (const listener of this.#listeners) listener(event);
    };
    socket.onclose = (event) => {
      if (this.#ping) clearInterval(this.#ping);
      this.#setConnected(false);
      if (this.#closed) return;
      // 4401: the server ended this credential's access. Retrying with it can't work.
      if (event.code === 4401) {
        this.#closed = true;
        for (const listener of this.#endedListeners) listener();
        return;
      }
      const delay = Math.min(10_000, 500 * 2 ** this.#retry++);
      this.#timer = setTimeout(() => this.#open(), delay);
    };
    socket.onerror = () => socket.close();
  }

  #setConnected(connected: boolean) {
    this.connected = connected;
    for (const listener of this.#statusListeners) listener(connected);
  }

  #send(event: ClientEvent) {
    if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(event));
  }

  on(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The server closed the socket because the session or token stopped working (user removed, token rotated). */
  onSessionEnded(listener: () => void): () => void {
    this.#endedListeners.add(listener);
    return () => this.#endedListeners.delete(listener);
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** Receive `thread.snapshot`, `thread.messages`, and `thread.live` for one thread. */
  subscribe(threadId: string): () => void {
    this.#threads.add(threadId);
    this.#send({ type: "subscribe", threadId });
    return () => {
      this.#threads.delete(threadId);
      this.#send({ type: "unsubscribe", threadId });
    };
  }

  subscribeTasks(): () => void {
    this.#tasks = true;
    this.#send({ type: "tasks.subscribe" });
    return () => {
      this.#tasks = false;
      this.#send({ type: "tasks.unsubscribe" });
    };
  }

  close() {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#ping) clearInterval(this.#ping);
    this.#socket?.close();
  }
}
