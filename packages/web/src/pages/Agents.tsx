import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Brain,
  Check,
  Clock,
  Eraser,
  Gauge,
  Globe,
  MessageSquare,
  Palette,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Star,
  Trash,
  TriangleAlert,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  AGENT_SKILLS,
  APPROVAL_POLICIES,
  type Agent,
  type AgentBudget,
  type AgentInput,
  type AgentSkill,
  type AgentSpend,
  type Memory,
  type ProviderInfo,
  type ThinkingLevel,
} from "@soloagent/client";
import { client, errorMessage } from "../api/client.ts";
import { useMcpServers } from "../api/mcp.ts";
import { loadProviders, local, useAgentActivity, useApp, useIsAdmin, type AgentActivity } from "../api/store.ts";
import { AgentTransfer } from "../components/AgentTransfer.tsx";
import { AgentAvatar, ProviderMark } from "../components/brand.tsx";
import { findModel, ModelPicker } from "../components/ModelPicker.tsx";
import { Drawer, Popover } from "../components/overlay.tsx";
import { Badge, Button, Card, Dot, EmptyState, Field, IconButton, Input, Kbd, Meter, Page, PageHeader, Segmented, Skeleton, Spinner, Switch, Textarea } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { contextWindow, cost, fullDate, num, perMillion, pluralize, shortTime, slugify } from "../lib/format.ts";
import { linkHandler, navigate } from "../lib/router.ts";
import { confirm, toast } from "../lib/toast.ts";
import { shortcut } from "../lib/keys.ts";

export const GLYPHS = ["●", "◆", "✦", "▲", "■", "★", "⚡", "λ", "∞", "§", "☾", "☀", "✿", "⌘", "♪", "❖"];
export const EMOJI = ["🤖", "🧠", "🦊", "🐙", "🦉", "🚀", "🔮", "🧪", "📚", "🛠️", "🎨", "💼", "🧭", "🌱", "🐝", "🍀"];
export const COLORS = ["#9cbf10", "#3b82f6", "#0ea5e9", "#14b8a6", "#10b981", "#65a30d", "#eab308", "#f59e0b", "#f97316", "#f43f5e", "#ec4899", "#78716c"];
const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const SKILL_ICON: Record<AgentSkill, LucideIcon> = {
  memory: Brain,
  web: Globe,
  delegate: Users,
  schedule: Clock,
  workspace: SquareTerminal,
};

export function Agents({ editId }: { editId?: string }) {
  const agents = useApp((s) => s.agents);
  const providers = useApp((s) => s.providers);
  const threads = useApp((s) => s.threads);
  const isAdmin = useIsAdmin();
  const spend = useSpendToday();
  const activity = useAgentActivity();
  const [memoryCounts, setMemoryCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    void loadProviders();
  }, []);

  // Refresh when the drawer opens or closes: the memory tab may have changed them.
  useEffect(() => {
    client
      .memoryCounts()
      .then(setMemoryCounts)
      .catch(() => {});
  }, [editId]);

  const editing = editId === "new" ? null : agents?.find((a) => a.id === editId);
  const drawerOpen = (editId === "new" && isAdmin) || !!editing;

  // Threads per agent, and when each agent last did anything.
  const byAgent = useMemo(() => {
    const map = new Map<string, { count: number; last: number }>();
    for (const t of threads ?? []) {
      const entry = map.get(t.agentId) ?? { count: 0, last: 0 };
      entry.count++;
      entry.last = Math.max(entry.last, t.updatedAt);
      map.set(t.agentId, entry);
    }
    return map;
  }, [threads]);

  return (
    <Page>
      <PageHeader
        eyebrow="Fleet"
        title="Agents"
        description="Each agent has its own instructions, model, and skills. Mention them by @handle anywhere they're connected."
        actions={
          isAdmin && (
            <>
              <AgentTransfer />
              <Button variant="primary" icon={<Plus />} onClick={() => navigate("/agents/new")}>
                New agent
              </Button>
            </>
          )
        }
      />

      {!agents ? (
        <>
          <Skeleton className="mb-6 h-[58px] rounded-xl" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[300px] rounded-xl" />
            ))}
          </div>
        </>
      ) : agents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bot />}
            title="No agents yet"
            description="Agents answer in chat, Slack, Discord, and Telegram. Create your first one."
            action={
              isAdmin && (
                <Button variant="primary" icon={<Plus />} onClick={() => navigate("/agents/new")}>
                  Create agent
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <FleetBar agents={agents} activity={activity} spend={spend} />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent, i) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                index={i}
                providers={providers}
                activity={activity.get(agent.id)}
                threads={byAgent.get(agent.id)}
                memories={memoryCounts[agent.id] ?? 0}
                spend={spend?.find((s) => s.agentId === agent.id)}
              />
            ))}
            {isAdmin && (
              <button
                type="button"
                onClick={() => navigate("/agents/new")}
                className="group flex min-h-[260px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong text-subtle transition-colors hover:border-solid hover:bg-surface/60 hover:text-fg"
              >
                <span className="grid size-11 place-items-center rounded-xl border border-border bg-surface-2 shadow-sm transition-colors group-hover:border-border-strong group-hover:bg-control-hover">
                  <Plus className="size-5" />
                </span>
                <span className="text-center">
                  <span className="block text-[13.5px] font-medium">New agent</span>
                  <span className="mt-0.5 block text-[12px] text-faint">A name, a model, and the skills it needs</span>
                </span>
              </button>
            )}
          </div>
        </>
      )}

      {drawerOpen && (
        <AgentEditor
          key={editId}
          agent={editing ?? null}
          readOnly={!isAdmin}
          spend={spend?.find((s) => s.agentId === editing?.id)}
          memoryCount={editing ? memoryCounts[editing.id] : undefined}
          onClose={() => navigate("/agents")}
        />
      )}
      {editId && editId !== "new" && agents && !editing && <MissingAgent />}
    </Page>
  );
}

