import type { Memory } from "@soloagent/client";
import type { Db } from "./db.ts";

type Row = { id: number; agent_id: string; text: string; created_at: number };

const MAX_TEXT = 4_000;

/** An agent's long-term memories, as the memory editor sees them. The memory skill's tools write the same table. */
export class MemoryStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Newest first. `q` keeps memories containing every word of it, case-insensitively. */
  list(agentId: string, options: { q?: string; limit?: number } = {}): Memory[] {
    const words = (options.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const where = words.map(() => " AND LOWER(text) LIKE ? ESCAPE '\\'").join("");
    const limit = Math.max(1, Math.min(1000, options.limit ?? 500));
    return this.#db
      .all<Row>(`SELECT * FROM memories WHERE agent_id = ?${where} ORDER BY id DESC LIMIT ?`, agentId, ...words.map((w) => `%${escapeLike(w)}%`), limit)
      .map(toMemory);
  }

  get(agentId: string, id: number): Memory | undefined {
    const row = this.#db.get<Row>("SELECT * FROM memories WHERE agent_id = ? AND id = ?", agentId, id);
    return row ? toMemory(row) : undefined;
  }

  count(agentId: string): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memories WHERE agent_id = ?", agentId)?.n ?? 0;
  }

  /** Memory count per agent id; agents without memories are left out. */
  counts(): Record<string, number> {
    const rows = this.#db.all<{ agent_id: string; n: number }>("SELECT agent_id, COUNT(*) AS n FROM memories GROUP BY agent_id");
    return Object.fromEntries(rows.map((r) => [r.agent_id, r.n]));
  }

  add(agentId: string, text: string): Memory {
    const clean = cleanText(text);
    const id = Number(this.#db.run("INSERT INTO memories (agent_id, text, created_at) VALUES (?, ?, ?)", agentId, clean, Date.now()).lastInsertRowid);
    return this.get(agentId, id)!;
  }

  update(agentId: string, id: number, text: string): Memory {
    const clean = cleanText(text);
    if (this.#db.run("UPDATE memories SET text = ? WHERE agent_id = ? AND id = ?", clean, agentId, id).changes === 0) throw new Error("Memory not found");
    return this.get(agentId, id)!;
  }

  delete(agentId: string, id: number): boolean {
    return this.#db.run("DELETE FROM memories WHERE agent_id = ? AND id = ?", agentId, id).changes > 0;
  }

  /** Delete every memory of an agent. Returns how many were deleted. */
  clear(agentId: string): number {
    return Number(this.#db.run("DELETE FROM memories WHERE agent_id = ?", agentId).changes);
  }
}

function toMemory(row: Row): Memory {
  return { id: row.id, agentId: row.agent_id, text: row.text, createdAt: row.created_at };
}

function cleanText(text: unknown): string {
  const clean = typeof text === "string" ? text.trim() : "";
  if (!clean) throw new Error("text is required");
  if (clean.length > MAX_TEXT) throw new Error(`A memory can be at most ${MAX_TEXT} characters`);
  return clean;
}

function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, (c) => `\\${c}`);
}
