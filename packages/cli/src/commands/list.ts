import type { Connection } from "../connect.ts";
import { out, paint, table } from "../style.ts";
import { clip, oneLine, relTime, SOURCE_LABEL, sourceIcon } from "../tui/format.ts";

export async function agents(connection: Connection, options: { json?: boolean }) {
  const list = await connection.client.agents();
  if (options.json) return out(JSON.stringify(list, null, 2));
  const p = paint();
  if (list.length === 0) return out(p.dim("No agents yet."));
  const rows = list.map((a) => [
    `${p.hex(a.color)(a.avatar)} ${p.bold(`@${a.handle}`)}${a.isDefault ? p.accent(" ★") : ""}`,
    a.name,
    a.model ? `${a.model.provider}/${a.model.modelId}` : p.yellow("no model"),
    a.skills.join(", ") || p.dim("—"),
    clip(oneLine(a.description), 48),
  ]);
  out(table(rows, ["AGENT", "NAME", "MODEL", "SKILLS", "DESCRIPTION"], p));
}

export async function threads(connection: Connection, options: { json?: boolean; limit?: string; agent?: string }) {
  const { client } = connection;
  const limit = options.limit ? Number(options.limit) : 20;
  const [list, agentList] = await Promise.all([client.threads({ limit }), client.agents()]);
  const filtered = options.agent ? list.filter((t) => agentList.find((a) => a.id === t.agentId)?.handle === options.agent!.replace(/^@/, "")) : list;
  if (options.json) return out(JSON.stringify(filtered, null, 2));
  const p = paint();
  if (filtered.length === 0) return out(p.dim("No threads yet. Start one with soloagent or soloagent ask."));
  const rows = filtered.map((t) => {
    const agent = agentList.find((a) => a.id === t.agentId);
    return [
      p.dim(t.id),
      agent ? `${p.hex(agent.color)(agent.avatar)} @${agent.handle}` : p.dim("?"),
      `${sourceIcon(t.source)} ${SOURCE_LABEL[t.source]}${t.location ? p.dim(` ${t.location}`) : ""}`,
      String(t.messageCount),
      relTime(t.updatedAt),
      `${t.busy ? `${p.accent("●")} ` : ""}${clip(oneLine(t.title), 50)}`,
    ];
  });
  out(table(rows, ["ID", "AGENT", "SOURCE", "MSGS", "UPDATED", "TITLE"], p));
}