function MissingAgent() {
  useEffect(() => {
    toast.info("That agent no longer exists");
    navigate("/agents", { replace: true });
  }, []);
  return null;
}

// ---------------------------------------------------------------------------
// Roster

/** One line of fleet status: how many agents, who's working, who needs a human, what today cost. */
function FleetBar({ agents, activity, spend }: { agents: Agent[]; activity: Map<string, AgentActivity>; spend: AgentSpend[] | null }) {
  const states = [...activity.values()];
  const working = states.filter((a) => a.presence === "working").length;
  const waiting = states.filter((a) => a.presence === "approval").length;
  const usd = spend?.reduce((sum, s) => sum + s.usd, 0) ?? null;
  const runs = spend?.reduce((sum, s) => sum + s.runs, 0) ?? null;
  const unready = agents.filter((a) => !a.model).length;

  const cells: { label: string; value: ReactNode; tone?: "accent" | "warning"; title?: string }[] = [
    { label: "Agents", value: num(agents.length), title: unready ? `${pluralize(unready, "agent")} without a model` : undefined },
    {
      label: "Working",
      value: (
        <span className="flex items-center gap-2">
          {working > 0 && <Dot tone="accent" pulse className="size-1.5 [&>span]:size-1.5" />}
          {num(working)}
        </span>
      ),
      tone: working > 0 ? "accent" : undefined,
    },
    { label: "Need you", value: num(waiting), tone: waiting > 0 ? "warning" : undefined, title: "Agents paused on a tool call that waits for approval" },
    { label: "Spent today", value: usd === null ? "—" : cost(usd), title: "At list API prices, UTC day" },
    { label: "Messages today", value: runs === null ? "—" : num(runs), title: "Messages admitted today, UTC" },
  ];

  return (
    <Card className="mb-6 grid grid-cols-2 overflow-hidden sm:grid-cols-5">
      {cells.map((cell, i) => (
        <div
          key={cell.label}
          title={cell.title}
          className={cn(
            "flex flex-col gap-1 border-border px-4 py-3",
            i > 0 && "sm:border-l",
            i % 2 === 1 && "border-l",
            i >= 2 && "border-t sm:border-t-0",
            i === cells.length - 1 && cells.length % 2 === 1 && "col-span-2 sm:col-span-1",
          )}
        >
          <span className="label-mono text-faint">{cell.label}</span>
          <span
            className={cn(
              "font-mono text-[15px] font-medium tabular-nums",
              cell.tone === "accent" ? "text-accent-text" : cell.tone === "warning" ? "text-warning" : "text-fg",
            )}
          >
            {cell.value}
          </span>
        </div>
      ))}
    </Card>
  );
}

