import { defineExtension, defineTool, type Extension, type Registry, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import {
  McpAuthRequiredError,
  McpClient,
  McpHttpError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type McpTransport,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import type { McpServer, McpServerInput, McpServerStatus, McpTestResult, McpToolInfo, McpTransportKind } from "@soloagent/client";
import { SECRET_MASK } from "./connectors/manager.ts";
import type { Db } from "./db.ts";
import type { Sealer } from "./secrets.ts";

/** Servers with more tools than this get them deferred, behind `tool_search`. */
export const MCP_DEFER_THRESHOLD = 15;
const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** What a stdio server inherits from soloagent's environment. Everything else (tokens, SOLOAGENT_SECRET) stays out. */
const INHERITED_ENV = /^(PATH|PATHEXT|HOME|USER|USERNAME|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|TZ|TMPDIR|TMP|TEMP|XDG_[A-Z_]+|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|USERPROFILE|HOMEDRIVE|HOMEPATH|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|DOCKER_HOST|DOCKER_CONFIG|DOCKER_CONTEXT|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY|NVM_[A-Z_]+|VOLTA_HOME|PNPM_HOME|BUN_INSTALL|DENO_DIR)$/i;

type Row = { id: string; data: string; secrets: string | null; created_at: number; updated_at: number };
type Data = { name: string; transport: McpTransportKind; command: string; args: string[]; url: string; enabled: boolean; envKeys: string[]; headerKeys: string[] };
type Secrets = { env: Record<string, string>; headers: Record<string, string> };

/** Connection state of one server. `gen` changes on every (re)start, so stale attempts and callbacks stand down. */
type Live = {
  gen: number;
  status: McpServerStatus;
  detail?: string;
  client?: McpClient;
  /** The client of a connection attempt in progress, closed if the server stops meanwhile. */
  pending?: McpClient;
  tools: McpTool[];
  serverInfo?: string;
  connectedAt?: number;
  retries: number;
  /** Counts restarts; the latest one wins. */
  restarts: number;
  restarting?: Promise<McpServer | undefined>;
  timer?: ReturnType<typeof setTimeout>;
  attempt?: Promise<void>;
};

export interface McpEvents {
  changed(server: McpServer, deleted?: boolean): void;
  log(message: string, error?: boolean): void;
}

export function mcpExtensionName(serverId: string): string {
  return `mcp:${serverId}`;
}

/** The name an agent calls an MCP tool by. Providers allow at most 64 characters of [A-Za-z0-9_-]. */
export function mcpToolName(serverId: string, tool: string): string {
  return `mcp__${serverId}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Stores MCP server settings (env values and headers sealed), keeps one client connection per enabled server,
 * and publishes each connected server's tools as the Pi Durable extension `mcp:<id>`. Agents select servers by
 * id; conversations select the extension by name, so tools appear, change, and disappear without reconfiguring.
 */
export class McpManager {
  #db: Db;
  #sealer: Sealer;
  #registry: Registry;
  #events: McpEvents;
  #version: string;
  #live = new Map<string, Live>();
  #closed = false;

  constructor(db: Db, sealer: Sealer, registry: Registry, events: McpEvents, options: { version: string }) {
    this.#db = db;
    this.#sealer = sealer;
    this.#registry = registry;
    this.#events = events;
    this.#version = options.version;
  }

  // ───────────── settings ─────────────

  list(): McpServer[] {
    return this.#db.all<Row>("SELECT * FROM mcp_servers ORDER BY created_at").map((row) => this.#public(row));
  }

  get(id: string): McpServer | undefined {
    const row = this.#row(id);
    return row ? this.#public(row) : undefined;
  }

  create(input: McpServerInput): McpServer {
    const id = (input.id ?? slug(input.name ?? "")).trim().toLowerCase();
    if (!ID_PATTERN.test(id) || id.includes("--")) throw new Error("id must be 1-32 lowercase letters, digits, and single dashes, e.g. \"github\"");
    if (this.#row(id)) throw new Error(`An MCP server with id "${id}" already exists`);
    const transport = input.transport ?? (input.url ? "http" : "stdio");
    const env = cleanMap(input.env ?? {}, {}, "env");
    const headers = cleanMap(input.headers ?? {}, {}, "headers");
    const data: Data = {
      name: input.name?.trim() || id,
      transport,
      command: input.command?.trim() ?? "",
      args: cleanArgs(input.args),
      url: input.url?.trim() ?? "",
      enabled: input.enabled ?? true,
      envKeys: Object.keys(env),
      headerKeys: Object.keys(headers),
    };
    validate(data);
    const now = Date.now();
    this.#db.run(
      "INSERT INTO mcp_servers (id, data, secrets, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      id,
      JSON.stringify(data),
      this.#sealer.seal(JSON.stringify({ env, headers } satisfies Secrets)),
      now,
      now,
    );
    void this.restart(id);
    return this.get(id)!;
  }

  update(id: string, input: McpServerInput): McpServer {
    const row = this.#row(id);
    if (!row) throw new Error("MCP server not found");
    const current = JSON.parse(row.data) as Data;
    const secrets = this.#secrets(row);
    const env = input.env ? cleanMap(input.env, secrets.env, "env") : secrets.env;
    const headers = input.headers ? cleanMap(input.headers, secrets.headers, "headers") : secrets.headers;
    const next: Data = {
      name: input.name?.trim() || current.name,
      transport: input.transport ?? current.transport,
      command: input.command !== undefined ? input.command.trim() : current.command,
      args: input.args !== undefined ? cleanArgs(input.args) : current.args,
      url: input.url !== undefined ? input.url.trim() : current.url,
      enabled: input.enabled ?? current.enabled,
      envKeys: input.env ? Object.keys(env) : current.envKeys,
      headerKeys: input.headers ? Object.keys(headers) : current.headerKeys,
    };
    validate(next);
    this.#db.run(
      "UPDATE mcp_servers SET data = ?, secrets = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(next),
      this.#sealer.seal(JSON.stringify({ env, headers } satisfies Secrets)),
      Math.max(Date.now(), row.updated_at + 1),
      id,
    );
    const connectionChanged =
      input.env !== undefined ||
      input.headers !== undefined ||
      JSON.stringify({ ...current, name: "", envKeys: [], headerKeys: [] }) !== JSON.stringify({ ...next, name: "", envKeys: [], headerKeys: [] });
    if (connectionChanged) void this.restart(id);
    else {
      if (next.name !== current.name && this.#live.get(id)?.client) this.#install(id);
      this.#emit(id);
    }
    return this.get(id)!;
  }

  async delete(id: string) {
    const server = this.get(id);
    if (!server) return;
    await this.#stop(id);
    this.#live.delete(id);
    this.#db.run("DELETE FROM mcp_servers WHERE id = ?", id);
    this.#events.changed(server, true);
  }

  // ───────────── connections ─────────────

  async startAll() {
    await Promise.all(this.list().map((s) => this.restart(s.id).catch(() => {})));
  }

  async stopAll() {
    this.#closed = true;
    const attempts = [...this.#live.values()].map((live) => live.attempt);
    await Promise.all([...this.#live.keys()].map((id) => this.#stop(id)));
    await Promise.all(attempts);
  }

  /** Reconnect now (resetting the backoff), or stop when disabled. Resolves once this attempt settles; never throws. */
  restart(id: string): Promise<McpServer | undefined> {
    if (this.#closed) return Promise.resolve(undefined);
    const live = this.#state(id);
    const run = this.#restart(id, live, ++live.restarts);
    live.restarting = run;
    return run;
  }

  async #restart(id: string, live: Live, token: number): Promise<McpServer | undefined> {
    await this.#stop(id);
    if (this.#closed) return undefined;
    // A later restart took over: settle with its outcome instead of racing it.
    if (live.restarts !== token) return live.restarting;
    const row = this.#row(id);
    if (!row) return undefined;
    live.retries = 0;
    if (!(JSON.parse(row.data) as Data).enabled) {
      this.#setStatus(id, "stopped");
      return this.get(id);
    }
    await this.#attempt(id, ++live.gen);
    return this.#closed ? undefined : this.get(id);
  }

  /** List a server's tools live. Connects first when it is not connected; a disabled server connects once. */
  async test(id: string): Promise<McpTestResult> {
    if (!this.#row(id)) throw new Error("MCP server not found");
    const live = this.#live.get(id);
    if (live?.client && live.status === "connected") {
      try {
        await this.#refreshTools(id, live.gen, true);
        return this.#result(id);
      } catch (error) {
        return { ...this.#result(id), ok: false, error: describeError(error) };
      }
    }
    if (this.get(id)!.enabled) {
      await this.restart(id);
      return this.#result(id);
    }
    const state = this.#state(id);
    state.gen++;
    await this.#attempt(id, state.gen, { once: true });
    const result = this.#result(id);
    await this.#stop(id);
    this.#setStatus(id, "stopped", result.ok ? undefined : result.error);
    return { ...result, server: this.get(id)! };
  }

  /** The extensions an agent's conversations select for its MCP servers. Unknown or offline servers select nothing. */
  extensionsFor(serverIds: readonly string[]): Extension[] {
    return [...new Set(serverIds)]
      .filter((id) => ID_PATTERN.test(id))
      .map((id) => this.#registry.snapshot().extension(mcpExtensionName(id)) ?? defineExtension({ name: mcpExtensionName(id) }));
  }

  #result(id: string): McpTestResult {
    const server = this.get(id)!;
    return server.status === "connected"
      ? { ok: true, tools: server.tools, server }
      : { ok: false, error: server.statusDetail ?? "Not connected", tools: server.tools, server };
  }

  #state(id: string): Live {
    let live = this.#live.get(id);
    if (!live) {
      live = { gen: 0, status: "connecting", tools: [], retries: 0, restarts: 0 };
      this.#live.set(id, live);
    }
    return live;
  }

  async #stop(id: string) {
    const live = this.#live.get(id);
    if (!live) return;
    live.gen++;
    if (live.timer) clearTimeout(live.timer);
    live.timer = undefined;
    const clients = [live.client, live.pending];
    live.client = undefined;
    live.pending = undefined;
    live.connectedAt = undefined;
    this.#registry.uninstall(defineExtension({ name: mcpExtensionName(id) }));
    await Promise.all(clients.map((client) => client?.close().catch(() => {})));
  }

  #attempt(id: string, gen: number, options: { once?: boolean } = {}): Promise<void> {
    const live = this.#state(id);
    const attempt = this.#connect(id, gen, options).catch((error) => {
      // #connect handles its own errors; this is the last line of defense for a bad server.
      if (!this.#closed) {
        try {
          this.#events.log(`MCP ${id}: ${describeError(error)}`, true);
        } catch {
          // never let logging take the process down
        }
      }
    });
    live.attempt = attempt;
    return attempt;
  }

  async #connect(id: string, gen: number, options: { once?: boolean }) {
    const live = this.#state(id);
    if (this.#closed || live.gen !== gen) return;
    const row = this.#row(id);
    if (!row) return;
    const data = JSON.parse(row.data) as Data;
    const secrets = this.#secrets(row);
    this.#setStatus(id, "connecting");
    let stderr = "";
    let client: McpClient | undefined;
    try {
      const transport = this.#transport(data, secrets, (chunk) => {
        stderr = (stderr + chunk).slice(-4_000);
      });
      client = new McpClient({ name: "soloagent", version: this.#version, requestTimeoutMs: CALL_TIMEOUT_MS });
      client.onError(() => {}); // surfaced through the status and the failed request instead
      const connected = client;
      live.pending = connected;
      await withTimeout(connected.connect(transport), CONNECT_TIMEOUT_MS, "The server did not finish starting within 30s");
      const tools = await connected.listTools({ timeoutMs: LIST_TIMEOUT_MS });
      if (live.pending === connected) live.pending = undefined;
      if (live.gen !== gen || this.#closed) {
        await connected.close().catch(() => {});
        return;
      }
      live.client = connected;
      live.tools = tools;
      live.retries = 0;
      live.connectedAt = Date.now();
      live.serverInfo = connected.serverInfo ? `${connected.serverInfo.name}${connected.serverInfo.version ? ` ${connected.serverInfo.version}` : ""}` : undefined;
      connected.onNotification("notifications/tools/list_changed", () => void this.#refreshTools(id, gen).catch(() => {}));
      connected.onClose(() => {
        if (live.gen !== gen || live.client !== connected) return;
        live.client = undefined;
        live.connectedAt = undefined;
        this.#setStatus(id, "error", withStderr("The server disconnected", stderr));
        this.#events.log(`MCP server ${data.name} disconnected`, true);
        if (!options.once) this.#scheduleReconnect(id, gen);
      });
      if (!options.once) this.#install(id);
      this.#setStatus(id, "connected");
      this.#events.log(`MCP server ${data.name} connected (${tools.length} tool${tools.length === 1 ? "" : "s"})`);
      if (connected.connectionState === "closed") throw new Error("The server disconnected");
    } catch (error) {
      if (live.pending === client) live.pending = undefined;
      if (client) await client.close().catch(() => {});
      if (live.gen !== gen || this.#closed) return;
      if (live.client === client) {
        live.client = undefined;
        live.connectedAt = undefined;
      }
      const detail = withStderr(describeError(error), stderr);
      this.#setStatus(id, "error", detail);
      // Log the first failure of a streak, not every retry.
      if (live.retries === 0) this.#events.log(`MCP server ${data.name}: ${detail}`, true);
      if (!options.once) this.#scheduleReconnect(id, gen);
    }
  }

  #scheduleReconnect(id: string, gen: number) {
    const live = this.#state(id);
    if (this.#closed || live.gen !== gen) return;
    if (live.timer) clearTimeout(live.timer);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** live.retries);
    live.retries++;
    live.timer = setTimeout(() => {
      live.timer = undefined;
      if (live.gen !== gen || this.#closed) return;
      live.gen++;
      void this.#attempt(id, live.gen);
    }, delay);
    live.timer.unref?.();
    if (live.detail) live.detail = `${live.detail} · retrying in ${Math.round(delay / 1000)}s`;
    this.#emit(id);
  }

  async #refreshTools(id: string, gen: number, rethrow = false) {
    const live = this.#state(id);
    const client = live.client;
    if (!client || live.gen !== gen) return;
    try {
      const tools = await client.listTools({ timeoutMs: LIST_TIMEOUT_MS });
      if (live.gen !== gen) return;
      const changed = JSON.stringify(tools) !== JSON.stringify(live.tools);
      live.tools = tools;
      if (changed) this.#install(id);
      this.#emit(id);
    } catch (error) {
      if (rethrow) throw error;
    }
  }

  #transport(data: Data, secrets: Secrets, onStderr: (chunk: string) => void): McpTransport {
    if (data.transport === "http") return new StreamableHttpTransport({ url: data.url, headers: secrets.headers });
    const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => INHERITED_ENV.test(e[0]) && e[1] !== undefined));
    return new StdioTransport({ command: data.command, args: data.args, env: { ...inherited, ...secrets.env }, inheritEnv: false, onStderr });
  }

  /** Publish the server's tools as `mcp:<id>`, replacing what was installed. */
  #install(id: string) {
    const live = this.#state(id);
    const data = this.#data(id);
    if (!data) return;
    try {
      this.#registry.install(this.#extension(id, data.name, live.tools));
    } catch (error) {
      this.#events.log(`MCP server ${data.name}: could not register its tools: ${describeError(error)}`, true);
    }
  }

  #extension(id: string, name: string, tools: McpTool[]): Extension {
    const deferred = tools.length > MCP_DEFER_THRESHOLD;
    const registrations: ToolRegistration[] = this.#toolInfos(id, tools).map(({ info, tool }) =>
      defineTool({
        name: info.toolName,
        description: truncate(info.description || info.title || tool.name, 1_000),
        parameters: toParameters(tool.inputSchema),
        // MCP calls can have side effects: an interrupted call is reported, never silently run again.
        replay: "unsafe",
        ...(deferred ? { deferred: true as const } : {}),
        execute: async (args, _api, context) => {
          const live = this.#live.get(id);
          const client = live?.client;
          if (!client) throw new Error(`The MCP server "${name}" is not connected${live?.detail ? ` (${live.detail})` : ""}. Try again later.`);
          const result = await client.callTool(tool.name, (args ?? {}) as Record<string, unknown>, { signal: context.abortSignal, timeoutMs: CALL_TIMEOUT_MS });
          const output = toLlmContent(result);
          return { output: output.length ? output : [{ type: "text", text: "(no output)" }], isError: result.isError === true };
        },
      }) as ToolRegistration,
    );
    if (deferred) registrations.push(createToolSearchTool() as unknown as ToolRegistration);
    return defineExtension({
      name: mcpExtensionName(id),
      tools: registrations,
      sections: deferred
        ? [
            section(
              `mcp-${id}`,
              () =>
                `The MCP server "${name}" has ${tools.length} tools named \`mcp__${id}__*\`. They are not loaded upfront: call \`tool_search\` with keywords for what you need, then call the tools it loads.`,
            ),
          ]
        : [],
    });
  }

  #toolInfos(id: string, tools: McpTool[]): { info: McpToolInfo; tool: McpTool }[] {
    const used = new Set<string>();
    return tools.map((tool) => {
      const base = mcpToolName(id, tool.name);
      let toolName = base;
      for (let i = 2; used.has(toolName); i++) toolName = `${base.slice(0, 64 - String(i).length - 1)}_${i}`;
      used.add(toolName);
      return { tool, info: { name: tool.name, toolName, title: tool.title, description: (tool.description ?? "").trim() } };
    });
  }

  #setStatus(id: string, status: McpServerStatus, detail?: string) {
    const live = this.#state(id);
    live.status = status;
    live.detail = detail;
    this.#emit(id);
  }

  #emit(id: string) {
    if (this.#closed) return;
    const server = this.get(id);
    if (server) this.#events.changed(server);
  }

  #row(id: string): Row | undefined {
    return this.#db.get<Row>("SELECT * FROM mcp_servers WHERE id = ?", id);
  }

  #data(id: string): Data | undefined {
    const row = this.#row(id);
    return row ? (JSON.parse(row.data) as Data) : undefined;
  }

  #secrets(row: Row): Secrets {
    if (!row.secrets) return { env: {}, headers: {} };
    try {
      const parsed = JSON.parse(this.#sealer.open(row.secrets)) as Partial<Secrets>;
      return { env: parsed.env ?? {}, headers: parsed.headers ?? {} };
    } catch {
      return { env: {}, headers: {} };
    }
  }

  #public(row: Row): McpServer {
    const data = JSON.parse(row.data) as Data;
    const live = this.#live.get(row.id);
    const tools = live ? this.#toolInfos(row.id, live.tools).map((t) => t.info) : [];
    const mask = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, SECRET_MASK]));
    let detail = live?.detail;
    const sealed = this.#secrets(row);
    if (row.secrets && data.envKeys.length + data.headerKeys.length > 0 && Object.keys(sealed.env).length + Object.keys(sealed.headers).length === 0) {
      detail = "Saved env values and headers can't be decrypted (SOLOAGENT_SECRET changed?). Enter them again.";
    }
    return {
      id: row.id,
      name: data.name,
      transport: data.transport,
      command: data.command,
      args: data.args,
      env: mask(data.envKeys),
      url: data.url,
      headers: mask(data.headerKeys),
      enabled: data.enabled,
      status: live?.status ?? (data.enabled ? "connecting" : "stopped"),
      ...(detail ? { statusDetail: detail } : {}),
      tools,
      deferred: tools.length > MCP_DEFER_THRESHOLD,
      ...(live?.serverInfo ? { serverInfo: live.serverInfo } : {}),
      ...(live?.connectedAt ? { connectedAt: live.connectedAt } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function validate(data: Data) {
  if (data.transport !== "stdio" && data.transport !== "http") throw new Error('transport must be "stdio" or "http"');
  if (data.transport === "stdio" && !data.command) throw new Error("command is required for a stdio server");
  if (data.transport === "http") {
    let url: URL;
    try {
      url = new URL(data.url);
    } catch {
      throw new Error("url must be a full http(s) URL, e.g. https://mcp.example.com/mcp");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must start with http:// or https://");
  }
}

/** Keys from `input`; a masked value keeps the saved one. */
function cleanMap(input: Record<string, string>, current: Record<string, string>, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (label === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name "${key}"`);
    if (label === "headers" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new Error(`Invalid header name "${key}"`);
    if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
    if (value === SECRET_MASK) {
      if (current[key] !== undefined) out[key] = current[key]!;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function cleanArgs(args: unknown): string[] {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new Error("args must be a list of strings");
  return args as string[];
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** Providers require an object schema, and some reject one without `properties` or with `$schema`. */
function toParameters(schema: McpTool["inputSchema"] | undefined): object {
  const { $schema: _schema, ...rest } = (schema ?? {}) as Record<string, unknown>;
  return { ...rest, type: "object", properties: (rest.properties as object | undefined) ?? {} };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeError(error: unknown): string {
  if (error instanceof McpAuthRequiredError) return `The server requires authorization (HTTP ${error.status}). Add an Authorization header with a token.`;
  if (error instanceof McpHttpError) return `HTTP ${error.status}: ${error.message}`;
  const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  if (error instanceof TypeError && error.message === "fetch failed") return `Could not reach the server (${cause?.code ?? cause?.message ?? "network error"})`;
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "ENOENT") return `Command not found: ${(error as { path?: string }).path ?? "the command"}. Is it installed and on PATH?`;
  if (code === "EACCES") return `Permission denied running ${(error as { path?: string }).path ?? "the command"}`;
  return error instanceof Error ? error.message : String(error);
}

function withStderr(detail: string, stderr: string): string {
  const tail = stderr.trim().split("\n").slice(-3).join(" ").trim();
  return tail ? `${detail} — ${truncate(tail, 400)}` : detail;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
