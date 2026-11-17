import { useCallback, useEffect, useMemo, useState } from "react";
import { AlarmClock, ArrowUpRight, CircleDot, Network, Radio, X } from "lucide-react";
import type { ActivityItem, Schedule, TaskNode } from "@soloagent/client";
import { client } from "../api/client.ts";
import { useAgentMap, useApp, useStream } from "../api/store.ts";
import { AgentAvatar } from "../components/brand.tsx";
import { Badge, Button, Card, Dot, EmptyState, Page, PageHeader, Segmented, SectionHeader, Skeleton } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { clockTime, fullDate, relativeTime } from "../lib/format.ts";
import { linkHandler } from "../lib/router.ts";
import { confirm, toast } from "../lib/toast.ts";
import { ActivityFeed, LiveDot } from "./Overview.tsx";

/** Event log filters: each narrows the stream to related event types. */
type Kind = "all" | "chat" | "approvals" | "system" | "errors";
const KINDS: Record<Exclude<Kind, "all">, readonly ActivityItem["type"][]> = {
  chat: ["message", "reply"],
  approvals: ["approval", "access"],
  system: ["connector", "agent", "provider", "schedule"],
  errors: ["error"],
};

export function ActivityPage() {
  const [kind, setKind] = useState<Kind>("all");
  return (
    <Page>
      <PageHeader eyebrow="Observe" title="Activity" description="What your agents are doing right now, what they plan to do later, and everything they did recently — live." />
      <div className="grid gap-x-8 gap-y-10 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex min-w-0 flex-col gap-10">
          <TaskGraph />
          <Schedules />
        </div>
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em] text-fg">
                Event log <LiveDot />
              </h2>
              <p className="mt-0.5 text-[13px] text-subtle">Newest first.</p>
            </div>
            <Segmented<Kind>
              size="sm"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "All" },
                { value: "chat", label: "Chat", title: "Messages and replies" },
                { value: "approvals", label: "Approvals", title: "Approvals and access" },
                { value: "system", label: "System", title: "Connectors, agents, providers, and schedules" },
                { value: "errors", label: "Errors" },
              ]}
            />
          </div>
          <Card className="overflow-hidden">
            <div className="max-h-[calc(100dvh-230px)] min-h-[240px] overflow-y-auto">
              <ActivityFeed types={kind === "all" ? undefined : KINDS[kind]} />
            </div>
          </Card>
        </section>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Live task graph

type TreeNode = TaskNode & { children: TreeNode[] };

function buildTree(tasks: TaskNode[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(tasks.map((t) => [t.id, { ...t, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.owner ? nodes.get(node.owner) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => statusRank(a.status) - statusRank(b.status) || Number(b.id) - Number(a.id) || b.id.localeCompare(a.id));
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

function statusRank(status: string) {
  if (status === "running") return 0;
  if (status.startsWith("waiting")) return 1;
  if (status === "sleeping" || status === "pending") return 2;
  return 3;
}

function statusTone(status: string): "accent" | "info" | "warning" | "success" | "danger" | "neutral" {
  if (status === "running") return "accent";
  if (status.startsWith("waiting")) return "info";
  if (status === "sleeping" || status === "pending") return "warning";
  if (status === "done" || status === "completed" || status === "succeeded") return "success";
  if (status === "failed" || status === "error" || status === "cancelled") return "danger";
  return "neutral";
}

function TaskGraph() {
  const stream = useStream();
  const status = useApp((s) => s.status);
  const [tasks, setTasks] = useState<TaskNode[] | null>(null);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (!stream) return;
    const off = stream.on((event) => {
      if (event.type === "tasks") setTasks(event.tasks);
    });
    const unsubscribe = stream.subscribeTasks();
    return () => {
      off();
      unsubscribe();
    };
  }, [stream]);

  const visible = useMemo(() => (tasks ? (showDone ? tasks : tasks.filter((t) => statusRank(t.status) < 3)) : null), [tasks, showDone]);
  const tree = useMemo(() => (visible ? buildTree(visible) : []), [visible]);
  const hidden = tasks && visible ? tasks.length - visible.length : 0;
  const active = tasks?.filter((t) => statusRank(t.status) < 3).length ?? 0;
  const running = tasks?.filter((t) => t.status === "running").length ?? 0;

  return (
    <section>
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            <Network className="size-4 text-subtle" /> Live task graph
            {tasks && (
              <Badge tone={running > 0 ? "accent" : "neutral"} dot={running > 0}>
                {active} active
              </Badge>
            )}
          </span>
        }
        description="Durable tasks from Pi Durable, nested by owner. Updates live."
        action={
          tasks &&
          tasks.length > 0 && (
            <Button size="xs" variant="ghost" onClick={() => setShowDone((s) => !s)}>
              {showDone ? "Hide finished" : `Show finished${hidden ? ` (${hidden})` : ""}`}
            </Button>
          )
        }
      />
      <Card className="overflow-hidden">
        {!tasks ? (
          <div className="flex flex-col gap-2.5 p-4">
            {status !== "live" ? <p className="text-[12.5px] text-subtle">Waiting for the live connection…</p> : null}
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-5" style={{ width: `${80 - i * 15}%` }} />
            ))}
          </div>
        ) : tree.length === 0 ? (
          <EmptyState icon={<CircleDot />} title="Nothing running" description="When an agent works, waits on a subagent, or sleeps until a reminder, its tasks appear here." />
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(0,1fr)_auto] border-b border-border px-4 py-2 sm:grid">
              <span className="label-mono text-faint">Task</span>
              <span className="label-mono text-faint">Thread</span>
            </div>
            <ul className="p-1.5">
              {tree.map((node) => (
                <TaskRow key={node.id} node={node} depth={0} />
              ))}
            </ul>
          </>
        )}
      </Card>
    </section>
  );
}