function AgentCard({
  agent,
  index,
  providers,
  activity,
  threads,
  memories,
  spend,
}: {
  agent: Agent;
  index: number;
  providers: ProviderInfo[] | null;
  activity: AgentActivity | undefined;
  threads: { count: number; last: number } | undefined;
  memories: number;
  spend: AgentSpend | undefined;
}) {
  const found = findModel(providers, agent.model);
  const presence = activity?.presence ?? "idle";
  const where = activity?.thread ? activity.thread.location || activity.thread.title : undefined;
  const policy = APPROVAL_POLICIES.find((p) => p.id === agent.approvals);
  const open = () => navigate(`/agents/${agent.id}`);

  return (
    <Card
      interactive
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
      className="group relative flex animate-rise cursor-pointer flex-col overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {/* Each agent carries a faint wash of its own color. */}
      <div aria-hidden className="pointer-events-none absolute -left-16 -top-24 size-56 rounded-full opacity-[0.13] blur-3xl transition-opacity duration-300 group-hover:opacity-[0.2]" style={{ background: agent.color }} />

      <div className="relative flex flex-1 flex-col p-5 pb-4">
        <div className="flex items-start gap-3.5">
          <AgentAvatar agent={agent} size="lg" presence={presence} className="[--presence-ring:var(--surface)]" />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{agent.name}</h3>
              {agent.isDefault && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label="Default agent" />}
            </div>
            <p className="truncate font-mono text-[12px] text-subtle">@{agent.handle}</p>
          </div>
          <PresenceTag presence={presence} />
        </div>

        <p className="mt-3.5 line-clamp-2 min-h-[2.9em] text-[13px] leading-[1.45] text-muted">{agent.description || "No description."}</p>

        {activity?.thread && presence !== "idle" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/chat/${activity.thread!.id}`);
            }}
            title="Open the thread"
            className={cn(
              "mt-3 flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors",
              presence === "working" ? "border-accent-line/25 bg-accent-soft hover:border-accent-line/45" : "border-warning/25 bg-warning-soft hover:border-warning/45",
            )}
          >
            {presence === "working" ? <span className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent-line" /> : <ShieldAlert className="size-3.5 shrink-0 text-warning" />}
            <span className={cn("shrink-0 font-medium", presence === "working" ? "text-accent-text" : "text-warning")}>{presence === "working" ? "Working" : "Waiting for approval"}</span>
            {where && <span className="min-w-0 truncate text-muted">in {where}</span>}
            {activity.working + activity.waiting > 1 && (
              <span className="ml-auto shrink-0 font-mono text-[10.5px] text-subtle">+{activity.working + activity.waiting - 1}</span>
            )}
          </button>
        )}

        <ModelRow agent={agent} found={found} className="mt-4" />

        <div className="mt-3 flex flex-wrap gap-1">
          {agent.skills.length === 0 && <span className="text-[12px] text-faint">No skills — it can only talk</span>}
          {agent.skills.map((skill) => (
            <SkillChip key={skill} skill={skill} />
          ))}
          {agent.mcpServers.length > 0 && (
            <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-surface-2/60 px-1.5 text-[11.5px] text-muted">
              <Wrench className="size-3 text-subtle" />
              {pluralize(agent.mcpServers.length, "MCP server")}
            </span>
          )}
        </div>

        {(agent.approvals !== "off" || agent.budget.dailyUsd !== null || agent.budget.dailyRuns !== null) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle">
            {agent.approvals !== "off" && policy && (
              <span className="flex items-center gap-1" title={policy.description}>
                <ShieldCheck className="size-3.5 text-faint" />
                Asks first · {policy.label.toLowerCase()}
              </span>
            )}
            {(agent.budget.dailyUsd !== null || agent.budget.dailyRuns !== null) && (
              <span className="flex items-center gap-1 font-mono text-[11px]" title="Daily limits, UTC">
                <Gauge className="size-3.5 text-faint" />
                {[agent.budget.dailyUsd !== null && `${cost(agent.budget.dailyUsd)}/day`, agent.budget.dailyRuns !== null && `${num(agent.budget.dailyRuns)} msgs/day`].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="relative flex flex-col gap-3 border-t border-border bg-surface-2/25 px-5 py-3">
        <SpendMeter spend={spend} budget={agent.budget} />
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-mono text-[11px] text-faint">
            {pluralize(threads?.count ?? 0, "thread")}
            {agent.skills.includes("memory") || memories > 0 ? ` · ${pluralize(memories, "memory", "memories")}` : ""}
            {threads?.last ? ` · ${shortTime(threads.last)}` : ""}
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon={<MessageSquare />}
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/chat/new/${agent.id}`);
            }}
          >
            Chat
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PresenceTag({ presence }: { presence: AgentActivity["presence"] }) {
  if (presence === "working") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-accent-line/25 bg-accent-soft px-2 font-mono text-[10.5px] text-accent-text">
        <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-line" />
        working
      </span>
    );
  }
  if (presence === "approval") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-warning/25 bg-warning-soft px-2 font-mono text-[10.5px] text-warning">
        <span className="size-1.5 rounded-full bg-warning" />
        needs you
      </span>
    );
  }
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1.5 px-1 font-mono text-[10.5px] text-faint">
      <span className="size-1.5 rounded-full bg-faint/60" />
      idle
    </span>
  );
}

function ModelRow({ agent, found, className }: { agent: Agent; found: ReturnType<typeof findModel>; className?: string }) {
  if (!agent.model) {
    return (
      <div className={cn("flex items-center gap-2 rounded-lg border border-dashed border-warning/35 bg-warning-soft px-2.5 py-2 text-[12.5px] text-warning", className)}>
        <TriangleAlert className="size-3.5 shrink-0" />
        No model selected
      </div>
    );
  }
  const disconnected = found && !found.provider.configured;
  return (
    <div className={cn("flex items-center gap-2.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-2", className)}>
      <ProviderMark id={agent.model.provider} name={found?.provider.name ?? agent.model.provider} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium leading-tight text-fg">{found?.model.name ?? agent.model.modelId}</p>
        <p className="truncate font-mono text-[10.5px] leading-tight text-faint">
          {agent.model.provider}/{agent.model.modelId}
        </p>
      </div>
      {disconnected ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-warning" title={`${found.provider.name} isn't connected`}>
          <TriangleAlert className="size-3.5" />
          offline
        </span>
      ) : (
        agent.thinkingLevel !== "off" && (
          <span className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-3/60 px-1.5 py-0.5 font-mono text-[10.5px] text-subtle" title={`Thinking: ${agent.thinkingLevel}`}>
            <Brain className="size-3" />
            {agent.thinkingLevel}
          </span>
        )
      )}
    </div>
  );
}

function SkillChip({ skill }: { skill: AgentSkill }) {
  const info = AGENT_SKILLS.find((s) => s.id === skill);
  const Icon = SKILL_ICON[skill] ?? Wrench;
  const dangerous = !!info?.dangerous;
  return (
    <span
      title={info?.description}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11.5px]",
        dangerous ? "border-warning/25 bg-warning-soft text-warning" : "border-border bg-surface-2/60 text-muted",
      )}
    >
      <Icon className={cn("size-3", dangerous ? "text-warning" : "text-subtle")} />
      {info?.label ?? skill}
    </span>
  );
}

type Draft = Required<Omit<AgentInput, "model" | "budget">> & { model: AgentInput["model"]; budget: AgentBudget };

