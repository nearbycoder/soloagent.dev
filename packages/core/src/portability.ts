import type { Agent, AgentExport, AgentImportItem, AgentImportMode, AgentImportResult, AgentInput, ExportedAgent } from "@soloagent/client";
import { toHandle, type AgentStore } from "./agents.ts";

/** What export/import needs from the runtime. */
export type AgentHost = {
  agents: AgentStore;
  createAgent(input: AgentInput): Agent;
  updateAgent(id: string, input: Partial<AgentInput>): Agent;
};

/** Server-local or server-managed fields an import never writes. */
const LOCAL_FIELDS = new Set(["id", "handle", "createdAt", "updatedAt", "isDefault"]);

/**
 * Every agent's full stored data, whatever fields this version has, minus the server-local id.
 * Agents are matched by handle on import.
 */
export function exportAgents(host: AgentHost, version: string): AgentExport {
  return {
    version,
    exportedAt: Date.now(),
    agents: host.agents.list().map(({ id: _id, ...agent }) => agent as ExportedAgent),
  };
}

/**
 * Import agents, matched by handle. New handles are created; existing ones are updated with the
 * imported fields ("merge": fields the file leaves out are kept) or left alone ("skip-existing").
 * Import never changes which agent is the default.
 */
export function importAgents(host: AgentHost, input: { agents?: unknown; mode?: unknown }, options: { dryRun?: boolean } = {}): AgentImportResult {
  const mode: AgentImportMode = input.mode === "skip-existing" ? "skip-existing" : "merge";
  if (input.mode !== undefined && input.mode !== "merge" && input.mode !== "skip-existing") throw new ImportError('mode must be "merge" or "skip-existing"');
  if (!Array.isArray(input.agents)) throw new ImportError("agents must be an array (the file from Export, or its agents list)");

  // One entry per handle; the last one wins.
  const incoming = new Map<string, Record<string, unknown>>();
  input.agents.forEach((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ImportError(`agents[${i}] is not an object`);
    const agent = raw as Record<string, unknown>;
    const handleSource = typeof agent.handle === "string" && agent.handle.trim() ? agent.handle : typeof agent.name === "string" ? agent.name : "";
    if (!handleSource.trim()) throw new ImportError(`agents[${i}] needs a handle or a name`);
    incoming.set(toHandle(handleSource), agent);
  });

  const items: AgentImportItem[] = [];
  const written: Agent[] = [];
  for (const [handle, agent] of incoming) {
    const data = Object.fromEntries(Object.entries(agent).filter(([key, value]) => !LOCAL_FIELDS.has(key) && value !== undefined));
    const name = typeof data.name === "string" && data.name.trim() ? data.name : handle;
    const existing = host.agents.list().find((a) => a.handle === handle);
    if (!existing) {
      items.push({ handle, name, action: "create", fields: [] });
      if (options.dryRun) continue;
      // create() fills in the known fields; update() carries everything else this version stores.
      const created = host.createAgent({ ...(data as Partial<AgentInput>), name, handle, isDefault: false });
      written.push(Object.keys(data).length ? host.updateAgent(created.id, data as Partial<AgentInput>) : created);
      continue;
    }
    if (mode === "skip-existing") {
      items.push({ handle, name: existing.name, action: "skip", fields: [] });
      continue;
    }
    const current = existing as unknown as Record<string, unknown>;
    const fields = Object.keys(data).filter((key) => JSON.stringify(data[key]) !== JSON.stringify(current[key]));
    items.push({ handle, name: existing.name, action: fields.length ? "update" : "unchanged", fields });
    if (options.dryRun || fields.length === 0) continue;
    written.push(host.updateAgent(existing.id, Object.fromEntries(fields.map((key) => [key, data[key]])) as Partial<AgentInput>));
  }
  return { items, agents: written, dryRun: Boolean(options.dryRun) };
}

export class ImportError extends Error {
  readonly status = 400;
}
