import { useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ListFilter, LoaderCircle, MessagesSquare, Search, SquarePen, X } from "lucide-react";
import type { Source, Thread } from "@soloagent/client";
import { client } from "../../api/client.ts";
import { local, useAgentMap, useApp } from "../../api/store.ts";
import { AgentAvatar, SOURCE_LABEL, SourceIcon } from "../../components/brand.tsx";
import { MenuLabel, MenuSeparator, Popover } from "../../components/overlay.tsx";
import { EmptyState, IconButton, Skeleton } from "../../components/ui.tsx";
import { cn } from "../../lib/cn.ts";
import { plainPreview, shortTime } from "../../lib/format.ts";
import { linkHandler, navigate, type Route } from "../../lib/router.ts";
import { toast } from "../../lib/toast.ts";
import { Composer } from "./Composer.tsx";
import { Conversation } from "./Conversation.tsx";

export function Chat({ route }: { route: Extract<Route, { page: "chat" }> }) {
  const showDetail = !!route.threadId || !!route.isNew;
  return (
    <div className="flex h-full min-h-0">
      <div className={cn("min-h-0 w-full shrink-0 border-r border-border bg-bg-subtle md:flex md:w-[320px] lg:w-[340px]", showDetail ? "hidden" : "flex")}>
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

function ThreadList({ activeId }: { activeId?: string }) {
  const threads = useApp((s) => s.threads);
  const agents = useApp((s) => s.agents);
  const agentMap = useAgentMap();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterAnchor = useRef<HTMLButtonElement>(null);

  const presentSources = useMemo(() => new Set(threads?.map((t) => t.source)), [threads]);
  const filtered = useMemo(() => {
    if (!threads) return null;
    const q = query.trim().toLowerCase();
    return threads.filter((t) => {
      if (source && t.source !== source) return false;
      if (agentId && t.agentId !== agentId) return false;
      if (!q) return true;
      return `${t.title} ${t.preview} ${t.location ?? ""} ${agentMap.get(t.agentId)?.name ?? ""}`.toLowerCase().includes(q);
    });
  }, [threads, query, source, agentId, agentMap]);

  const filterCount = (source ? 1 : 0) + (agentId ? 1 : 0);

  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <h1 className="text-[15px] font-semibold tracking-tight text-fg">Chats</h1>
        <IconButton label="New chat" onClick={() => navigate("/chat/new")}>
          <SquarePen className="size-4" />
        </IconButton>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
            className="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-7 text-[13px] text-fg outline-none transition-[border-color,box-shadow] focus:border-accent/60 focus:ring-3 focus:ring-accent/15"
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
          title="Filter by source or agent"
          className={cn(
            "relative grid size-8 shrink-0 place-items-center rounded-lg border transition-colors",
            filterCount ? "border-accent/40 bg-accent-soft text-accent-text" : "border-border bg-surface text-subtle hover:text-fg",
          )}
        >
          <ListFilter className="size-4" />
          {filterCount > 0 && <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-accent text-[9.5px] font-semibold text-white">{filterCount}</span>}
        </button>
        <Popover open={filterOpen} onClose={() => setFilterOpen(false)} anchor={filterAnchor} align="end" className="w-60">
          <div className="max-h-[60vh] overflow-y-auto">
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
          {source && <FilterChip onClear={() => setSource(null)} icon={<SourceIcon source={source} className="size-3" />} label={SOURCE_LABEL[source]} />}
          {agentId && <FilterChip onClear={() => setAgentId(null)} icon={<AgentAvatar agent={agentMap.get(agentId)} size="xs" />} label={agentMap.get(agentId)?.name ?? "Agent"} />}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!filtered ? (
          <div className="flex flex-col gap-1 px-1 pt-1">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex gap-3 px-2 py-2.5">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex-1 space-y-2">
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
                <button type="button" onClick={() => navigate("/chat/new")} className="text-[13px] font-medium text-accent-text hover:underline">
                  Start a chat →
                </button>
              }
            />
          ) : (
            <p className="px-4 py-10 text-center text-[13px] text-subtle">No threads match.</p>
          )
        ) : (
          <ul className="flex flex-col gap-px">
            {filtered.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} active={thread.id === activeId} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterOption({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-surface-2">
      <span className="grid w-4 place-items-center">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {active && <Check className="size-3.5 text-accent-text" />}
    </button>
  );
}

function FilterChip({ label, icon, onClear }: { label: string; icon: React.ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-surface pl-1.5 pr-0.5 text-[12px] text-muted">
      {icon}
      {label}
      <button type="button" aria-label={`Remove ${label} filter`} onClick={onClear} className="grid size-5 place-items-center rounded text-faint hover:text-fg">
        <X className="size-3" />
      </button>
    </span>
  );
}

function ThreadRow({ thread, active }: { thread: Thread; active: boolean }) {
  const agent = useAgentMap().get(thread.agentId);
  const href = `/chat/${thread.id}`;
  return (
    <li>
      <a
        href={href}
        onClick={linkHandler(href)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group flex gap-3 rounded-lg px-2.5 py-2.5 transition-colors",
          active ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-surface-2/60",
        )}
      >
        <div className="relative shrink-0">
          <AgentAvatar agent={agent} size="md" />
          <span className="absolute -bottom-1 -right-1 grid size-[18px] place-items-center rounded-full border-2 border-bg-subtle bg-surface-2">
            <SourceIcon source={thread.source} className="size-2.5" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", active ? "font-semibold text-fg" : "font-medium text-fg")}>{thread.title || "Untitled"}</span>
            {thread.busy ? (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent-text" aria-label="Working" />
            ) : (
              <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{shortTime(thread.updatedAt)}</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-subtle">
            {thread.location && <span className="text-muted">{thread.location} · </span>}
            {thread.busy && !thread.preview ? <span className="text-accent-text">Thinking…</span> : plainPreview(thread.preview) || <span className="text-faint">No messages yet</span>}
          </p>
        </div>
      </a>
    </li>
  );
}

// ---------------------------------------------------------------------------
// New chat

const SUGGESTIONS = ["What can you help me with?", "Draft a short project update for my team", "Explain how soloagent works", "Remind me tomorrow at 9am to review PRs"];

function NewChat({ agentId }: { agentId?: string }) {
  const agents = useApp((s) => s.agents);
  const fallback = agents?.find((a) => a.isDefault) ?? agents?.[0];
  const [picked, setPicked] = useState<string | undefined>(agentId);
  const agent = agents?.find((a) => a.id === (picked ?? agentId)) ?? fallback;
  const [sending, setSending] = useState(false);

  const start = async (text: string) => {
    if (!agent) return false;
    setSending(true);
    try {
      const thread = await client.createThread({ agentId: agent.id, source: "web" });
      local.thread(thread);
      await client.send(thread.id, text, { source: "web" });
      navigate(`/chat/${thread.id}`, { replace: true });
      return true;
    } catch (error) {
      toast.error(error, "Could not start the chat");
      setSending(false);
      return false;
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5 md:border-transparent">
        <a href="/chat" onClick={linkHandler("/chat")} aria-label="Back to threads" className="grid size-8 place-items-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg md:hidden">
          <ArrowLeft className="size-4" />
        </a>
        <span className="text-[14px] font-semibold text-fg md:hidden">New chat</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-5 py-10">
          {!agents ? (
            <div className="flex flex-col items-center gap-4">
              <Skeleton className="size-14 rounded-2xl" />
              <Skeleton className="h-6 w-48" />
            </div>
          ) : !agent ? (
            <EmptyState icon={<MessagesSquare />} title="No agents yet" description="Create an agent first, then come back to chat." action={<button type="button" className="text-[13px] font-medium text-accent-text hover:underline" onClick={() => navigate("/agents/new")}>Create an agent →</button>} />
          ) : (
            <div className="flex animate-fade-in flex-col items-center text-center">
              <div className="relative">
                <div className="absolute inset-0 rounded-2xl blur-2xl" style={{ background: `color-mix(in srgb, ${agent.color} 35%, transparent)` }} />
                <AgentAvatar agent={agent} size="xl" className="relative" />
              </div>
              <h2 className="mt-5 text-[22px] font-semibold tracking-[-0.02em] text-fg">Chat with {agent.name}</h2>
              <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-subtle">{agent.description || `@${agent.handle} is ready when you are.`}</p>
              <p className="mt-2 font-mono text-[11.5px] text-faint">
                @{agent.handle} · {agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "no model selected"}
              </p>

              {agents.length > 1 && (
                <div className="mt-6 flex max-w-full flex-wrap justify-center gap-1.5">
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setPicked(a.id)}
                      aria-pressed={a.id === agent.id}
                      className={cn(
                        "flex h-8 items-center gap-2 rounded-full border pl-1 pr-3 text-[12.5px] font-medium transition-colors",
                        a.id === agent.id ? "border-accent/50 bg-accent-soft text-fg" : "border-border bg-surface text-muted hover:border-border-strong hover:text-fg",
                      )}
                    >
                      <AgentAvatar agent={a} size="sm" className="rounded-full" />
                      {a.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={sending}
                    onClick={() => void start(s)}
                    className="rounded-xl border border-border bg-surface px-3.5 py-3 text-left text-[13px] text-muted shadow-sm transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                  >
                    {s}
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
        onSend={(text) => start(text)}
        onSwitchAgent={(id) => setPicked(id)}
        autoFocus
      />
    </div>
  );
}
