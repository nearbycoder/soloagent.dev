import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { AgentBudget, AgentSpend, ConnectorAccess, ConnectorLimits, DailyUsage, Invite, Role, Usage, User } from "@soloagent/client";
import { type Db, newId } from "./db.ts";

/**
 * Teams: dashboard users and their sessions, invite links, and the spend ledger that budgets and
 * rate limits read. The admin token stays the superuser; users are for people.
 */

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export const MIN_PASSWORD = 8;

type UserRow = { id: string; name: string; name_key: string; role: Role; password: string | null; created_at: number; last_seen_at: number | null };
type InviteRow = {
  id: string;
  code_hash: string;
  role: Role;
  name: string | null;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
};

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password.normalize("NFKC"), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

/** `scrypt$N$r$p$salt$hash`, base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const nameKey = (name: string) => name.trim().toLowerCase();

export function cleanName(name: string | undefined): string {
  const clean = (name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!clean) throw new TeamError(400, "A name is required");
  return clean;
}

function cleanRole(role: unknown): Role {
  if (role !== "admin" && role !== "member") throw new TeamError(400, "role must be admin or member");
  return role;
}

export class TeamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class TeamStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // ── users ──

  users(): User[] {
    return this.#db.all<UserRow>("SELECT * FROM users ORDER BY created_at").map(toUser);
  }

  user(id: string): User | undefined {
    const row = this.#db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    return row ? toUser(row) : undefined;
  }

  async createUser(input: { name: string; role: Role; password?: string }): Promise<User> {
    const name = cleanName(input.name);
    const role = cleanRole(input.role);
    if (this.#db.get("SELECT 1 FROM users WHERE name_key = ?", nameKey(name))) throw new TeamError(409, `Someone is already called ${name}. Pick another name.`);
    if (input.password !== undefined && input.password.length < MIN_PASSWORD) throw new TeamError(400, `Use a password of at least ${MIN_PASSWORD} characters`);
    const password = input.password !== undefined ? await hashPassword(input.password) : null;
    const id = newId("usr");
    this.#db.run("INSERT INTO users (id, name, name_key, role, password, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, name, nameKey(name), role, password, Date.now());
    return this.user(id)!;
  }

  updateUser(id: string, input: { role?: Role; name?: string }): User {
    const user = this.user(id);
    if (!user) throw new TeamError(404, "User not found");
    if (input.role !== undefined) this.#db.run("UPDATE users SET role = ? WHERE id = ?", cleanRole(input.role), id);
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      const taken = this.#db.get<{ id: string }>("SELECT id FROM users WHERE name_key = ?", nameKey(name));
      if (taken && taken.id !== id) throw new TeamError(409, `Someone is already called ${name}`);
      this.#db.run("UPDATE users SET name = ?, name_key = ? WHERE id = ?", name, nameKey(name), id);
    }
    return this.user(id)!;
  }

  deleteUser(id: string) {
    this.#db.run("DELETE FROM users WHERE id = ?", id); // sessions cascade
  }

  /** The user for a name and password, or undefined. Always does the hashing work, so timing says nothing. */
  async checkPassword(name: string, password: string): Promise<User | undefined> {
    const row = this.#db.get<UserRow>("SELECT * FROM users WHERE name_key = ?", nameKey(name));
    const ok = await verifyPassword(password, row?.password ?? DUMMY_HASH);
    return row?.password && ok ? toUser(row) : undefined;
  }

  // ── sessions ──

  /** A new session token for the cookie. Only its hash is stored. */
  createSession(userId: string): { token: string; expiresAt: number } {
    const token = `sas_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    const expiresAt = now + SESSION_TTL;
    this.#db.run("DELETE FROM sessions WHERE expires_at < ?", now);
    this.#db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", sha256(token), userId, now, expiresAt);
    return { token, expiresAt };
  }

  sessionUser(token: string | undefined): User | undefined {
    if (!token?.startsWith("sas_")) return undefined;
    const row = this.#db.get<UserRow & { expires_at: number }>(
      "SELECT users.*, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?",
      sha256(token),
    );
    if (!row || row.expires_at < Date.now()) return undefined;
    // Touch at most once a minute.
    const now = Date.now();
    if (!row.last_seen_at || now - row.last_seen_at > 60_000) this.#db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", now, row.id);
    return toUser(row);
  }

  deleteSession(token: string | undefined) {
    if (token?.startsWith("sas_")) this.#db.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  }

  // ── invites ──

  invites(): Invite[] {
    return this.#db.all<InviteRow>("SELECT * FROM invites ORDER BY created_at DESC LIMIT 200").map(toInvite);
  }

  createInvite(input: { role: Role; name?: string | null; createdBy: string }): { invite: Invite; code: string } {
    const role = cleanRole(input.role);
    const name = input.name?.trim() ? cleanName(input.name) : null;
    const code = randomBytes(18).toString("base64url");
    const id = newId("inv");
    const now = Date.now();
    this.#db.run(
      "INSERT INTO invites (id, code_hash, role, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      sha256(code),
      role,
      name,
      input.createdBy,
      now,
      now + INVITE_TTL,
    );
    return { invite: toInvite(this.#db.get<InviteRow>("SELECT * FROM invites WHERE id = ?", id)!), code };
  }

  revokeInvite(id: string) {
    this.#db.run("DELETE FROM invites WHERE id = ?", id);
  }

  /** An invite that can still be accepted. */
  openInvite(code: string): Invite | undefined {
    const row = this.#db.get<InviteRow>("SELECT * FROM invites WHERE code_hash = ?", sha256(code));
    if (!row || row.used_at !== null || row.expires_at < Date.now()) return undefined;
    return toInvite(row);
  }

  async acceptInvite(code: string, input: { name: string; password: string }): Promise<User> {
    const invite = this.openInvite(code);
    if (!invite) throw new TeamError(410, "This invite link has expired or was already used. Ask an admin for a new one.");
    const user = await this.createUser({ name: input.name, role: invite.role, password: input.password ?? "" });
    // Claim it atomically so a link works exactly once, even with two tabs racing.
    const claimed = this.#db.run("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL", Date.now(), user.id, invite.id);
    if (claimed.changes === 0) {
      this.deleteUser(user.id);
      throw new TeamError(410, "This invite link was already used");
    }
    return user;
  }
}

const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, role: row.role, hasPassword: !!row.password, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
}

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    usedBy: row.used_by,
  };
}

// ───────────────────────────── access lists ─────────────────────────────

export const NO_ACCESS_RULES: ConnectorAccess = { users: [], channels: [], agents: [] };
export const NO_LIMITS: ConnectorLimits = { perUserPerHour: null };
export const NO_BUDGET: AgentBudget = { dailyUsd: null, dailyRuns: null };

function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list) {
    const value = typeof item === "string" ? item.trim() : "";
    if (value) out.add(value.slice(0, 120));
  }
  return [...out].slice(0, 500);
}

export function cleanAccess(input: Partial<ConnectorAccess> | undefined, current: ConnectorAccess = NO_ACCESS_RULES): ConnectorAccess {
  return {
    users: input?.users !== undefined ? cleanList(input.users) : current.users,
    channels: input?.channels !== undefined ? cleanList(input.channels) : current.channels,
    agents: input?.agents !== undefined ? cleanList(input.agents).map((a) => a.replace(/^@/, "")) : current.agents,
  };
}

/** A positive number, or null for "no limit". */
function limitValue(value: unknown, integer: boolean): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return integer ? Math.round(n) : Math.round(n * 10_000) / 10_000;
}

export function cleanLimits(input: Partial<ConnectorLimits> | undefined, current: ConnectorLimits = NO_LIMITS): ConnectorLimits {
  return { perUserPerHour: input && "perUserPerHour" in input ? limitValue(input.perUserPerHour, true) : current.perUserPerHour };
}

export function cleanBudget(input: Partial<AgentBudget> | undefined, current: AgentBudget = NO_BUDGET): AgentBudget {
  return {
    dailyUsd: input && "dailyUsd" in input ? limitValue(input.dailyUsd, false) : current.dailyUsd,
    dailyRuns: input && "dailyRuns" in input ? limitValue(input.dailyRuns, true) : current.dailyRuns,
  };
}

const norm = (value: string) => value.trim().toLowerCase().replace(/^[@#]/, "");

/** Does a list allow any of these identities? An empty list allows everyone. */
export function listAllows(list: readonly string[], ...identities: (string | undefined | null)[]): boolean {
  if (list.length === 0) return true;
  const wanted = new Set(list.map(norm));
  return identities.some((id) => !!id && wanted.has(norm(id)));
}

// ───────────────────────────── ledger ─────────────────────────────

export function startOfUtcDay(at = Date.now()): number {
  const day = new Date(at);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime();
}

export type SpendRecord = {
  key: string;
  agentId: string | null;
  connectorId: string | null;
  threadId: string | null;
  conversationId: number;
  provider: string;
  model: string;
  usage: Usage;
  at: number;
};

/** Recorded spend per provider response, and admitted messages, for budgets, rate limits, and daily usage. */
export class Ledger {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Idempotent by key: a response replayed after a crash is counted once. */
  recordSpend(record: SpendRecord) {
    const u = record.usage;
    this.#db.run(
      `INSERT OR IGNORE INTO spend (at, response_key, agent_id, connector_id, thread_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.at,
      record.key,
      record.agentId,
      record.connectorId,
      record.threadId,
      record.conversationId,
      record.provider,
      record.model,
      u.input,
      u.output,
      u.cacheRead,
      u.cacheWrite,
      u.cost,
    );
  }

  recordAdmission(input: { agentId: string; connectorId: string | null; userKey: string | null; threadId: string | null; at?: number }) {
    this.#db.run(
      "INSERT INTO admissions (at, agent_id, connector_id, user_key, thread_id) VALUES (?, ?, ?, ?, ?)",
      input.at ?? Date.now(),
      input.agentId,
      input.connectorId,
      input.userKey,
      input.threadId,
    );
  }

  spentToday(agentId: string, now = Date.now()): number {
    return this.#db.get<{ usd: number | null }>("SELECT SUM(cost) AS usd FROM spend WHERE agent_id = ? AND at >= ?", agentId, startOfUtcDay(now))?.usd ?? 0;
  }

  runsToday(agentId: string, now = Date.now()): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM admissions WHERE agent_id = ? AND at >= ?", agentId, startOfUtcDay(now))?.n ?? 0;
  }

  userMessagesLastHour(connectorId: string, userKey: string, now = Date.now()): number {
    return (
      this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM admissions WHERE connector_id = ? AND user_key = ? AND at >= ?", connectorId, userKey, now - 3_600_000)?.n ?? 0
    );
  }

  today(budgets: { agentId: string; budget: AgentBudget }[], now = Date.now()): AgentSpend[] {
    const since = startOfUtcDay(now);
    const spend = new Map(this.#db.all<{ agent_id: string; usd: number }>("SELECT agent_id, SUM(cost) AS usd FROM spend WHERE at >= ? GROUP BY agent_id", since).map((r) => [r.agent_id, r.usd]));
    const runs = new Map(this.#db.all<{ agent_id: string; n: number }>("SELECT agent_id, COUNT(*) AS n FROM admissions WHERE at >= ? GROUP BY agent_id", since).map((r) => [r.agent_id, r.n]));
    return budgets.map(({ agentId, budget }) => ({ agentId, usd: spend.get(agentId) ?? 0, runs: runs.get(agentId) ?? 0, budget }));
  }

  /** The last `days` UTC days, oldest first, including days without spend. */
  daily(days: number, now = Date.now()): DailyUsage[] {
    const count = Math.max(1, Math.min(90, Math.round(days)));
    const first = startOfUtcDay(now) - (count - 1) * 86_400_000;
    const rows = this.#db.all<{ day: number; agent_id: string | null; input: number; output: number; cache_read: number; cache_write: number; cost: number; n: number }>(
      `SELECT (at - ?) / 86400000 AS day, agent_id, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
              SUM(cache_write) AS cache_write, SUM(cost) AS cost, COUNT(*) AS n
       FROM spend WHERE at >= ? GROUP BY day, agent_id`,
      first,
      first,
    );
    const out: DailyUsage[] = Array.from({ length: count }, (_, i) => ({
      day: new Date(first + i * 86_400_000).toISOString().slice(0, 10),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      responses: 0,
      byAgent: [],
    }));
    for (const row of rows) {
      const bucket = out[Math.floor(row.day)];
      if (!bucket) continue;
      bucket.usage.input += row.input;
      bucket.usage.output += row.output;
      bucket.usage.cacheRead += row.cache_read;
      bucket.usage.cacheWrite += row.cache_write;
      bucket.usage.cost += row.cost;
      bucket.responses += row.n;
      if (row.agent_id) bucket.byAgent.push({ agentId: row.agent_id, cost: row.cost });
    }
    return out;
  }
}