function toDraft(agent: Agent | null, defaultModel: Agent["model"]): Draft {
  return {
    name: agent?.name ?? "",
    handle: agent?.handle ?? "",
    avatar: agent?.avatar ?? "●",
    color: agent?.color ?? COLORS[Math.floor(Math.random() * COLORS.length)]!,
    description: agent?.description ?? "",
    instructions: agent?.instructions ?? "",
    model: agent ? agent.model : defaultModel,
    thinkingLevel: agent?.thinkingLevel ?? "medium",
    skills: agent?.skills ?? ["memory", "web", "delegate", "schedule"],
    mcpServers: agent?.mcpServers ?? [],
    maxTurns: agent?.maxTurns ?? 40,
    isDefault: agent?.isDefault ?? false,
    approvals: agent?.approvals ?? "off",
    budget: agent?.budget ?? { dailyUsd: null, dailyRuns: null },
    chatAccess: agent?.chatAccess ?? false,
  };
}

/** Today's spend per agent, refreshed as replies come in. */
function useSpendToday(): AgentSpend[] | null {
  const [spend, setSpend] = useState<AgentSpend[] | null>(null);
  const activityCount = useApp((s) => s.activity.length);
  useEffect(() => {
    const id = setTimeout(() => void client.spendToday().then(setSpend).catch(() => {}), spend ? 1500 : 0);
    return () => clearTimeout(id);
  }, [activityCount]);
  return spend;
}

/** "$0.42 today", with a bar against the daily budget when there is one. */
function SpendMeter({ spend, budget, className }: { spend: AgentSpend | undefined; budget: AgentBudget; className?: string }) {
  const usd = spend?.usd ?? 0;
  const runs = spend?.runs ?? 0;
  const parts: { label: string; ratio: number | null }[] = [
    { label: budget.dailyUsd !== null ? `${cost(usd)} of ${cost(budget.dailyUsd)}` : `${cost(usd)}`, ratio: budget.dailyUsd ? usd / budget.dailyUsd : budget.dailyUsd === 0 ? 1 : null },
  ];
  if (budget.dailyRuns !== null) parts.push({ label: `${runs} of ${budget.dailyRuns} messages`, ratio: budget.dailyRuns ? runs / budget.dailyRuns : 1 });
  const ratio = Math.max(0, ...parts.map((p) => p.ratio ?? 0));
  const limited = parts.some((p) => p.ratio !== null);
  return (
    <div className={cn("flex flex-col gap-1.5", className)} title="Today, UTC">
      <div className="flex items-center justify-between gap-2">
        <span className="label-mono text-faint">Today</span>
        <span className={cn("font-mono text-[11.5px] tabular-nums", ratio >= 1 ? "font-medium text-danger" : "text-muted")}>{parts.map((p) => p.label).join(" · ")}</span>
      </div>
      {limited && <Meter value={Math.min(1, ratio)} max={1} tone={ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "accent"} className="h-1" label="Today's spend against the budget" />}
    </div>
  );
}

