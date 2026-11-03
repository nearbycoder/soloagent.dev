import type { Agent, AgentInput, AgentSkill } from "@soloagent/client";
import { AGENT_SKILLS } from "@soloagent/client";
import { type Db, newId } from "./db.ts";
import { defaultApprovalPolicy, isApprovalPolicy } from "./approvals.ts";

const PALETTE = ["#8b5cf6", "#06b6d4", "#f59e0b", "#10b981", "#ef4444", "#ec4899", "#3b82f6", "#84cc16"];
const AVATARS = ["✦", "◆", "●", "▲", "✸", "◉", "⬢", "✺"];
const SKILL_IDS = new Set<string>(AGENT_SKILLS.map((s) => s.id));

export const DEFAULT_INSTRUCTIONS = `You are a sharp, warm, and concise assistant. Answer directly, use short paragraphs and lists when they help, and ask a clarifying question only when you truly cannot proceed.`;

type Row = { id: string; handle: string; data: string; created_at: number; updated_at: number };

export function toHandle(name: string): string {
  const handle = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return handle || "agent";
}

export class AgentStore {
  #db: Db;
  #onChange: (agent: Agent, deleted?: boolean) => void;

  constructor(db: Db, onChange: (agent: Agent, deleted?: boolean) => void) {
    this.#db = db;
    this.#onChange = onChange;
  }

  list(): Agent[] {
    return this.#db.all<Row>("SELECT * FROM agents ORDER BY created_at").map(fromRow);
  }

  get(idOrHandle: string): Agent | undefined {
    const row = this.#db.get<Row>("SELECT * FROM agents WHERE id = ? OR handle = ?", idOrHandle, idOrHandle.toLowerCase());
    return row ? fromRow(row) : undefined;
  }

  default(): Agent | undefined {
    const agents = this.list();
    return agents.find((a) => a.isDefault) ?? agents[0];
  }

  /** Version stamp threads compare against to know when to reconfigure their conversation. */
  version(agent: Agent): number {
    return agent.updatedAt;
  }

  create(input: AgentInput): Agent {
    const now = Date.now();
    const count = this.list().length;
    const handle = this.#uniqueHandle(input.handle ? toHandle(input.handle) : toHandle(input.name));
    const skills = cleanSkills(input.skills ?? ["memory", "web", "delegate", "schedule"]);
    const agent: Agent = {
      id: newId("agt"),
      handle,
      name: input.name.trim() || "Agent",
      avatar: input.avatar || AVATARS[count % AVATARS.length]!,
      color: input.color || PALETTE[count % PALETTE.length]!,
      description: input.description ?? "",
      instructions: input.instructions ?? DEFAULT_INSTRUCTIONS,
      model: input.model ?? null,
      thinkingLevel: input.thinkingLevel ?? "medium",
      skills,
      maxTurns: clampTurns(input.maxTurns ?? 40),
      isDefault: input.isDefault ?? count === 0,
      approvals: isApprovalPolicy(input.approvals) ? input.approvals : defaultApprovalPolicy(skills),
      createdAt: now,
      updatedAt: now,
    };
    if (agent.isDefault) this.#clearDefault();
    this.#write(agent);
    this.#onChange(agent);
    return agent;
  }

  update(id: string, input: Partial<AgentInput>): Agent {
    const current = this.get(id);
    if (!current) throw new Error("Agent not found");
    const skills = input.skills ? cleanSkills(input.skills) : current.skills;
    // Granting the workspace skill turns approvals on unless the same change says otherwise.
    const gainedWorkspace = skills.includes("workspace") && !current.skills.includes("workspace");
    const next: Agent = {
      ...current,
      ...stripUndefined(input),
      handle: input.handle !== undefined ? this.#uniqueHandle(toHandle(input.handle), current.id) : current.handle,
      skills,
      approvals: isApprovalPolicy(input.approvals)
        ? input.approvals
        : gainedWorkspace && current.approvals === "off"
          ? "risky"
          : current.approvals,
      maxTurns: input.maxTurns !== undefined ? clampTurns(input.maxTurns) : current.maxTurns,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    if (next.isDefault && !current.isDefault) this.#clearDefault();
    this.#write(next);
    this.#onChange(next);
    return next;
  }

  delete(id: string) {
    const agent = this.get(id);
    if (!agent) return;
    this.#db.run("DELETE FROM agents WHERE id = ?", agent.id);
    if (agent.isDefault) {
      const next = this.list()[0];
      if (next) this.update(next.id, { isDefault: true });
    }
    this.#onChange(agent, true);
  }

  #clearDefault() {
    for (const agent of this.list()) {
      if (agent.isDefault) this.#write({ ...agent, isDefault: false, updatedAt: Math.max(Date.now(), agent.updatedAt + 1) });
    }
  }

  #uniqueHandle(base: string, selfId?: string): string {
    let handle = base;
    for (let i = 2; ; i++) {
      const row = this.#db.get<{ id: string }>("SELECT id FROM agents WHERE handle = ?", handle);
      if (!row || row.id === selfId) return handle;
      handle = `${base}-${i}`;
    }
  }

  #write(agent: Agent) {
    const { id, handle, createdAt, updatedAt, ...data } = agent;
    this.#db.run(
      `INSERT INTO agents (id, handle, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET handle = excluded.handle, data = excluded.data, updated_at = excluded.updated_at`,
      id,
      handle,
      JSON.stringify(data),
      createdAt,
      updatedAt,
    );
  }
}

function fromRow(row: Row): Agent {
  const data = JSON.parse(row.data) as Omit<Agent, "id" | "handle" | "createdAt" | "updatedAt">;
  return {
    ...data,
    // Rows from before approvals existed: on for agents with the workspace skill.
    approvals: isApprovalPolicy(data.approvals) ? data.approvals : defaultApprovalPolicy(data.skills ?? []),
    id: row.id,
    handle: row.handle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanSkills(skills: readonly string[]): AgentSkill[] {
  return [...new Set(skills.filter((s) => SKILL_IDS.has(s)))] as AgentSkill[];
}

function clampTurns(turns: number): number {
  return Math.max(1, Math.min(500, Math.round(turns)));
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
