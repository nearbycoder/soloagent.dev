import { readFileSync } from "node:fs";
import type { AgentImportMode } from "@soloagent/client";
import { UsageError } from "../args.ts";
import type { Connection } from "../connect.ts";
import { err, out, paint, table } from "../style.ts";

/** `soloagent agents export > agents.json` */
export async function exportAgents(connection: Connection) {
  const data = await connection.client.exportAgents();
  out(JSON.stringify(data, null, 2));
  if (process.stdout.isTTY) return;
  err(paint(process.stderr).dim(`exported ${data.agents.length === 1 ? "1 agent" : `${data.agents.length} agents`}`));
}

/** `soloagent agents import agents.json [--mode merge|skip-existing] [--dry-run]` ("-" reads stdin) */
export async function importAgents(connection: Connection, file: string | undefined, options: { mode?: string; dryRun?: boolean }): Promise<number> {
  if (!file) throw new UsageError("Usage: soloagent agents import <agents.json> [--mode merge|skip-existing] [--dry-run]");
  if (options.mode && options.mode !== "merge" && options.mode !== "skip-existing") throw new UsageError('--mode must be "merge" or "skip-existing"');
  let text: string;
  try {
    text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`Could not read ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`${file} is not valid JSON`);
  }
  // The file from `agents export`, or a bare array of agents.
  const agents = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) throw new UsageError(`${file} has no agents list`);

  const result = await connection.client.importAgents({ agents, mode: (options.mode as AgentImportMode | undefined) ?? "merge" }, { dryRun: options.dryRun });
  const p = paint();
  const label = { create: p.green("create"), update: p.yellow("update"), skip: p.dim("skip"), unchanged: p.dim("unchanged") };
  out(table(result.items.map((i) => [label[i.action], `@${i.handle}`, i.fields.join(", ") || p.dim("—")]), ["ACTION", "AGENT", "CHANGES"], p));
  const count = (action: string) => result.items.filter((i) => i.action === action).length;
  const summary = `${count("create")} created, ${count("update")} updated, ${count("skip")} skipped, ${count("unchanged")} unchanged`;
  err(result.dryRun ? p.dim(`dry run: ${summary.replace(/created/, "to create").replace(/updated/, "to update")}; nothing was written`) : `${p.green("✓")} ${summary}`);
  return 0;
}