/** A number input where empty means "no limit". */
function LimitInput({ id, value, onChange, step, prefix, disabled }: { id: string; value: number | null; onChange: (value: number | null) => void; step: string; prefix?: string; disabled?: boolean }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  return (
    <div className="relative">
      {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[13px] text-faint">{prefix}</span>}
      <Input
        id={id}
        type="number"
        min={0}
        step={step}
        inputMode="decimal"
        placeholder="No limit"
        disabled={disabled}
        value={text}
        className={cn("font-mono tabular-nums", prefix ? "pl-6" : undefined)}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          onChange(e.target.value.trim() === "" || !Number.isFinite(n) || n < 0 ? null : n);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor

function AgentEditor({
  agent,
  readOnly,
  spend,
  memoryCount,
  onClose,
}: {
  agent: Agent | null;
  readOnly: boolean;
  spend: AgentSpend | undefined;
  memoryCount: number | undefined;
  onClose: () => void;
}) {
  const agents = useApp((s) => s.agents) ?? [];
  const providers = useApp((s) => s.providers);
  const activity = useAgentActivity();
  const defaultModel = agents.find((a) => a.isDefault)?.model ?? null;
  const [draft, setDraft] = useState<Draft>(() => toDraft(agent, defaultModel));
  const [handleTouched, setHandleTouched] = useState(!!agent);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"settings" | "memory">("settings");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const handleError = useMemo(() => {
    if (!draft.handle) return "Required";
    if (!/^[a-z0-9-]+$/.test(draft.handle)) return "Lowercase letters, digits, and dashes only";
    if (agents.some((a) => a.handle === draft.handle && a.id !== agent?.id)) return "Another agent already uses this handle";
    return null;
  }, [draft.handle, agents, agent]);
  const nameError = draft.name.trim() ? null : "Required";
  const model = findModel(providers, draft.model ?? null);
  const presence = agent ? activity.get(agent.id)?.presence : undefined;

  const save = async () => {
    if (nameError || handleError) return;
    setSaving(true);
    try {
      const input: AgentInput = { ...draft, name: draft.name.trim(), maxTurns: Math.max(1, Math.min(500, Math.round(draft.maxTurns) || 40)) };
      const saved = agent ? await client.updateAgent(agent.id, input) : await client.createAgent(input);
      local.agent(saved);
      toast.success(agent ? "Agent saved" : `${saved.name} is ready`, agent ? undefined : `Mention @${saved.handle} or start a chat.`);
      onClose();
    } catch (error) {
      toast.error(error, "Could not save agent");
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    const ok = await confirm({
      title: `Delete ${agent.name}?`,
      body: "Its threads stay in your history, but nobody can talk to this agent anymore. This can't be undone.",
      confirmLabel: "Delete agent",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await client.deleteAgent(agent.id);
      local.agentDeleted(agent.id);
      toast.success(`${agent.name} deleted`);
      onClose();
    } catch (error) {
      toast.error(error, "Could not delete agent");
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-2xl"
      icon={<AgentAvatar agent={draft} size="md" presence={presence} className="[--presence-ring:var(--overlay)]" />}
      title={agent ? (readOnly ? agent.name : `Edit ${agent.name}`) : "New agent"}
      description={agent ? `@${agent.handle}${model ? ` · ${model.model.name}` : ""}` : "Give it a personality, a model, and skills."}
      footer={
        tab === "memory" ? undefined : readOnly ? (
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-[12.5px] text-subtle sm:inline">Only admins can change agents.</span>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {agent && (
              <Button variant="accent" icon={<MessageSquare />} onClick={() => navigate(`/chat/new/${agent.id}`)}>
                Chat
              </Button>
            )}
          </div>
        ) : (
          <>
            {agent && (
              <Button variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" icon={<Trash />} onClick={remove}>
                Delete
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" loading={saving} disabled={!!nameError || !!handleError} onClick={save}>
                {agent ? "Save changes" : "Create agent"}
              </Button>
            </div>
          </>
        )
      }
    >
      {agent && (
        <div className="sticky top-0 z-10 border-b border-border bg-overlay/90 px-5 py-2.5 backdrop-blur-md">
          <Segmented
            value={tab}
            onChange={setTab}
            size="sm"
            className="w-full max-w-xs"
            options={[
              { value: "settings", label: "Settings" },
              {
                value: "memory",
                label: (
                  <>
                    Memory
                    {memoryCount ? <span className="font-mono text-[10.5px] text-faint">{num(memoryCount)}</span> : null}
                  </>
                ),
              },
            ]}
          />
        </div>
      )}
      {agent && tab === "memory" ? (
        <MemoryPanel agent={agent} readOnly={readOnly} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!readOnly) void save();
          }}
        >
          <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-7 px-5 py-6">
            <Section title="Identity" description="How it shows up in chat, on cards, and in @mentions.">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <AppearancePicker avatar={draft.avatar} color={draft.color} name={draft.name} onAvatar={(g) => set("avatar", g)} onColor={(c) => set("color", c)} />
                <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2">
                  <Field label="Name" htmlFor="agent-name" error={draft.name ? nameError : null}>
                    <Input
                      id="agent-name"
                      data-autofocus
                      value={draft.name}
                      placeholder="Code Reviewer"
                      onChange={(e) => {
                        const name = e.target.value;
                        setDraft((d) => ({ ...d, name, handle: handleTouched ? d.handle : slugify(name) }));
                      }}
                    />
                  </Field>
                  <Field label="Handle" htmlFor="agent-handle" error={draft.handle ? handleError : null} hint="For @mentions in chat and on Slack.">
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[13px] text-faint">@</span>
                      <Input
                        id="agent-handle"
                        value={draft.handle}
                        invalid={!!draft.handle && !!handleError}
                        placeholder="reviewer"
                        className="pl-7 font-mono"
                        onChange={(e) => {
                          setHandleTouched(true);
                          set("handle", e.target.value.toLowerCase().replace(/\s+/g, "-"));
                        }}
                      />
                    </div>
                  </Field>
                  <Field label="Description" htmlFor="agent-desc" hint="A short line shown on cards and in pickers." className="sm:col-span-2">
                    <Input id="agent-desc" value={draft.description} placeholder="Reviews pull requests and catches bugs early." onChange={(e) => set("description", e.target.value)} />
                  </Field>
                </div>
              </div>
            </Section>

            <Section title="Brain" description="The model it thinks with, and how long it reasons before answering.">
              <Field
                label="Model"
                htmlFor="agent-model"
                hint={model ? `${contextWindow(model.model.contextWindow)} context · ${perMillion(model.model.cost.input)} in / ${perMillion(model.model.cost.output)} out per million tokens` : undefined}
              >
                <ModelPicker id="agent-model" value={draft.model ?? null} onChange={(m) => set("model", m)} />
              </Field>
              <Field
                label="Thinking"
                hint={model && !model.model.reasoning ? "This model doesn't support extended thinking; the setting is ignored." : "Higher is slower and costs more."}
              >
                <Segmented value={draft.thinkingLevel} onChange={(v) => set("thinkingLevel", v)} size="sm" className="w-full" options={THINKING.map((t) => ({ value: t, label: <span className="font-mono">{t}</span> }))} />
              </Field>
            </Section>

            <Section
              title="Instructions"
              description="The system prompt: who the agent is, how it behaves, what it should never do."
              aside={<span className="font-mono text-[11px] tabular-nums text-faint">{num(draft.instructions.length)} chars</span>}
            >
              <Textarea
                value={draft.instructions}
                onChange={(e) => set("instructions", e.target.value)}
                rows={11}
                placeholder={"You are a careful senior engineer who reviews code.\n\n- Be specific and cite file names.\n- Suggest fixes, not just problems."}
                className="min-h-[220px] bg-code font-mono text-[12.5px] leading-[1.7]"
                aria-label="Instructions"
              />
            </Section>

            <Section title="Skills" description="What it may do beyond talking. Each one adds tools to its runs.">
              <div className="grid gap-2 sm:grid-cols-2">
                {AGENT_SKILLS.map((skill) => {
                  const on = draft.skills.includes(skill.id);
                  const Icon = SKILL_ICON[skill.id] ?? Wrench;
                  const toggle = (value: boolean) =>
                    setDraft((d) => ({
                      ...d,
                      skills: value ? [...d.skills, skill.id] : d.skills.filter((s): s is AgentSkill => s !== skill.id),
                      // Shell access asks first by default.
                      approvals: value && skill.id === "workspace" && d.approvals === "off" ? "risky" : d.approvals,
                    }));
                  return (
                    <label
                      key={skill.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors",
                        skill.dangerous && "sm:col-span-2",
                        on
                          ? skill.dangerous
                            ? "border-warning/35 bg-warning-soft"
                            : "border-border-strong bg-surface-2/70"
                          : "border-border bg-surface/40 hover:border-border-strong hover:bg-surface-2/40",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-8 shrink-0 place-items-center rounded-lg border transition-colors [&_svg]:size-4",
                          on ? (skill.dangerous ? "border-warning/30 bg-warning/15 text-warning" : "border-border-strong bg-surface-3 text-fg") : "border-border bg-surface-2 text-subtle",
                        )}
                      >
                        <Icon />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13.5px] font-medium text-fg">{skill.label}</span>
                          {skill.dangerous && (
                            <Badge tone="warning">
                              <ShieldAlert />
                              Dangerous
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-[12px] leading-relaxed text-subtle">{skill.description}</p>
                        {skill.dangerous && on && (
                          <p className="mt-1.5 text-[12px] leading-relaxed text-warning">
                            {draft.approvals === "off"
                              ? "Anyone who can talk to this agent can run shell commands on your server. Consider turning on approvals below."
                              : "Anyone who can talk to this agent can ask it to run shell commands; each one waits for an approval."}
                            {!draft.chatAccess && " Slack, Discord, and Telegram can't reach it unless you allow chat access below."}
                          </p>
                        )}
                      </div>
                      <Switch checked={on} onChange={toggle} label={skill.label} size="sm" />
                    </label>
                  );
                })}
              </div>
            </Section>

            <Section title="Approvals" description="Pause before tool calls until a person approves them — in the dashboard, or with buttons in Slack, Discord, and Telegram.">
              <Field label="Ask before" hint={APPROVAL_POLICIES.find((p) => p.id === draft.approvals)?.description}>
                <Segmented value={draft.approvals} onChange={(v) => set("approvals", v)} size="sm" className="w-full max-w-md" options={APPROVAL_POLICIES.map((p) => ({ value: p.id, label: p.label }))} />
              </Field>
              {draft.skills.includes("workspace") && (
                <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3.5", draft.chatAccess ? "border-danger/40 bg-danger-soft" : "border-border bg-surface/40")}>
                  <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border", draft.chatAccess ? "border-danger/30 bg-danger/10 text-danger" : "border-warning/30 bg-warning-soft text-warning")}>
                    <TriangleAlert className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="text-[13.5px] font-medium text-fg">Reachable from chat apps</span>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-subtle">Off by default: agents with the workspace skill answer only here, in the terminal, the API, and webhooks.</p>
                    {draft.chatAccess && (
                      <p className="mt-1.5 text-[12px] font-medium leading-relaxed text-danger">
                        Anyone who can message this agent in Slack, Discord, or Telegram can run shell commands on your server. Limit who can reach it with each connection's access lists.
                      </p>
                    )}
                  </div>
                  <Switch
                    checked={draft.chatAccess}
                    label="Reachable from chat apps"
                    size="sm"
                    onChange={async (value) => {
                      if (value) {
                        const ok = await confirm({
                          title: "Let chat apps reach this agent?",
                          body: "It can run shell commands on your server. Everyone who can message it on a connection, and isn't excluded by that connection's access lists, gets that power.",
                          confirmLabel: "Allow chat access",
                          tone: "danger",
                        });
                        if (!ok) return;
                      }
                      set("chatAccess", value);
                    }}
                  />
                </label>
              )}
            </Section>

            <Section title="Budget" description="Checked before each message. Over the limit, chat users get a short reply and the API answers 429. Days are UTC.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Daily spend" htmlFor="agent-budget-usd" hint="USD at list API prices. Empty for no limit.">
                  <LimitInput id="agent-budget-usd" step="0.01" prefix="$" value={draft.budget.dailyUsd} onChange={(v) => set("budget", { ...draft.budget, dailyUsd: v })} />
                </Field>
                <Field label="Daily messages" htmlFor="agent-budget-runs" hint="Messages admitted per day. Empty for no limit.">
                  <LimitInput id="agent-budget-runs" step="1" value={draft.budget.dailyRuns} onChange={(v) => set("budget", { ...draft.budget, dailyRuns: v === null ? null : Math.round(v) })} />
                </Field>
              </div>
              {agent && <SpendMeter spend={spend} budget={draft.budget} className="rounded-lg border border-border bg-surface-2/40 px-3 py-2.5" />}
            </Section>

            <Section title="Tools from MCP servers" description="Give it the tools of servers you connected under Tools.">
              <McpServerPicker value={draft.mcpServers} onChange={(ids) => set("mcpServers", ids)} />
            </Section>

            <Section title="Behavior">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Max turns" htmlFor="agent-turns" hint="Upper bound on tool rounds per run.">
                  <Input id="agent-turns" type="number" min={1} max={500} value={draft.maxTurns} className="font-mono tabular-nums" onChange={(e) => set("maxTurns", Number(e.target.value))} />
                </Field>
              </div>
              <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3.5", draft.isDefault ? "border-warning/30 bg-warning-soft/60" : "border-border bg-surface/40")}>
                <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border", draft.isDefault ? "border-warning/30 bg-warning/10" : "border-border bg-surface-2")}>
                  <Star className={cn("size-4", draft.isDefault ? "fill-warning text-warning" : "text-faint")} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-[13.5px] font-medium text-fg">Default agent</span>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-subtle">Answers messages that don't mention a specific agent, on every connection without its own binding.</p>
                </div>
                <Switch checked={draft.isDefault} onChange={(v) => set("isDefault", v)} label="Default agent" size="sm" disabled={agent?.isDefault} />
              </label>
            </Section>
            <button type="submit" hidden />
          </fieldset>
        </form>
      )}
    </Drawer>
  );
}

/** The big avatar in the editor. Click it to pick a glyph or emoji and a color. */
function AppearancePicker({
  avatar,
  color,
  name,
  onAvatar,
  onColor,
}: {
  avatar: string;
  color: string;
  name: string;
  onAvatar: (glyph: string) => void;
  onColor: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex shrink-0 flex-row items-center gap-3 sm:flex-col sm:gap-2 sm:pt-1">
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Change avatar and color"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="group relative rounded-2xl disabled:cursor-default"
      >
        <AgentAvatar agent={{ avatar, color, name }} size="xl" className="transition-transform duration-200 group-hover:scale-[1.03] group-disabled:scale-100" />
        <span className="absolute -bottom-1.5 -right-1.5 grid size-6 place-items-center rounded-full border border-border-strong bg-control text-subtle shadow-sm transition-colors group-hover:text-fg group-disabled:hidden">
          <Palette className="size-3.5" />
        </span>
      </button>
      <span className="text-[11.5px] text-faint">Appearance</span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="w-[300px] !p-3">
        <p className="label-mono text-faint">Glyph</p>
        <div className="mt-2 grid grid-cols-8 gap-1">
          {[...GLYPHS, ...EMOJI].map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => onAvatar(g)}
              aria-label={`Avatar ${g}`}
              aria-pressed={avatar === g}
              className={cn(
                "grid size-8 place-items-center rounded-lg border text-[15px] transition-colors",
                avatar === g ? "border-border-strong bg-surface-3 ring-2 ring-fg/15" : "border-transparent hover:border-border hover:bg-surface-2",
              )}
            >
              {g}
            </button>
          ))}
        </div>
        <Input
          value={custom}
          maxLength={4}
          placeholder="Or type any emoji"
          aria-label="Custom avatar"
          className="mt-2 h-8 text-[13px]"
          onChange={(e) => {
            setCustom(e.target.value);
            if (e.target.value.trim()) onAvatar(e.target.value.trim());
          }}
        />
        <p className="label-mono mt-4 text-faint">Color</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onColor(c)}
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              className={cn("grid size-6 place-items-center rounded-full transition-transform hover:scale-110", color === c && "ring-2 ring-fg ring-offset-2 ring-offset-[var(--overlay)]")}
              style={{ background: c }}
            >
              {color === c && <Check className="size-3 text-white drop-shadow-[0_1px_1px_rgb(0_0_0/0.45)]" strokeWidth={3} />}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

function McpServerPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const servers = useMcpServers();
  if (!servers) return <Skeleton className="h-14 rounded-xl" />;
  // Selected ids whose server was deleted stay visible so they can be removed.
  const missing = value.filter((id) => !servers.some((s) => s.id === id));
  if (servers.length === 0 && missing.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-border-strong px-4 py-3 text-[12.5px] text-subtle">
        <Wrench className="size-4 shrink-0 text-faint" />
        <span className="flex-1">No MCP servers yet. Connect GitHub, Linear, a database, or any MCP server first.</span>
        <a href="/tools/new" onClick={linkHandler("/tools/new")} className="shrink-0 font-medium text-fg underline decoration-border-strong underline-offset-4 hover:decoration-fg">
          Add a server
        </a>
      </div>
    );
  }
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((v) => v !== id));
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface/40">
      {servers.map((server) => {
        const on = value.includes(server.id);
        const tone = !server.enabled ? "neutral" : server.status === "connected" ? "success" : server.status === "error" ? "danger" : "warning";
        return (
          <label key={server.id} className="flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/40">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Dot tone={tone} />
                <span className="text-[13.5px] font-medium text-fg">{server.name}</span>
                <span className="font-mono text-[11px] text-faint">{server.id}</span>
              </div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-subtle">
                {!server.enabled
                  ? "Disabled"
                  : server.status === "error"
                    ? "Not connected right now"
                    : server.tools.length
                      ? `${pluralize(server.tools.length, "tool")}${server.deferred ? ", loaded on demand" : ""}: `
                      : "Connecting…"}
                {server.enabled && server.status !== "error" && server.tools.length > 0 && (
                  <span className="font-mono text-[11.5px] text-muted">
                    {server.tools
                      .slice(0, 4)
                      .map((t) => t.name)
                      .join(", ")}
                    {server.tools.length > 4 ? ", …" : ""}
                  </span>
                )}
              </p>
            </div>
            <Switch checked={on} onChange={(v) => toggle(server.id, v)} label={`Tools from ${server.name}`} size="sm" />
          </label>
        );
      })}
      {missing.map((id) => (
        <div key={id} className="flex items-center gap-3 px-4 py-3">
          <span className="min-w-0 flex-1 text-[12.5px] text-subtle">
            <span className="font-mono">{id}</span> was deleted
          </span>
          <Button size="xs" variant="ghost" onClick={() => toggle(id, false)}>
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory

function MemoryPanel({ agent, readOnly }: { agent: Agent; readOnly: boolean }) {
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (q: string) => {
    try {
      const list = await client.memories(agent.id, { q: q.trim() || undefined });
      setMemories(list);
      if (!q.trim()) setTotal(list.length);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 200 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, agent.id]);

  const add = async () => {
    if (!draft.trim()) return;
    setAdding(true);
    try {
      await client.addMemory(agent.id, draft);
      setDraft("");
      setQuery("");
      await load("");
    } catch (e) {
      toast.error(e, "Could not save the memory");
    } finally {
      setAdding(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const updated = await client.updateMemory(agent.id, editing.id, editing.text);
      setMemories((list) => list?.map((m) => (m.id === updated.id ? updated : m)) ?? list);
      setEditing(null);
    } catch (e) {
      toast.error(e, "Could not save the memory");
    }
  };

  const remove = async (memory: Memory) => {
    try {
      await client.deleteMemory(agent.id, memory.id);
      setMemories((list) => list?.filter((m) => m.id !== memory.id) ?? list);
      setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
      toast.success("Memory deleted");
    } catch (e) {
      toast.error(e, "Could not delete the memory");
    }
  };

  const clearAll = async () => {
    const ok = await confirm({
      title: `Delete all of ${agent.name}'s memories?`,
      body: `${pluralize(total ?? 0, "memory", "memories")} will be deleted. ${agent.name} forgets everything it saved about people, preferences, and decisions. This can't be undone.`,
      confirmLabel: "Delete all",
      tone: "danger",
    });
    if (!ok) return;
    try {
      const { deleted } = await client.clearMemories(agent.id);
      setMemories([]);
      setTotal(0);
      setQuery("");
      toast.success(`Deleted ${pluralize(deleted, "memory", "memories")}`);
    } catch (e) {
      toast.error(e, "Could not delete the memories");
    }
  };

  return (
    <div className="flex flex-col gap-5 px-5 py-6">
      <p className="text-[12.5px] leading-relaxed text-subtle">
        Long-term notes {agent.name} keeps across every conversation. It saves them with the <code className="rounded bg-surface-2 px-1 py-px font-mono text-[11.5px] text-muted">remember</code> tool, and the newest 40
        are in its prompt.
        {!agent.skills.includes("memory") && <span className="text-warning"> The Memory skill is off, so this agent doesn't read or write them right now.</span>}
      </p>

      {!readOnly && (
        <div className="overflow-hidden rounded-xl border border-border bg-field shadow-xs transition-[border-color,box-shadow] focus-within:border-accent-line/60 focus-within:ring-[3px] focus-within:ring-focus">
          <textarea
            value={draft}
            rows={2}
            placeholder="Add a memory, e.g. Ann prefers short answers and works in CET."
            aria-label="New memory"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void add();
              }
            }}
            className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint"
          />
          <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5">
            <span className="mr-auto flex items-center gap-1 pl-1 text-[11.5px] text-faint [@media(pointer:coarse)]:invisible">
              <Kbd>{shortcut("↵")}</Kbd> to add
            </span>
            <Button size="sm" variant="primary" loading={adding} disabled={!draft.trim()} icon={<Plus />} onClick={add}>
              Add memory
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search memories" aria-label="Search memories" className="h-8 pl-8 text-[13px]" />
        </div>
        {!readOnly && (
          <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" icon={<Eraser />} disabled={!total} onClick={clearAll}>
            Clear all
          </Button>
        )}
      </div>

      {error ? (
        <p className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{error}</p>
      ) : !memories ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : memories.length === 0 ? (
        <EmptyState
          icon={<Brain />}
          title={query ? "No matching memories" : "No memories yet"}
          description={query ? "Try other words." : `When ${agent.name} learns something worth keeping, it shows up here. You can add one yourself too.`}
          className="py-10"
        />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="label-mono text-faint">{query ? `${pluralize(memories.length, "match", "matches")}` : pluralize(total ?? memories.length, "memory", "memories")}</p>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface/40">
            {memories.map((memory) => (
              <li key={memory.id} className="group px-4 py-3 transition-colors hover:bg-surface-2/30">
                {editing?.id === memory.id ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      value={editing.text}
                      rows={3}
                      data-autofocus
                      aria-label="Edit memory"
                      autoFocus
                      onChange={(e) => setEditing({ id: memory.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setEditing(null);
                        }
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void saveEdit();
                        }
                      }}
                      className="text-[13px]"
                    />
                    <div className="flex justify-end gap-1.5">
                      <Button size="xs" variant="ghost" icon={<X />} onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                      <Button size="xs" variant="primary" icon={<Check />} disabled={!editing.text.trim()} onClick={saveEdit}>
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-border-strong" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">{memory.text}</p>
                      <p className="mt-1 font-mono text-[11px] text-faint" title={fullDate(memory.createdAt)}>
                        #{memory.id} · saved {shortTime(memory.createdAt)}
                      </p>
                    </div>
                    {!readOnly && (
                      <div className="flex shrink-0 gap-0.5 opacity-60 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <IconButton label="Edit memory" size="sm" onClick={() => setEditing({ id: memory.id, text: memory.text })}>
                          <Pencil className="size-3.5" />
                        </IconButton>
                        <IconButton label="Delete memory" size="sm" onClick={() => void remove(memory)} className="hover:text-danger">
                          <Trash className="size-3.5" />
                        </IconButton>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Section({ title, description, aside, children }: { title: string; description?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-border pt-7 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="label-mono text-subtle">{title}</h3>
          {description && <p className="mt-1.5 text-[12.5px] leading-relaxed text-subtle">{description}</p>}
        </div>
        {aside && <div className="shrink-0 pt-0.5">{aside}</div>}
      </div>
      {children}
    </section>
  );
}
