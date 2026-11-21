import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlarmClock,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CircleAlert,
  Coins,
  KeyRound,
  Lock,
  MessageSquare,
  MessagesSquare,
  Plug,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Star,
  UserPlus,
} from "lucide-react";
import type { ActivityItem, Agent, AgentSpend } from "@soloagent/client";
import { client } from "../api/client.ts";
import { loadProviders, useAgentActivity, useAgentMap, useApp, useIsAdmin, type AgentActivity } from "../api/store.ts";
import { AgentAvatar, type AgentPresence } from "../components/brand.tsx";
import { Button, Card, Dot, EmptyState, Meter, Page, PageHeader, SectionHeader, Skeleton } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { cost, fullDate, num, plainPreview, pluralize, shortTime, tokens } from "../lib/format.ts";
import { linkHandler, navigate } from "../lib/router.ts";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Overview() {
  const overview = useApp((s) => s.overview);
  const agents = useApp((s) => s.agents);
  const connectors = useApp((s) => s.connectors);
  const providers = useApp((s) => s.providers);
  const threads = useApp((s) => s.threads);
  const me = useApp((s) => s.me);
  const isAdmin = useIsAdmin();
  const activity = useAgentActivity();
  const spend = useSpendToday();

  useEffect(() => {
    void loadProviders();
  }, []);

  const realProviders = providers?.filter((p) => p.configured && p.configured.source !== "built-in").length ?? 0;
  const steps = [
    {
      done: realProviders > 0,
      title: "Connect a model provider",
      body: "Sign in with Claude Pro/Max, ChatGPT, or GitHub Copilot — or paste an API key.",
      cta: "Connect",
      icon: <KeyRound />,
      to: "/providers",
    },
    {
      done: (agents?.length ?? 0) > 1,
      title: "Create your own agent",
      body: "Give it a name, instructions, a model, and skills like memory and web.",
      cta: "Create agent",
      icon: <UserPlus />,
      to: "/agents/new",
    },
    {
      done: (connectors?.length ?? 0) > 0,
      title: "Bring agents into Slack or Discord",
      body: "Mention your agents where your team already talks. Telegram and webhooks too.",
      cta: "Add connection",
      icon: <Plug />,
      to: "/connections/new",
    },
  ];
  const loaded = providers !== null && agents !== null && connectors !== null;
  const remaining = steps.filter((s) => !s.done).length;

  let working = 0;
  let waiting = 0;
  for (const a of activity.values()) {
    if (a.presence === "working") working++;
    else if (a.presence === "approval") waiting++;
  }
  const { busyThreads, threadCounts } = useMemo(() => {
    let busy = 0;
    const counts = new Map<string, number>();
    for (const t of threads ?? []) {
      if (t.busy) busy++;
      counts.set(t.agentId, (counts.get(t.agentId) ?? 0) + 1);
    }
    return { busyThreads: busy, threadCounts: counts };
  }, [threads]);
  const name = me?.actor.kind === "user" ? me.actor.name.split(/\s+/)[0] : undefined;

  return (
    <Page>
      <PageHeader
        eyebrow="Mission control"
        title="Your agents at a glance"
        description={
          <>
            {greeting()}
            {name ? `, ${name}` : ""}. <FleetSentence agents={agents?.length ?? 0} working={working} waiting={waiting} loaded={agents !== null && threads !== null} />
          </>
        }
        actions={
          <>
            {isAdmin && (
              <Button variant="secondary" icon={<Bot />} onClick={() => navigate("/agents/new")}>
                New agent
              </Button>
            )}
            <Button variant="accent" icon={<SquarePen />} onClick={() => navigate("/chat/new")}>
              New chat
            </Button>
          </>
        }
      />

      {/* Metric strip: one card, hairline dividers. Each tile links to the page behind it. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-card sm:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Agents"
          value={overview ? num(overview.agents) : null}
          icon={<Bot />}
          to="/agents"
          sub={working > 0 ? <span className="text-accent-text">{working} working</span> : agents ? "standing by" : undefined}
        />
        <Stat
          label="Threads"
          value={overview ? num(overview.threads) : null}
          icon={<MessagesSquare />}
          to="/chat"
          sub={threads ? busyThreads > 0 ? <span className="text-accent-text">{busyThreads} running</span> : "none running" : undefined}
        />
        <Stat
          label="Connections"
          value={overview ? `${overview.connectorsConnected}/${overview.connectorsTotal}` : null}
          icon={<Plug />}
          to={isAdmin ? "/connections" : undefined}
          sub={overview ? (overview.connectorsTotal === 0 ? "none yet" : overview.connectorsConnected === overview.connectorsTotal ? "all connected" : "some offline") : undefined}
          tone={overview && overview.connectorsTotal > 0 && overview.connectorsConnected < overview.connectorsTotal ? "warning" : undefined}
        />
        <Stat
          label="Providers"
          value={providers ? num(realProviders) : null}
          icon={<KeyRound />}
          to={isAdmin ? "/providers" : undefined}
          sub={providers ? (realProviders === 0 ? "demo model only" : "connected") : undefined}
        />
        <Stat label="Messages today" value={overview ? num(overview.messagesToday) : null} icon={<MessageSquare />} to="/activity" sub={overview ? "across every channel" : undefined} />
        <Stat
          label="Total cost"
          value={overview ? cost(overview.usage.cost) : null}
          icon={<Coins />}
          to="/usage"
          sub={overview ? `${tokens(overview.usage.input + overview.usage.output + overview.usage.cacheRead + overview.usage.cacheWrite)} tokens` : undefined}
        />
      </div>

      {isAdmin && loaded && remaining > 0 && <SetupCard steps={steps} remaining={remaining} />}

      <div className="mt-10 grid gap-x-8 gap-y-10 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="min-w-0">
          <SectionHeader
            title="Fleet"
            description="Every agent and what it's doing right now."
            action={
              <a href="/agents" onClick={linkHandler("/agents")} className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-subtle transition-colors hover:text-fg">
                Manage <ArrowUpRight className="size-3.5" />
              </a>
            }
          />
          {!agents ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[178px] rounded-xl" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Bot />}
                title="No agents yet"
                description="Create an agent to start chatting."
                action={
                  isAdmin && (
                    <Button variant="primary" onClick={() => navigate("/agents/new")}>
                      Create agent
                    </Button>
                  )
                }
              />
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {agents.map((agent, i) => (
                <FleetCard
                  key={agent.id}
                  agent={agent}
                  index={i}
                  threads={threadCounts.get(agent.id) ?? 0}
                  activity={activity.get(agent.id)}
                  spend={spend?.get(agent.id)}
                />
              ))}
              {isAdmin && agents.length % 2 === 1 && (
                <a
                  href="/agents/new"
                  onClick={linkHandler("/agents/new")}
                  className="group hidden min-h-[178px] flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-border-strong text-[13px] font-medium text-subtle transition-colors hover:border-accent-line/50 hover:bg-surface/60 hover:text-fg sm:flex"
                >
                  <span className="grid size-9 place-items-center rounded-xl border border-border bg-surface-2 text-muted transition-colors group-hover:text-accent-text">
                    <Plus className="size-4" />
                  </span>
                  Add an agent to the fleet
                </a>
              )}
            </div>
          )}
        </section>

        <section className="min-w-0">
          <SectionHeader
            title={
              <span className="flex items-center gap-2">
                Live activity <LiveDot />
              </span>
            }
            description="Events as they happen."
            action={
              <a href="/activity" onClick={linkHandler("/activity")} className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-subtle transition-colors hover:text-fg">
                All activity <ArrowUpRight className="size-3.5" />
              </a>
            }
          />
          <Card className="overflow-hidden">
            <ActivityFeed limit={12} />
          </Card>
        </section>
      </div>
    </Page>
  );
}

/** "2 agents working, 1 waiting on you." — the fleet in one sentence. */
function FleetSentence({ agents, working, waiting, loaded }: { agents: number; working: number; waiting: number; loaded: boolean }) {
  if (!loaded) return null;
  if (working === 0 && waiting === 0) {
    return <span>All quiet — {agents === 1 ? "your agent is" : `${num(agents)} agents are`} standing by.</span>;
  }
  return (
    <span>
      {working > 0 && (
        <span className="font-medium text-accent-text">
          {working === 1 ? "1 agent is" : `${num(working)} agents are`} working
        </span>
      )}
      {working > 0 && waiting > 0 && ", "}
      {waiting > 0 && (
        <a href="/approvals" onClick={linkHandler("/approvals")} className="font-medium text-warning underline-offset-2 hover:underline">
          {waiting === 1 ? "1 is" : `${num(waiting)} are`} waiting on you
        </a>
      )}
      .
    </span>
  );
}

/** Spend per agent for the current UTC day, refreshed as replies land. */
function useSpendToday(): Map<string, AgentSpend> | null {
  const [spend, setSpend] = useState<Map<string, AgentSpend> | null>(null);
  const replies = useApp((s) => {
    let n = 0;
    for (const a of s.activity) if (a.type === "reply") n++;
    return n;
  });
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(
      () =>
        void client
          .spendToday()
          .then((list) => !cancelled && setSpend(new Map(list.map((s) => [s.agentId, s]))))
          .catch(() => {}),
      spend ? 1200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // Refetch when a new reply arrives; the first load runs immediately.
  }, [replies]);
  return spend;
}

/** Green while the live stream is up; amber and pulsing while it reconnects. */
export function LiveDot() {
  const status = useApp((s) => s.status);
  return (
    <span title={status === "live" ? "Live" : "Reconnecting…"} className="inline-flex">
      <Dot tone={status === "live" ? "success" : "warning"} pulse />
    </span>
  );
}

/** A number tile. With `to` it links to the page behind it; without (pages a member can't open) it's static. */
function Stat({ label, value, icon, sub, to, tone }: { label: string; value: string | null; icon: ReactNode; sub?: ReactNode; to?: string; tone?: "warning" }) {
  const Tag = to ? "a" : "div";
  return (
    <Tag
      {...(to ? { href: to, onClick: linkHandler(to) } : {})}
      className={cn("group relative flex min-w-0 flex-col bg-surface px-4 py-3.5 outline-offset-[-2px] transition-colors", to && "hover:bg-surface-2/70")}
    >
      <span className="flex items-center gap-1.5 text-[12.5px] text-subtle">
        <span className="text-faint transition-colors group-hover:text-muted [&_svg]:size-3.5">{icon}</span>
        {label}
      </span>
      {value === null ? (
        <Skeleton className="mb-1 mt-2.5 h-7 w-14" />
      ) : (
        <span className={cn("mt-1.5 text-[26px] font-semibold leading-tight tracking-[-0.03em]", tone === "warning" ? "text-warning" : "text-fg")}>{value}</span>
      )}
      <span className="mt-1 h-4 truncate font-mono text-[11px] text-faint">{sub}</span>
      {to && <ArrowUpRight className="absolute right-3 top-3.5 size-3.5 text-faint opacity-0 transition-opacity group-hover:opacity-100" />}
    </Tag>
  );
}

type Step = { done: boolean; title: string; body: string; cta: string; icon: ReactNode; to: string };

function SetupCard({ steps, remaining }: { steps: Step[]; remaining: number }) {
  const done = steps.length - remaining;
  const next = steps.findIndex((s) => !s.done);
  return (
    <Card className="lit relative mt-6 overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 hidden size-64 rounded-full bg-accent/10 blur-3xl dark:block" />
      <div className="relative flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-accent-line/25 bg-accent-soft text-accent-text">
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Get set up</h2>
            <p className="text-[12.5px] text-subtle">Three steps to a fleet that answers wherever your team works.</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-subtle">
            {done}/{steps.length} done
          </span>
          <div className="w-32 shrink-0">
            <Meter value={done} max={steps.length} label="Setup progress" />
          </div>
        </div>
      </div>
      <ol className="relative grid border-t border-border md:grid-cols-3">
        {steps.map((step, i) => {
          const isNext = i === next;
          return (
            <li key={step.title} className={cn("flex gap-3 p-5", i > 0 && "border-t border-border md:border-l md:border-t-0", step.done && "opacity-60")}>
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border font-mono text-[11.5px] font-semibold [&_svg]:size-3.5",
                  step.done
                    ? "border-success/30 bg-success-soft text-success"
                    : isNext
                      ? "border-accent-line/50 bg-accent-soft text-accent-text shadow-[0_0_14px_-4px_var(--accent-glow)]"
                      : "border-border bg-surface-2 text-subtle",
                )}
              >
                {step.done ? <Check strokeWidth={2.5} /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className={cn("text-[13.5px] font-medium text-fg", step.done && "line-through decoration-faint")}>{step.title}</h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-subtle">{step.body}</p>
                {!step.done && (
                  <Button size="sm" variant={isNext ? "primary" : "secondary"} className="mt-3" onClick={() => navigate(step.to)}>
                    {step.cta}
                    <ArrowRight />
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

const PRESENCE_PILL: Record<AgentPresence, { label: string; className: string; dot: string }> = {
  working: { label: "working", className: "border-accent-line/30 bg-accent-soft text-accent-text", dot: "bg-accent-line animate-pulse-soft shadow-[0_0_6px_var(--accent-glow)]" },
  approval: { label: "needs you", className: "border-warning/30 bg-warning-soft text-warning", dot: "bg-warning" },
  idle: { label: "idle", className: "border-border bg-surface-2/60 text-faint", dot: "bg-faint" },
};

function FleetCard({ agent, index, threads, activity, spend }: { agent: Agent; index: number; threads: number; activity?: AgentActivity; spend?: AgentSpend }) {
  const presence = activity?.presence ?? "idle";
  const pill = PRESENCE_PILL[presence];
  const thread = activity?.thread;
  const where = thread ? thread.location || thread.title || "a thread" : undefined;
  const skills = agent.skills.length + agent.mcpServers.length;
  return (
    <Card
      interactive
      className={cn(
        "group relative flex animate-rise flex-col overflow-hidden p-4",
        presence === "working" && "border-accent-line/30",
        presence === "approval" && "border-warning/35",
      )}
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      {presence !== "idle" && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent to-transparent",
            presence === "working" ? "via-accent-line" : "via-warning",
          )}
        />
      )}
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size="lg" presence={presence} className="[--presence-ring:var(--surface)]" />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-fg">{agent.name}</h3>
            {agent.isDefault && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label="Default agent" />}
          </div>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-subtle">
            @{agent.handle}
            <span className="mx-1.5 text-faint">·</span>
            {agent.model ? agent.model.modelId : "no model"}
          </p>
        </div>
        <span className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 font-mono text-[10.5px] font-medium", pill.className)}>
          <span className={cn("size-1.5 rounded-full", pill.dot)} />
          {pill.label}
        </span>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2.9em] text-[13px] leading-relaxed text-muted">{agent.description || "No description."}</p>

      <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">
          {presence !== "idle" && thread ? (
            <a
              href={`/chat/${thread.id}`}
              onClick={linkHandler(`/chat/${thread.id}`)}
              className={cn("hover:underline", presence === "working" ? "text-accent-text" : "text-warning")}
              title={presence === "working" ? `Working in ${where}` : `Waiting for approval in ${where}`}
            >
              {presence === "working" ? "▸ Working in " : "Waiting for approval · "}
              {where}
            </a>
          ) : (
            <span>
              {pluralize(threads, "thread")}
              {spend && spend.runs > 0 ? <> · {cost(spend.usd)} today</> : skills > 0 ? <> · {pluralize(skills, "skill")}</> : null}
            </span>
          )}
        </div>
        <Button size="sm" variant="secondary" icon={<MessageSquare />} onClick={() => navigate(`/chat/new/${agent.id}`)}>
          Chat
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Event stream

const ACTIVITY_STYLE: Record<ActivityItem["type"], { icon: ReactNode; className: string; label: string }> = {
  message: { icon: <MessageSquare />, className: "border-info/25 bg-info-soft text-info", label: "message" },
  reply: { icon: <Bot />, className: "border-accent-line/30 bg-accent-soft text-accent-text", label: "reply" },
  connector: { icon: <Plug />, className: "border-success/25 bg-success-soft text-success", label: "connector" },
  agent: { icon: <UserPlus />, className: "border-border-strong bg-surface-2 text-muted", label: "agent" },
  provider: { icon: <KeyRound />, className: "border-border-strong bg-surface-2 text-muted", label: "provider" },
  schedule: { icon: <AlarmClock />, className: "border-info/25 bg-info-soft text-info", label: "schedule" },
  error: { icon: <CircleAlert />, className: "border-danger/25 bg-danger-soft text-danger", label: "error" },
  approval: { icon: <ShieldCheck />, className: "border-warning/25 bg-warning-soft text-warning", label: "approval" },
  access: { icon: <Lock />, className: "border-warning/25 bg-warning-soft text-warning", label: "access" },
};

/**
 * The live event stream: a mono time column, a rail of typed markers, and what happened. Shared with the Activity
 * page, which can narrow it to some event `types`.
 */
export function ActivityFeed({ limit, className, types }: { limit?: number; className?: string; types?: readonly ActivityItem["type"][] }) {
  const activity = useApp((s) => s.activity);
  const overview = useApp((s) => s.overview);
  const agentMap = useAgentMap();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const filtered = useMemo(() => (types ? activity.filter((item) => types.includes(item.type)) : activity), [activity, types]);

  if (!overview && activity.length === 0) {
    return (
      <div className="flex flex-col gap-4 p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="mt-0.5 h-3 w-8" />
            <Skeleton className="size-[22px] rounded-md" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (filtered.length === 0) {
    return types ? (
      <EmptyState icon={<Radio />} title="Nothing here yet" description="Events of this kind show up here as they happen." />
    ) : (
      <EmptyState icon={<Radio />} title="Quiet for now" description="Messages, replies, and connector events show up here as they happen." />
    );
  }
  const items = limit ? filtered.slice(0, limit) : filtered;
  return (
    <ul className={cn("py-1.5", className)}>
      {items.map((item, i) => {
        const style = ACTIVITY_STYLE[item.type] ?? ACTIVITY_STYLE.message;
        const agent = item.agentId ? agentMap.get(item.agentId) : undefined;
        const first = i === 0;
        const last = i === items.length - 1;
        const content = (
          <>
            <time dateTime={new Date(item.at).toISOString()} title={fullDate(item.at)} className="pt-[3px] text-right font-mono text-[11px] tabular-nums text-faint">
              {shortTime(item.at)}
            </time>
            <span className="relative flex justify-center">
              {!(first && last) && (
                <span
                  aria-hidden
                  className={cn("absolute left-1/2 w-px -translate-x-1/2 bg-border-strong", first ? "-bottom-2.5 top-3" : last ? "-top-2.5 h-[22px]" : "-bottom-2.5 -top-2.5")}
                />
              )}
              <span className="relative rounded-md bg-surface">
                <span className={cn("grid size-[22px] place-items-center rounded-md border [&_svg]:size-3", style.className)}>{style.icon}</span>
              </span>
            </span>
            <span className="min-w-0">
              <span className="line-clamp-2 text-[13px] leading-snug text-fg">{plainPreview(item.text)}</span>
              <span className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-faint">
                <span className="shrink-0">{style.label}</span>
                {agent && (
                  <>
                    <span className="shrink-0">·</span>
                    <AgentAvatar agent={agent} size="xs" className="size-3.5 text-[8px]" />
                    <span className="truncate text-subtle">{agent.name}</span>
                  </>
                )}
              </span>
            </span>
          </>
        );
        const row = "grid grid-cols-[40px_22px_minmax(0,1fr)] gap-x-3 px-4 py-2.5";
        return (
          <li key={item.id} className="animate-rise" style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
            {item.threadId ? (
              <a href={`/chat/${item.threadId}`} onClick={linkHandler(`/chat/${item.threadId}`)} className={cn(row, "transition-colors hover:bg-surface-2/60")}>
                {content}
              </a>
            ) : (
              <div className={row}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
