import type { Automation } from "@soloagent/client";
import type { Connection } from "../connect.ts";
import { out, paint, table } from "../style.ts";
import { clip, relTime } from "../tui/format.ts";

/** "in 5m", "in 3h", or a date, for upcoming times. */
function untilTime(at: number, now = Date.now()): string {
  const m = Math.round((at - now) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return new Date(at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function targetLabel(a: Automation, threads: Map<string, string>): string {
  if (a.target.kind === "thread") return `thread ${clip(threads.get(a.target.threadId) ?? a.target.threadId, 28)}`;
  return a.target.location ?? Object.values(a.target.target)[0] ?? "channel";
}

export async function automations(connection: Connection, options: { json?: boolean }) {
  const { client } = connection;
  const [list, agentList, threadList] = await Promise.all([client.automations(), client.agents(), client.threads({ limit: 500 })]);
  if (options.json) return out(JSON.stringify(list, null, 2));
  const p = paint();
  if (list.length === 0) return out(p.dim('No automations yet. Ask an agent: "every weekday at 9 post a standup summary here".'));
  const titles = new Map(threadList.map((t) => [t.id, t.title]));
  const rows = list.map((a) => {
    const agent = agentList.find((x) => x.id === a.agentId);
    const status = a.lastStatus === "ok" ? p.green("ok") : a.lastStatus === "failed" ? p.red("failed") : a.lastStatus === "running" ? p.accent("running") : p.dim("—");
    return [
      p.dim(a.id),
      clip(a.name, 28),
      agent ? `${p.hex(agent.color)(agent.avatar)} @${agent.handle}` : p.dim("?"),
      `${a.scheduleText} ${p.dim(`(${a.timezone})`)}`,
      targetLabel(a, titles),
      a.enabled ? (a.nextRunAt ? untilTime(a.nextRunAt) : p.dim("—")) : p.yellow("disabled"),
      a.lastRunAt ? `${status} ${p.dim(relTime(a.lastRunAt))}` : status,
    ];
  });
  out(table(rows, ["ID", "NAME", "AGENT", "SCHEDULE", "TARGET", "NEXT", "LAST"], p));
}
