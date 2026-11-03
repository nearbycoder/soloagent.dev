import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

/**
 * soloagent's own metadata: agents, connectors, threads, encrypted credentials, memories, activity.
 * Conversations, runs, and tasks live in Pi Durable's storage next to it.
 */
/**
 * Named migrations, applied once each in array order. Add new ones at the end with a unique,
 * descriptive id ("004_users", "005_approvals"…); ids never change once released.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_init",
    sql: `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
  },
  {
    // MCP servers whose tools agents can use. `secrets` holds the sealed env values and headers.
    id: "030_mcp",
    sql: `CREATE TABLE mcp_servers (
     id TEXT PRIMARY KEY, data TEXT NOT NULL, secrets TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  },
];

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
  }

  #migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS _schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    // Installs from 0.1.x tracked a single numbered migration; version 1 is "001_init".
    const legacy = this.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations'").get();
    if (legacy) {
      const hasV1 = this.sql.prepare("SELECT 1 FROM _migrations WHERE version = 1").get();
      if (hasV1) this.sql.prepare("INSERT OR IGNORE INTO _schema_migrations (id, applied_at) VALUES ('001_init', ?)").run(Date.now());
    }
    const applied = new Set((this.sql.prepare("SELECT id FROM _schema_migrations").all() as { id: string }[]).map((r) => r.id));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      this.sql.exec("BEGIN");
      try {
        this.sql.exec(migration.sql);
        this.sql.prepare("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, Date.now());
        this.sql.exec("COMMIT");
      } catch (error) {
        this.sql.exec("ROLLBACK");
        throw new Error(`Migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`);
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
