import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

/**
 * soloagent's own metadata: agents, connectors, threads, encrypted credentials, memories, activity.
 * Conversations, runs, and tasks live in Pi Durable's storage next to it.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE agents (
     id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE connectors (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, secrets TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE threads (
     id TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL, agent_id TEXT NOT NULL,
     source TEXT NOT NULL, connector_id TEXT, external_key TEXT, location TEXT,
     title TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '', message_count INTEGER NOT NULL DEFAULT 0,
     agent_version INTEGER NOT NULL DEFAULT 0, meta TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE UNIQUE INDEX threads_external ON threads(connector_id, external_key, agent_id) WHERE external_key IS NOT NULL;
   CREATE INDEX threads_updated ON threads(updated_at DESC);
   CREATE UNIQUE INDEX threads_conversation ON threads(conversation_id);
   CREATE TABLE credentials (provider_id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE INDEX memories_agent ON memories(agent_id);
   CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL,
     agent_id TEXT, thread_id TEXT, connector_id TEXT);
   CREATE INDEX activity_at ON activity(at DESC);
   CREATE TABLE conversation_agents (conversation_id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL);
   CREATE TABLE schedules (task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, text TEXT NOT NULL,
     at INTEGER NOT NULL, status TEXT NOT NULL);`,
];

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
  }

  #migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY)");
    const row = this.sql.prepare("SELECT MAX(version) AS v FROM _migrations").get() as { v: number | null } | undefined;
    const current = row?.v ?? 0;
    for (let version = current + 1; version <= MIGRATIONS.length; version++) {
      this.sql.exec("BEGIN");
      try {
        this.sql.exec(MIGRATIONS[version - 1]!);
        this.sql.prepare("INSERT INTO _migrations (version) VALUES (?)").run(version);
        this.sql.exec("COMMIT");
      } catch (error) {
        this.sql.exec("ROLLBACK");
        throw error;
      }
    }
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.sql.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.sql.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SqlValue[]) {
    return this.sql.prepare(sql).run(...params);
  }

  setting(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
  }

  setSetting(key: string, value: string) {
    this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  close() {
    this.sql.close();
  }
}

export type SqlValue = string | number | bigint | null | Uint8Array;

/** Short, URL-safe, sortable-enough id: time prefix plus randomness. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const random = randomBytes(6).toString("base64url").replace(/[-_]/g, "x");
  return `${prefix}_${time}${random}`;
}
