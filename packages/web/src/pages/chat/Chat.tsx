import { memo, useMemo, useRef, useState } from "react";
import { AlarmClock, ArrowLeft, ArrowUpRight, BookOpen, Check, FileText, ListFilter, MessagesSquare, Search, ShieldAlert, Sparkles, SquarePen, X } from "lucide-react";
import type { Agent, Source, Thread } from "@soloagent/client";
import { startChat } from "../../api/actions.ts";
import { useAgentActivity, useAgentMap, useApp } from "../../api/store.ts";
import { AgentAvatar, SOURCE_LABEL, SourceIcon } from "../../components/brand.tsx";
import { MenuLabel, MenuSeparator, Popover } from "../../components/overlay.tsx";
import { Button, EmptyState, IconButton, Skeleton } from "../../components/ui.tsx";
import { cn } from "../../lib/cn.ts";
import { plainPreview, shortTime } from "../../lib/format.ts";
import { linkHandler, navigate, type Route } from "../../lib/router.ts";
import { Composer } from "./Composer.tsx";
import { Conversation } from "./Conversation.tsx";

export function Chat({ route }: { route: Extract<Route, { page: "chat" }> }) {
  const showDetail = !!route.threadId || !!route.isNew;
  return (
    <div className="flex h-full min-h-0">
      <div className={cn("min-h-0 w-full shrink-0 border-r border-border bg-bg-subtle md:flex md:w-[304px] lg:w-[328px]", showDetail ? "hidden" : "flex")}>
        <ThreadList activeId={route.threadId} />
      </div>
      <div className={cn("min-h-0 min-w-0 flex-1", showDetail ? "flex flex-col" : "hidden md:flex md:flex-col")}>
        {route.threadId ? <Conversation key={route.threadId} threadId={route.threadId} /> : <NewChat key={route.agentId ?? "default"} agentId={route.agentId} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread list

const FILTER_SOURCES: Source[] = ["web", "slack", "discord", "telegram", "webhook", "tui", "api", "schedule", "agent"];
type StatusFilter = "working" | "approval";

/** Recency buckets for the list, newest first. */
function bucket(at: number, t0: number): string {
  if (at >= t0) return "Today";
  if (at >= t0 - 86_400_000) return "Yesterday";
  if (at >= t0 - 6 * 86_400_000) return "Previous 7 days";
  if (at >= t0 - 29 * 86_400_000) return "Previous 30 days";
  return "Older";
}

function ThreadList({ activeId }: { activeId?: string }) {
  const threads = useApp((s) => s.threads);
  const agents = useApp((s) => s.agents);
  const agentMap = useAgentMap();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterAnchor = useRef<HTMLButtonElement>(null);

  const { presentSources, live, waiting } = useMemo(() => {
    const sources = new Set<Source>();
    let liveCount = 0;
    let waitingCount = 0;
    for (const t of threads ?? []) {
      sources.add(t.source);
      if (t.waitingApproval) waitingCount++;
      else if (t.busy) liveCount++;
    }
    return { presentSources: sources, live: liveCount, waiting: waitingCount };
  }, [threads]);
  const filtered = useMemo(() => {
    if (!threads) return null;
    const q = query.trim().toLowerCase();
    return threads.filter((t) => {
      if (source && t.source !== source) return false;
      if (agentId && t.agentId !== agentId) return false;
      if (status === "working" && !(t.busy && !t.waitingApproval)) return false;
      if (status === "approval" && !t.waitingApproval) return false;
      if (!q) return true;
      return `${t.title} ${t.preview} ${t.location ?? ""} ${agentMap.get(t.agentId)?.name ?? ""}`.toLowerCase().includes(q);
    });
  }, [threads, query, source, agentId, status, agentMap]);

  const groups = useMemo(() => {
    if (!filtered) return [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const t0 = today.getTime();
    const out: { label: string; threads: Thread[] }[] = [];
    for (const thread of filtered) {
      const label = bucket(thread.updatedAt, t0);
      const last = out[out.length - 1];
      if (last?.label === label) last.threads.push(thread);
      else out.push({ label, threads: [thread] });
    }
    return out;
  }, [filtered]);

  const filterCount = (source ? 1 : 0) + (agentId ? 1 : 0) + (status ? 1 : 0);

  return (
    <div className="flex min-h-0 w-full flex-col [--presence-ring:var(--bg-subtle)]">
      <div className="flex h-14 shrink-0 items-center justify-between pl-4 pr-2.5">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[15px] font-semibold tracking-[-0.015em] text-fg">Chats</h1>
          {threads && threads.length > 0 && <span className="font-mono text-[11px] tabular-nums text-faint">{threads.length}</span>}
        </div>
        <div className="flex items-center gap-1">
          {(live > 0 || waiting > 0) && (
            <button
              type="button"
              onClick={() => setStatus((s) => (s ? null : waiting > 0 ? "approval" : "working"))}
              title={status ? "Show all chats" : waiting > 0 ? "Show chats waiting for approval" : "Show chats with an agent at work"}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-full border px-2 font-mono text-[10.5px] transition-colors",
                waiting > 0 ? "border-warning/25 bg-warning-soft text-warning" : "border-accent-line/25 bg-accent-soft text-accent-text",
              )}
            >
              {waiting > 0 ? <ShieldAlert className="size-3" /> : <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-line" />}
              {waiting > 0 ? `${waiting} waiting` : `${live} live`}
            </button>
          )}
          <IconButton label="New chat" onClick={() => navigate("/chat/new")}>
            <SquarePen className="size-4" />
          </IconButton>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search threads"
            className="h-8 w-full rounded-lg border border-border bg-field pl-8 pr-7 text-[13px] text-fg shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-faint hover:border-border-strong focus:border-accent-line/60 focus:ring-[3px] focus:ring-focus"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-faint hover:text-fg">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <button
          ref={filterAnchor}
          type="button"
          onClick={() => setFilterOpen((o) => !o)}
          aria-label="Filter threads"
          title="Filter by status, source, or agent"
          className={cn(
            "relative grid size-8 shrink-0 place-items-center rounded-lg border shadow-xs transition-colors",
            filterCount ? "border-accent-line/40 bg-accent-soft text-accent-text" : "border-border bg-field text-subtle hover:border-border-strong hover:text-fg",
          )}
        >
          <ListFilter className="size-4" />
          {filterCount > 0 && (
            <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-accent font-mono text-[9.5px] font-semibold text-accent-fg">{filterCount}</span>
          )}
        </button>
        <Popover open={filterOpen} onClose={() => setFilterOpen(false)} anchor={filterAnchor} align="end" className="w-60">
          <div className="max-h-[60vh] overflow-y-auto">
            <MenuLabel>Status</MenuLabel>
            <FilterOption active={!status} onClick={() => setStatus(null)}>
              Any status
            </FilterOption>
            <FilterOption active={status === "working"} onClick={() => setStatus(status === "working" ? null : "working")} icon={<span className="size-1.5 rounded-full bg-accent-line" />}>
              Agent working
            </FilterOption>
            <FilterOption active={status === "approval"} onClick={() => setStatus(status === "approval" ? null : "approval")} icon={<ShieldAlert className="size-3.5 text-warning" />}>
              Needs approval
            </FilterOption>
            <MenuSeparator />
            <MenuLabel>Source</MenuLabel>
            <FilterOption active={!source} onClick={() => setSource(null)}>
              All sources
            </FilterOption>
            {FILTER_SOURCES.filter((s) => presentSources.has(s) || s === source || ["web", "slack", "discord", "telegram", "webhook"].includes(s)).map((s) => (
              <FilterOption key={s} active={source === s} onClick={() => setSource(source === s ? null : s)} icon={<SourceIcon source={s} />}>
                {SOURCE_LABEL[s]}
              </FilterOption>
            ))}
            <MenuSeparator />
            <MenuLabel>Agent</MenuLabel>
            <FilterOption active={!agentId} onClick={() => setAgentId(null)}>
              All agents
            </FilterOption>
            {(agents ?? []).map((a) => (
              <FilterOption key={a.id} active={agentId === a.id} onClick={() => setAgentId(agentId === a.id ? null : a.id)} icon={<AgentAvatar agent={a} size="xs" />}>
                {a.name}
              </FilterOption>
            ))}
          </div>
        </Popover>
      </div>
      {filterCount > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {status && (
            <FilterChip
              onClear={() => setStatus(null)}
              icon={status === "approval" ? <ShieldAlert className="size-3 text-warning" /> : <span className="size-1.5 rounded-full bg-accent-line" />}
              label={status === "approval" ? "Needs approval" : "Agent working"}
            />
          )}
          {source && <FilterChip onClear={() => setSource(null)} icon={<SourceIcon source={source} className="size-3" />} label={SOURCE_LABEL[source]} />}
          {agentId && <FilterChip onClear={() => setAgentId(null)} icon={<AgentAvatar agent={agentMap.get(agentId)} size="xs" />} label={agentMap.get(agentId)?.name ?? "Agent"} />}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!filtered ? (
          <div className="flex flex-col gap-1 px-1 pt-2">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex gap-3 px-2 py-2.5">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex-1 space-y-2 pt-0.5">
                  <Skeleton className="h-3.5 w-3/5" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          threads && threads.length === 0 ? (
            <EmptyState
              icon={<MessagesSquare />}
              title="No conversations yet"
              description="Start a chat here, or mention an agent in Slack or Discord."
              action={
                <Button variant="accent" size="sm" icon={<SquarePen />} onClick={() => navigate("/chat/new")}>
                  Start a chat
                </Button>
              }
            />
          ) : (
            <div className="px-4 py-12 text-center">
              <p className="text-[13px] text-subtle">No chats match.</p>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setSource(null);
                  setAgentId(null);
                  setStatus(null);
                }}
                className="mt-2 text-[12.5px] font-medium text-accent-text hover:underline"
              >
                Clear filters
              </button>
            </div>
          )
        ) : (
          groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h2 className="label-mono px-2.5 pb-1.5 pt-3 text-faint first:pt-1">{group.label}</h2>
              <ul className="flex flex-col gap-px">
                {group.threads.map((thread) => (
                  <ThreadRow key={thread.id} thread={thread} agent={agentMap.get(thread.agentId)} active={thread.id === activeId} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function FilterOption({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-fg transition-colors hover:bg-surface-2">
      <span className="grid w-4 place-items-center">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {active && <Check className="size-3.5 text-accent-text" />}
    </button>
  );
}

function FilterChip({ label, icon, onClear }: { label: string; icon: React.ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-surface pl-1.5 pr-0.5 text-[12px] text-muted shadow-xs">
      {icon}
      {label}
      <button type="button" aria-label={`Remove ${label} filter`} onClick={onClear} className="grid size-5 place-items-center rounded text-faint hover:text-fg">
        <X className="size-3" />
      </button>
    </span>
  );
}

const ThreadRow = memo(function ThreadRow({ thread, agent, active }: { thread: Thread; agent: Agent | undefined; active: boolean }) {
  const href = `/chat/${thread.id}`;
  const preview = plainPreview(thread.preview);
  const working = thread.busy && !thread.waitingApproval;
  return (
    <li>
      <a
        href={href}
        onClick={linkHandler(href)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex gap-3 rounded-xl px-2.5 py-2.5 transition-colors",
          active ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] [--presence-ring:var(--surface-2)]" : "hover:bg-surface-2/50",
        )}
      >
        <AgentAvatar agent={agent} size="md" presence={thread.waitingApproval ? "approval" : working ? "working" : undefined} className="mt-px" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", active ? "font-semibold text-fg" : "font-medium text-fg")}>{thread.title || "Untitled"}</span>
            {thread.waitingApproval ? (
              <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-label="Waiting for approval" />
            ) : working ? (
              <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-accent-text" aria-label="Working">
                <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-line shadow-[0_0_6px_var(--accent-glow)]" />
                live
              </span>
            ) : (
              <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">{shortTime(thread.updatedAt)}</span>
            )}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-subtle">
            {/* Web is the default; threads from elsewhere (Slack, Discord, the terminal…) show where they came from. */}
            {thread.source !== "web" && (
              <span title={SOURCE_LABEL[thread.source]} className="shrink-0">
                <SourceIcon source={thread.source} className="size-3" />
              </span>
            )}
            {thread.location && thread.location !== thread.title && (
              <>
                <span className="max-w-[45%] shrink-0 truncate text-muted">{thread.location}</span>
                <span className="shrink-0 text-faint">·</span>
              </>
            )}
            <span className="min-w-0 truncate">
              {thread.waitingApproval ? (
                <span className="text-warning">Waiting for approval</span>
              ) : working && !preview ? (
                <span className="shimmer-text">Thinking…</span>
              ) : (
                preview || <span className="text-faint">No messages yet</span>
              )}
            </span>
          </p>
        </div>
      </a>
    </li>
  );
});

// ---------------------------------------------------------------------------
// New chat

const SUGGESTIONS = [
  { icon: Sparkles, text: "What can you help me with?" },
  { icon: FileText, text: "Draft a short project update for my team" },
  { icon: BookOpen, text: "Explain how soloagent works" },
  { icon: AlarmClock, text: "Remind me tomorrow at 9am to review PRs" },
];

function NewChat({ agentId }: { agentId?: string }) {
  const agents = useApp((s) => s.agents);
  const activity = useAgentActivity();
  const fallback = agents?.find((a) => a.isDefault) ?? agents?.[0];
  const [picked, setPicked] = useState<string | undefined>(agentId);
  const agent = agents?.find((a) => a.id === (picked ?? agentId)) ?? fallback;
  const [sending, setSending] = useState(false);

  const start = async (text: string, files: File[] = []) => {
    if (!agent) return false;
    setSending(true);
    const threadId = await startChat(agent.id, text, files);
    if (threadId) {
      navigate(`/chat/${threadId}`, { replace: true });
      return true;
    }
    // The message stays in the composer to retry.
    setSending(false);
    return false;
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 md:hidden">
        <a href="/chat" onClick={linkHandler("/chat")} aria-label="Back to threads" className="grid size-8 place-items-center rounded-lg text-subtle hover:bg-surface-2 hover:text-fg">
          <ArrowLeft className="size-4" />
        </a>
        <span className="text-[14px] font-semibold text-fg">New chat</span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div aria-hidden className="bg-dots mask-radial pointer-events-none absolute inset-x-0 top-0 h-[460px]" />
        <div className="relative mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-5 py-10">
          {!agents ? (
            <div className="flex flex-col items-center gap-4">
              <Skeleton className="size-14 rounded-2xl" />
              <Skeleton className="h-7 w-56" />
              <Skeleton className="h-4 w-72" />
            </div>
          ) : !agent ? (
            <EmptyState
              icon={<MessagesSquare />}
              title="No agents yet"
              description="Create an agent first, then come back to chat."
              action={
                <Button variant="primary" size="sm" onClick={() => navigate("/agents/new")}>
                  Create an agent
                </Button>
              }
            />
          ) : (
            <div key={agent.id} className="flex animate-rise flex-col items-center text-center">
              <div className="relative">
                <div aria-hidden className="absolute inset-0 -z-10 scale-[1.9] rounded-full opacity-30 blur-2xl" style={{ background: agent.color }} />
                <AgentAvatar agent={agent} size="xl" presence={activity.get(agent.id)?.presence} className="[--presence-ring:var(--panel)]" />
              </div>
              <p className="label-mono mt-6 text-faint">New conversation</p>
              <h2 className="mt-2 text-balance text-[26px] font-semibold leading-tight tracking-[-0.03em] text-fg">Chat with {agent.name}</h2>
              <p className="mt-2 max-w-md text-balance text-[14px] leading-relaxed text-subtle">{agent.description || `@${agent.handle} is ready when you are.`}</p>
              <p className="mt-3 flex items-center gap-2 font-mono text-[11.5px] text-faint">
                <span className={cn("size-1.5 rounded-full", agent.model ? "bg-success" : "bg-warning")} />
                @{agent.handle} · {agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "no model selected"}
              </p>

              {agents.length > 1 && (
                <div className="mt-7 flex max-w-full flex-wrap justify-center gap-1.5 [--presence-ring:var(--panel)]">
                  {agents.map((a) => {
                    const selected = a.id === agent.id;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setPicked(a.id)}
                        aria-pressed={selected}
                        className={cn(
                          "flex h-8 items-center gap-2 rounded-full border pl-1 pr-3 text-[12.5px] font-medium transition-colors",
                          selected ? "border-border-strong bg-surface-3 text-fg shadow-xs" : "border-border bg-surface/70 text-muted hover:border-border-strong hover:text-fg",
                        )}
                      >
                        <AgentAvatar agent={a} size="sm" presence={activity.get(a.id)?.presence} />
                        {a.name}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map(({ icon: Icon, text }) => (
                  <button
                    key={text}
                    type="button"
                    disabled={sending}
                    onClick={() => void start(text)}
                    className="group flex items-center gap-3 rounded-xl border border-border bg-surface/80 p-3 text-left shadow-xs transition-[border-color,background-color] hover:border-border-strong hover:bg-surface-2 disabled:opacity-50"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-subtle ring-1 ring-border transition-colors group-hover:text-accent-text">
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1 text-[13px] leading-snug text-muted transition-colors group-hover:text-fg">{text}</span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <Composer
        draftKey={`new:${agent?.id ?? ""}`}
        agent={agent}
        busy={false}
        disabled={!agent || sending}
        onSend={(text, _mode, files) => start(text, files)}
        onSwitchAgent={(id) => setPicked(id)}
        autoFocus
      />
    </div>
  );
}