function TaskRow({ node, depth }: { node: TreeNode; depth: number }) {
  const tone = statusTone(node.status);
  const threads = useApp((s) => s.threads);
  const thread = node.threadId ? threads?.find((t) => t.id === node.threadId) : undefined;
  return (
    <li>
      <div className="relative flex h-9 min-w-0 items-center gap-2.5 rounded-lg pr-2.5 transition-colors hover:bg-surface-2/60" style={{ paddingLeft: 10 + depth * 22 }}>
        {depth > 0 && <span aria-hidden className="absolute top-0 h-1/2 w-3 rounded-bl-md border-b border-l border-border-strong" style={{ left: depth * 22 - 6 }} />}
        <Dot tone={tone === "neutral" ? "neutral" : tone} pulse={node.status === "running"} />
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-faint">#{node.id}</span>
        <span className={cn("min-w-0 truncate font-mono text-[12.5px]", node.status === "running" ? "text-fg" : "text-muted")}>{node.kind}</span>
        <Badge tone={tone === "neutral" ? "neutral" : tone} className="shrink-0 font-mono">
          {node.status}
        </Badge>
        {node.detail && <span className="hidden min-w-0 truncate text-[12px] text-subtle sm:inline">{node.detail}</span>}
        {node.threadId && (
          <a
            href={`/chat/${node.threadId}`}
            onClick={linkHandler(`/chat/${node.threadId}`)}
            className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-subtle transition-colors hover:text-fg"
            title={thread?.title}
          >
            <span className="hidden max-w-[200px] truncate md:inline">{thread?.title ?? "thread"}</span>
            <ArrowUpRight className="size-3.5" />
          </a>
        )}
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TaskRow key={child.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Schedules

/** "Today 9:00 AM", "Tomorrow 9:00 AM", or "Nov 21, 9:00 AM". */
function whenLabel(at: number, now = Date.now()) {
  const day = (x: number) => {
    const d = new Date(x);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(at) - day(now)) / 86_400_000);
  if (diff === 0) return `Today ${clockTime(at)}`;
  if (diff === 1) return `Tomorrow ${clockTime(at)}`;
  return `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clockTime(at)}`;
}

function Schedules() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const agentMap = useAgentMap();
  const stream = useStream();

  const load = useCallback(async () => {
    try {
      setSchedules(await client.schedules());
    } catch (error) {
      toast.error(error, "Could not load schedules");
      setSchedules([]);
    }
  }, []);

  useEffect(() => {
    void load();
    if (!stream) return;
    // Schedules change when an agent sets or fires one; activity events cover both.
    return stream.on((event) => {
      if (event.type === "activity" && event.item.type === "schedule") void load();
    });
  }, [load, stream]);

  const cancel = async (schedule: Schedule) => {
    const ok = await confirm({ title: "Cancel this reminder?", body: schedule.text, confirmLabel: "Cancel reminder", tone: "danger" });
    if (!ok) return;
    try {
      await client.cancelSchedule(schedule.taskId);
      setSchedules((list) => list?.filter((s) => s.taskId !== schedule.taskId) ?? null);
      toast.success("Reminder cancelled");
    } catch (error) {
      toast.error(error, "Could not cancel");
    }
  };

  const upcoming = schedules?.filter((s) => s.status !== "done").sort((a, b) => a.at - b.at);

  return (
    <section>
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            <AlarmClock className="size-4 text-subtle" /> Schedules
            {upcoming && upcoming.length > 0 && <Badge>{upcoming.length} upcoming</Badge>}
          </span>
        }
        description="Durable reminders and follow-ups. They fire even after restarts."
      />
      <Card className="overflow-hidden">
        {!upcoming ? (
          <div className="flex flex-col gap-3 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : upcoming.length === 0 ? (
          <EmptyState
            icon={<Radio />}
            title="No reminders scheduled"
            description="Agents with the Schedule skill can set them. Try: “remind me tomorrow at 9 to review the launch checklist”."
          />
        ) : (
          <ul className="divide-y divide-border">
            {upcoming.map((schedule) => {
              const agent = agentMap.get(schedule.agentId);
              const firing = schedule.status === "running";
              return (
                <li key={schedule.taskId} className="flex items-center gap-3.5 px-4 py-3.5">
                  <div className="flex w-[92px] shrink-0 flex-col items-start">
                    <span className={cn("font-mono text-[12px] font-medium tabular-nums", firing ? "text-accent-text" : "text-fg")} title={fullDate(schedule.at)}>
                      {firing ? "firing now" : relativeTime(schedule.at)}
                    </span>
                    <span className="mt-0.5 truncate font-mono text-[10.5px] text-faint">{whenLabel(schedule.at)}</span>
                  </div>
                  <div className={cn("grid size-8 shrink-0 place-items-center rounded-lg border", firing ? "border-accent-line/30 bg-accent-soft text-accent-text" : "border-border bg-surface-2 text-subtle")}>
                    <AlarmClock className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] text-fg">{schedule.text}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-subtle">
                      <AgentAvatar agent={agent} size="xs" />
                      {agent?.name ?? "Agent"}
                      <span className="text-faint">·</span>
                      <a href={`/chat/${schedule.threadId}`} onClick={linkHandler(`/chat/${schedule.threadId}`)} className="inline-flex items-center gap-0.5 hover:text-fg hover:underline">
                        thread <ArrowUpRight className="size-3" />
                      </a>
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" icon={<X />} onClick={() => cancel(schedule)} aria-label="Cancel reminder">
                    <span className="hidden sm:inline">Cancel</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
