import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  CircleAlert,
  CircleCheck,
  Coins,
  KeyRound,
  MessageSquare,
  MessagesSquare,
  Plug,
  Radio,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Star,
  UserPlus,
} from "lucide-react";
import type { ActivityItem, Agent } from "@soloagent/client";
import { loadProviders, useAgentMap, useApp, useIsAdmin } from "../api/store.ts";
import { AgentAvatar } from "../components/brand.tsx";
import { Badge, Button, Card, Dot, EmptyState, Page, SectionHeader, Skeleton } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { cost, num, plainPreview, shortTime, tokens } from "../lib/format.ts";
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
  const isAdmin = useIsAdmin();

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

  return (
    <Page wide>
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[13px] font-medium text-subtle">{greeting()}</p>
          <h1 className="font-display mt-1 text-[30px] font-semibold text-fg">Your agents at a glance</h1>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <Button variant="secondary" icon={<Bot className="size-4" />} onClick={() => navigate("/agents/new")}>
              New agent
            </Button>
          )}
          <Button variant="primary" icon={<SquarePen className="size-4" />} onClick={() => navigate("/chat/new")}>
            New chat
          </Button>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Agents" value={overview ? num(overview.agents) : null} icon={<Bot />} to="/agents" />
        <Stat label="Threads" value={overview ? num(overview.threads) : null} icon={<MessagesSquare />} to="/chat" sub={threads ? `${threads.filter((t) => t.busy).length} active` : undefined} />
        <Stat
          label="Connections"
          value={overview ? `${overview.connectorsConnected}/${overview.connectorsTotal}` : null}
          icon={<Plug />}
          to="/connections"
          sub={overview ? (overview.connectorsTotal === 0 ? "none yet" : overview.connectorsConnected === overview.connectorsTotal ? "all connected" : "some offline") : undefined}
          tone={overview && overview.connectorsTotal > 0 && overview.connectorsConnected < overview.connectorsTotal ? "warning" : undefined}
        />
        <Stat
          label="Providers"
          value={providers ? num(realProviders) : null}
          icon={<KeyRound />}
          to="/providers"
          sub={providers && realProviders === 0 ? "demo model only" : "connected"}
        />
        <Stat label="Messages today" value={overview ? num(overview.messagesToday) : null} icon={<MessageSquare />} to="/activity" />
        <Stat
          label="Total cost"
          value={overview ? cost(overview.usage.cost) : null}
          icon={<Coins />}
          to="/usage"
          sub={overview ? `${tokens(overview.usage.input + overview.usage.output + overview.usage.cacheRead + overview.usage.cacheWrite)} tokens` : undefined}
        />
      </div>

      {isAdmin && loaded && remaining > 0 && (
        <Card className="relative mt-6 overflow-hidden">
          <div className="relative flex flex-col gap-1 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <Sparkles className="size-4 text-accent-text" />
              <h2 className="text-[14px] font-semibold text-fg">Get set up</h2>
              <Badge tone="accent">
                {steps.length - remaining} of {steps.length}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${((steps.length - remaining) / steps.length) * 100}%` }} />
              </div>
            </div>
          </div>
          <div className="relative grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
            {steps.map((step, i) => (
              <div key={step.title} className={cn("flex gap-3 p-5", step.done && "opacity-60")}>
                <div
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-full border text-[12px] font-semibold [&_svg]:size-4",
                    step.done ? "border-success/30 bg-success-soft text-success" : "border-border bg-surface-2 text-muted",
                  )}
                >
                  {step.done ? <CircleCheck /> : i + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className={cn("text-[13.5px] font-medium text-fg", step.done && "line-through decoration-faint")}>{step.title}</h3>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-subtle">{step.body}</p>
                  {!step.done && (
                    <Button size="sm" variant={steps.findIndex((s) => !s.done) === i ? "primary" : "secondary"} className="mt-3" onClick={() => navigate(step.to)}>
                      {step.cta}
                      <ArrowRight className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section>
          <SectionHeader
            title="Agents"
            description="Start a conversation with any of them."
            action={
              <a href="/agents" onClick={linkHandler("/agents")} className="flex items-center gap-1 text-[12.5px] font-medium text-subtle hover:text-fg">
                Manage <ArrowUpRight className="size-3.5" />
              </a>
            }
          />
          {!agents ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-[132px] rounded-xl" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <Card>
              <EmptyState icon={<Bot />} title="No agents yet" description="Create an agent to start chatting." action={<Button variant="primary" onClick={() => navigate("/agents/new")}>Create agent</Button>} />
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {agents.map((agent) => (
                <AgentQuickCard key={agent.id} agent={agent} threads={threads?.filter((t) => t.agentId === agent.id).length ?? 0} busy={threads?.some((t) => t.agentId === agent.id && t.busy) ?? false} />
              ))}
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
            action={
              <a href="/activity" onClick={linkHandler("/activity")} className="flex items-center gap-1 text-[12.5px] font-medium text-subtle hover:text-fg">
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

/** Green while the live stream is up; amber and pulsing while it reconnects. */
export function LiveDot() {
  const status = useApp((s) => s.status);
  return (
    <span title={status === "live" ? "Live" : "Reconnecting…"} className="inline-flex">
      <Dot tone={status === "live" ? "success" : "warning"} pulse />
    </span>
  );
}

function Stat({ label, value, icon, sub, to, tone }: { label: string; value: string | null; icon: ReactNode; sub?: string; to: string; tone?: "warning" }) {
  return (
    <a
      href={to}
      onClick={linkHandler(to)}
      className="group relative flex flex-col rounded-xl border border-border bg-surface p-4 shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-border-strong hover:shadow-md"
    >
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-subtle">{label}</span>
        <span className="text-faint transition-colors group-hover:text-accent-text [&_svg]:size-4">{icon}</span>
      </div>
      {value === null ? (
        <Skeleton className="mt-3 h-7 w-16" />
      ) : (
        <span className={cn("mt-2 text-[24px] font-semibold tabular-nums tracking-[-0.02em]", tone === "warning" ? "text-warning" : "text-fg")}>{value}</span>
      )}
      <span className="mt-0.5 h-4 truncate text-[12px] text-faint">{sub}</span>
    </a>
  );
}

function AgentQuickCard({ agent, threads, busy }: { agent: Agent; threads: number; busy: boolean }) {
  return (
    <Card interactive className="group flex flex-col p-4">
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[14px] font-semibold text-fg">{agent.name}</h3>
            {agent.isDefault && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label="Default agent" />}
            {busy && <Dot tone="accent" pulse className="ml-0.5" />}
          </div>
          <p className="truncate font-mono text-[12px] text-subtle">
            @{agent.handle}
            <span className="mx-1.5 text-faint">·</span>
            {agent.model ? agent.model.modelId : "no model"}
          </p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 min-h-[3.25em] text-[12.5px] leading-relaxed text-muted">{agent.description || "No description."}</p>
      <div className="mt-auto flex items-center justify-between pt-3">
        <span className="text-[12px] text-faint">{threads === 1 ? "1 thread" : `${threads} threads`}</span>
        <Button size="sm" variant="secondary" icon={<MessageSquare className="size-3.5" />} onClick={() => navigate(`/chat/new/${agent.id}`)}>
          Chat
        </Button>
      </div>
    </Card>
  );
}

const ACTIVITY_ICON: Record<ActivityItem["type"], { icon: ReactNode; className: string }> = {
  message: { icon: <MessageSquare />, className: "text-info bg-info-soft" },
  reply: { icon: <Bot />, className: "text-accent-text bg-accent-soft" },
  connector: { icon: <Plug />, className: "text-success bg-success-soft" },
  agent: { icon: <UserPlus />, className: "text-accent-text bg-accent-soft" },
  provider: { icon: <KeyRound />, className: "text-warning bg-warning-soft" },
  schedule: { icon: <Radio />, className: "text-info bg-info-soft" },
  error: { icon: <CircleAlert />, className: "text-danger bg-danger-soft" },
  approval: { icon: <ShieldCheck />, className: "text-warning bg-warning-soft" },
  access: { icon: <ShieldCheck />, className: "text-warning bg-warning-soft" },
};

/** Live activity list. Shared with the Activity page. */
export function ActivityFeed({ limit, className }: { limit?: number; className?: string }) {
  const activity = useApp((s) => s.activity);
  const overview = useApp((s) => s.overview);
  const agentMap = useAgentMap();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!overview && activity.length === 0) {
    return (
      <div className="flex flex-col gap-3 p-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-7 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (activity.length === 0) {
    return <EmptyState icon={<Radio />} title="Quiet for now" description="Messages, replies, and connector events show up here as they happen." />;
  }
  const items = limit ? activity.slice(0, limit) : activity;
  return (
    <ul className={cn("divide-y divide-border", className)}>
      {items.map((item) => {
        const style = ACTIVITY_ICON[item.type] ?? ACTIVITY_ICON.message;
        const agent = item.agentId ? agentMap.get(item.agentId) : undefined;
        const content = (
          <>
            <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-3.5", style.className)}>{style.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[13px] leading-snug text-fg">{plainPreview(item.text)}</p>
              <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-faint">
                {agent && (
                  <>
                    <AgentAvatar agent={agent} size="xs" />
                    <span className="text-subtle">{agent.name}</span>
                    <span>·</span>
                  </>
                )}
                <span className="capitalize">{item.type}</span>
                <span>·</span>
                <span>{shortTime(item.at)}</span>
              </p>
            </div>
          </>
        );
        return (
          <li key={item.id} className="animate-fade-in">
            {item.threadId ? (
              <a href={`/chat/${item.threadId}`} onClick={linkHandler(`/chat/${item.threadId}`)} className="flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60">
                {content}
              </a>
            ) : (
              <div className="flex gap-3 px-4 py-3">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
