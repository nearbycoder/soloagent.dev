import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, Copy, Ellipsis, LoaderCircle, MessageSquareDashed, Minimize2, Pencil, RotateCcw, ShieldAlert, Trash } from "lucide-react";
import type { Agent, LiveState, Message, Thread } from "@soloagent/client";
import { emptyLive } from "@soloagent/client";
import { client } from "../../api/client.ts";
import { local, useAgentMap, useApp } from "../../api/store.ts";
import { AgentAvatar, SourceBadge } from "../../components/brand.tsx";
import { MenuItem, MenuSeparator, Popover } from "../../components/overlay.tsx";
import { Button, EmptyState, IconButton, Skeleton } from "../../components/ui.tsx";
import { copyText } from "../../lib/clipboard.ts";
import { cn } from "../../lib/cn.ts";
import { dayLabel } from "../../lib/format.ts";
import { toUploads } from "../../lib/files.ts";
import { linkHandler, navigate } from "../../lib/router.ts";
import { confirm, toast } from "../../lib/toast.ts";
import { Composer } from "./Composer.tsx";
import { DayDivider, EventNotice, FailureNotice, RetryNotice, RunView, UserBubble, type EventMessage, type RunItem, type ToolMessage } from "./Messages.tsx";
import { useThread } from "./useThread.ts";

type UserMessage = Extract<Message, { kind: "user" }>;
type RunEntry = { kind: "run"; key: string; agentId: string; items: RunItem[]; head: boolean; trailing: EventMessage[] };
type Entry = { kind: "user"; key: string; message: UserMessage; first: boolean } | { kind: "event"; key: string; message: EventMessage } | { kind: "day"; key: string; label: string } | RunEntry;

/** Runs that don't need live state get this one, so they stay memoized while another run streams. */
const IDLE_LIVE: LiveState = emptyLive();

export function Conversation({ threadId }: { threadId: string }) {
  const view = useThread(threadId);
  const agentMap = useAgentMap();
  const storeThread = useApp((s) => s.threads?.find((t) => t.id === threadId));
  // Prefer whichever copy of the thread is fresher: the list (broadcast) or the subscription.
  const thread = storeThread && view.thread ? (storeThread.updatedAt >= view.thread.updatedAt ? storeThread : view.thread) : (storeThread ?? view.thread);
  const agent = thread ? agentMap.get(thread.agentId) : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const prependFrom = useRef<number | null>(null);
  const initialScroll = useRef(false);

  // Pair tool results with the assistant tool calls that made them.
  const { results, paired, shownCalls } = useMemo(() => {
    const results = new Map<string, ToolMessage>();
    for (const m of view.messages) if (m.kind === "tool") results.set(m.callId, m);
    const paired = new Set<string>();
    const shownCalls = new Set<string>();
    for (const m of view.messages)
      if (m.kind === "assistant")
        for (const c of m.toolCalls) {
          shownCalls.add(c.id);
          if (results.has(c.id)) paired.add(c.id);
        }
    return { results, paired, shownCalls };
  }, [view.messages]);

  const timeline = useMemo(() => buildEntries(view.messages, paired), [view.messages, paired]);
  // Runs whose tool calls are still unresolved follow the live state (running, waiting on approval).
  const liveRuns = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of timeline.entries)
      if (entry.kind === "run" && entry.items.some((i) => i.kind === "assistant" && i.toolCalls.some((c) => !results.has(c.id)))) keys.add(entry.key);
    return keys;
  }, [timeline, results]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useEffect(() => {
    initialScroll.current = false;
    atBottom.current = true;
  }, [threadId]);

  // Keep pinned to the bottom while new content streams in, and hold position when older messages load.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prependFrom.current !== null) {
      el.scrollTop += el.scrollHeight - prependFrom.current;
      prependFrom.current = null;
      return;
    }
    if (!initialScroll.current && view.messages.length > 0) {
      initialScroll.current = true;
      scrollToBottom();
      return;
    }
    if (atBottom.current) scrollToBottom();
  }, [view.messages, view.live, scrollToBottom]);

  const onScroll = async () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < 80;
    setShowJump(distance > 400);
    if (el.scrollTop < 240 && view.hasMore && !view.loadingEarlier && initialScroll.current) {
      prependFrom.current = el.scrollHeight;
      const added = await view.loadEarlier();
      if (added === 0) prependFrom.current = null;
    }
  };

  const send = async (text: string, mode: "steer" | "followUp", files: File[]) => {
    atBottom.current = true;
    try {
      await client.send(threadId, text, { source: "web", whenBusy: mode, ...(files.length ? { attachments: await toUploads(files) } : {}) });
      requestAnimationFrame(() => scrollToBottom(true));
      return true;
    } catch (error) {
      toast.error(error, "Message not sent");
      return false;
    }
  };

  const stop = async () => {
    try {
      await client.stop(threadId);
    } catch (error) {
      toast.error(error, "Could not stop");
    }
  };

  const switchAgent = async (agentId: string) => {
    try {
      const updated = await client.updateThread(threadId, { agentId });
      local.thread(updated);
      toast.success(`Now chatting with ${agentMap.get(agentId)?.name ?? "agent"}`);
    } catch (error) {
      toast.error(error, "Could not switch agent");
    }
  };

  if (view.notFound) {
    return (
      <div className="grid h-full place-items-center">
        <EmptyState
          icon={<MessageSquareDashed />}
          title="Thread not found"
          description="It may have been deleted."
          action={
            <Button variant="primary" onClick={() => navigate("/chat")}>
              Back to chats
            </Button>
          }
        />
      </div>
    );
  }

  // "Try again" on a failed last message sends the request that led to it once more.
  const lastUser = [...view.messages].reverse().find((m) => m.kind === "user");
  const retry = lastUser?.kind === "user" && lastUser.text && !view.live.busy ? () => void send(lastUser.text, "followUp", []) : undefined;
  const lastMessage = timeline.lastId ? view.messages.find((m) => m.id === timeline.lastId) : undefined;
  const retryId = lastMessage?.kind === "assistant" && lastMessage.error && lastMessage.stopReason !== "aborted" ? lastMessage.id : undefined;

  // A stopped or errored run already says so on its last message; don't repeat it below.
  const failure = view.live.failure;
  const lastError = lastMessage?.kind === "assistant" ? lastMessage.error : undefined;
  const failureShownAbove =
    lastMessage?.kind === "assistant" &&
    ((failure?.reason === "aborted" && lastMessage.stopReason === "aborted") || (!!lastError && !!failure?.detail && (failure.detail.includes(lastError) || lastError.includes(failure.detail))));
  const showFailure = !!failure && !view.live.busy && !failureShownAbove;

  // What's streaming continues the last run when it's the same agent's; otherwise it starts a run of its own.
  const entries = timeline.entries;
  const lastEntry = entries[entries.length - 1];
  const liveActive = view.live.busy || !!view.live.partial;
  const tailOnLast = liveActive && lastEntry?.kind === "run" && lastEntry.agentId !== "" && (!thread || lastEntry.agentId === thread.agentId);
  const tail = { thinkingMs: view.liveThinkingMs ?? undefined, shownCalls };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <ConversationHeader threadId={threadId} thread={thread} agent={agent} live={view.live} />

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden [overflow-anchor:none]">
        <div className="mx-auto w-full max-w-3xl px-4 pb-10 pt-2 sm:px-8">
          {view.hasMore && (
            <div className="flex justify-center pt-5">
              {view.loadingEarlier ? (
                <LoaderCircle className="size-4 animate-spin text-subtle" />
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    prependFrom.current = scroller.current?.scrollHeight ?? null;
                    if ((await view.loadEarlier()) === 0) prependFrom.current = null;
                  }}
                  className="h-7 rounded-full border border-border bg-surface px-3 text-[12px] text-subtle shadow-xs transition-colors hover:border-border-strong hover:text-fg"
                >
                  Load earlier messages
                </button>
              )}
            </div>
          )}

          {!view.loaded && view.messages.length === 0 ? (
            <ConversationSkeleton />
          ) : view.messages.length === 0 && !view.live.busy ? (
            <div className="flex animate-rise flex-col items-center pt-[14vh] text-center">
              <div className="relative">
                <div aria-hidden className="absolute inset-0 -z-10 scale-150 rounded-full opacity-40 blur-2xl" style={{ background: agent?.color ?? "var(--accent)" }} />
                <AgentAvatar agent={agent} size="xl" />
              </div>
              <h2 className="mt-5 text-[19px] font-semibold tracking-[-0.02em] text-fg">{agent?.name ?? "New conversation"}</h2>
              <p className="mt-1.5 max-w-sm text-balance text-[13.5px] leading-relaxed text-subtle">{agent?.description || "Say hello to get started."}</p>
            </div>
          ) : (
            entries.map((entry, i) => {
              switch (entry.kind) {
                case "day":
                  return <DayDivider key={entry.key} label={entry.label} />;
                case "event":
                  return <EventNotice key={entry.key} message={entry.message} />;
                case "user":
                  return <UserBubble key={entry.key} message={entry.message} first={entry.first} />;
                case "run": {
                  const isLast = i === entries.length - 1;
                  const attach = isLast && tailOnLast;
                  const hasRetry = !!retryId && entry.items.some((m) => m.id === retryId);
                  return (
                    <Fragment key={entry.key}>
                      <RunView
                        agent={agentMap.get(entry.agentId)}
                        items={attach && entry.trailing.length ? [...entry.items, ...entry.trailing] : entry.items}
                        head={entry.head}
                        results={results}
                        live={isLast || liveRuns.has(entry.key) ? view.live : IDLE_LIVE}
                        thinkingMs={view.thinkingMs}
                        repeats={timeline.repeats}
                        retryId={hasRetry ? retryId : undefined}
                        onRetry={hasRetry ? retry : undefined}
                        tail={attach ? tail : undefined}
                      />
                      {!attach && entry.trailing.map((e) => <EventNotice key={e.id} message={e} />)}
                    </Fragment>
                  );
                }
              }
            })
          )}

          {liveActive && !tailOnLast && (
            <RunView agent={agent} items={[]} head results={results} live={view.live} thinkingMs={view.thinkingMs} repeats={timeline.repeats} tail={tail} />
          )}
          {view.live.retry && <RetryNotice retry={view.live.retry} />}
          {showFailure && view.live.failure && <FailureNotice failure={view.live.failure} />}
        </div>

        {showJump && (
          <div className="pointer-events-none sticky bottom-4 flex justify-center">
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              className="pointer-events-auto flex h-8 animate-scale-in items-center gap-1.5 rounded-full border border-border-strong bg-overlay/90 px-3.5 text-[12px] font-medium text-muted shadow-md backdrop-blur-md transition-colors hover:text-fg"
            >
              {view.live.busy ? <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-line shadow-[0_0_8px_var(--accent-glow)]" /> : <ArrowDown className="size-3.5" />}
              Latest
            </button>
          </div>
        )}
      </div>

      <Composer
        draftKey={threadId}
        agent={agent}
        busy={view.live.busy}
        waiting={!!view.live.approvals?.some((a) => a.status === "pending")}
        queued={view.live.queued}
        disabled={!view.loaded}
        onSend={send}
        onStop={stop}
        onSwitchAgent={switchAgent}
        autoFocus
      />
    </div>
  );
}

/**
 * Turns the transcript into what the page shows: day dividers, people's messages, thread-level notices, and runs
 * (consecutive turns by one agent, with their tool results and any events that happened mid-run).
 */
function buildEntries(messages: Message[], paired: Set<string>): { entries: Entry[]; repeats: Map<string, number>; lastId?: string } {
  // Provider retries leave the same error several times in a row: show it once, with a count.
  const errorOnly = (m: Message | undefined) => (m?.kind === "assistant" && !!m.error && !m.text && m.toolCalls.length === 0 ? m.error : undefined);
  const repeats = new Map<string, number>();
  const skip = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const error = errorOnly(messages[i]);
    if (!error) continue;
    let j = i + 1;
    while (j < messages.length && errorOnly(messages[j]) === error) skip.add(messages[j++]!.id);
    if (j - i > 1) repeats.set(messages[i]!.id, j - i);
    i = j - 1;
  }
  const lastId = [...messages].reverse().find((m) => m.kind !== "tool" && !skip.has(m.id))?.id;

  const entries: Entry[] = [];
  // The run being built, and events seen since its last turn: they join the run if it continues, else stand alone.
  const open: { run: RunEntry | null; events: EventMessage[] } = { run: null, events: [] };
  const close = () => {
    if (open.run) entries.push(open.run);
    for (const event of open.events) entries.push({ kind: "event", key: event.id, message: event });
    open.run = null;
    open.events = [];
  };
  const extend = (item: RunItem) => {
    open.run!.items.push(...open.events, item);
    open.events = [];
  };

  let prev: Message | undefined;
  let lastDay = "";
  for (const message of messages) {
    if (skip.has(message.id)) continue;
    // Some entries (resets, compactions) can arrive without a timestamp; they belong to the current day.
    const day = message.at > 0 ? dayLabel(message.at) : lastDay;
    if (day && day !== lastDay) {
      if (lastDay || messages.length > 4) {
        close();
        entries.push({ kind: "day", key: `day-${message.id}`, label: day });
      }
      lastDay = day;
    }
    switch (message.kind) {
      case "user": {
        close();
        const first = !(prev?.kind === "user" && prev.author.name === message.author.name && prev.author.source === message.author.source && message.at - prev.at < 5 * 60_000);
        entries.push({ kind: "user", key: message.id, message, first });
        break;
      }
      case "assistant":
        if (open.run && open.run.agentId === message.agentId) extend(message);
        else {
          close();
          open.run = { kind: "run", key: message.id, agentId: message.agentId, items: [message], head: true, trailing: [] };
        }
        break;
      case "tool":
        // Paired results render inside their call's step. Orphans get a step of their own.
        if (paired.has(message.callId)) break;
        if (open.run) extend(message);
        else {
          close();
          entries.push({ kind: "run", key: message.id, agentId: "", items: [message], head: false, trailing: [] });
        }
        break;
      case "event":
        if (open.run) open.events.push(message);
        else entries.push({ kind: "event", key: message.id, message });
        break;
    }
    prev = message;
  }
  // The last run stays open: events after its last turn join it only while it is still running (see the render).
  if (open.run) {
    open.run.trailing = open.events;
    entries.push(open.run);
  } else {
    for (const event of open.events) entries.push({ kind: "event", key: event.id, message: event });
  }
  return { entries, repeats, lastId };
}

function ConversationHeader({ threadId, thread, agent, live }: { threadId: string; thread: Thread | undefined; agent: Agent | undefined; live: LiveState }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const waiting = !!thread?.waitingApproval || !!live.approvals?.some((a) => a.status === "pending");
  const busy = !!thread?.busy || live.busy;

  const act = async (label: string, run: () => Promise<unknown>, success?: string) => {
    setMenu(false);
    try {
      await run();
      if (success) toast.success(success);
    } catch (error) {
      toast.error(error, `Could not ${label}`);
    }
  };

  const saveTitle = async () => {
    setRenaming(false);
    const value = title.trim();
    if (!value || value === thread?.title) return;
    await act("rename", async () => local.thread(await client.updateThread(threadId, { title: value })));
  };

  const sep = <span className="text-faint/70">·</span>;
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
      <a href="/chat" onClick={linkHandler("/chat")} aria-label="Back to threads" className="grid size-8 place-items-center rounded-lg text-subtle hover:bg-surface-2 hover:text-fg md:hidden">
        <ArrowLeft className="size-4" />
      </a>
      <AgentAvatar agent={agent} size="sm" presence={waiting ? "approval" : busy ? "working" : undefined} className="hidden [--presence-ring:var(--panel)] sm:grid" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveTitle();
              if (e.key === "Escape") setRenaming(false);
            }}
            aria-label="Thread title"
            className="-ml-1.5 h-7 w-full max-w-md rounded-lg border border-accent-line/50 bg-field px-1.5 text-[14px] font-semibold text-fg outline-none ring-[3px] ring-focus"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => {
              setTitle(thread?.title ?? "");
              setRenaming(true);
            }}
            className="block max-w-full truncate text-left text-[14px] font-semibold tracking-[-0.01em] text-fg"
            title="Double-click to rename"
          >
            {thread?.title || (thread ? "Untitled" : <Skeleton className="h-4 w-40" />)}
          </button>
        )}
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-subtle">
          {agent && <span className="shrink-0 truncate">{agent.name}</span>}
          {agent?.model && (
            <span className="hidden min-w-0 items-center gap-1.5 md:flex">
              {sep}
              <span className="truncate font-mono text-[11px] text-faint">{agent.model.modelId}</span>
            </span>
          )}
          {thread && thread.source !== "web" && (
            <>
              {sep}
              <SourceBadge source={thread.source} className="h-[18px] shrink-0 text-[10.5px]" />
            </>
          )}
          {thread?.location && thread.location !== thread.title && (
            <>
              {sep}
              <span className="truncate">{thread.location}</span>
            </>
          )}
        </div>
      </div>
      {waiting ? (
        <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-2.5 text-[12px] font-medium text-warning" role="status">
          <ShieldAlert className="size-3.5" />
          <span className="hidden sm:inline">Needs approval</span>
        </span>
      ) : busy ? (
        <span className="flex h-7 shrink-0 items-center gap-2 rounded-full border border-accent-line/30 bg-accent-soft px-2.5 text-[12px] font-medium text-accent-text" role="status">
          <span className="relative flex size-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-accent-line opacity-70" />
            <span className="relative size-1.5 rounded-full bg-accent-line" />
          </span>
          <span className="hidden sm:inline">Working</span>
          {live.turns > 1 && <span className="hidden font-mono text-[11px] opacity-75 sm:inline">turn {live.turns}</span>}
        </span>
      ) : null}
      <IconButton ref={anchor} label="Thread actions" onClick={() => setMenu((m) => !m)} active={menu}>
        <Ellipsis className="size-4" />
      </IconButton>
      <Popover open={menu} onClose={() => setMenu(false)} anchor={anchor} align="end" className="w-60">
        <MenuItem
          icon={<Pencil />}
          onClick={() => {
            setMenu(false);
            setTitle(thread?.title ?? "");
            setRenaming(true);
          }}
        >
          Rename
        </MenuItem>
        <MenuItem icon={<Minimize2 />} onClick={() => act("compact", () => client.compact(threadId), "Compacting context")}>
          Compact context
        </MenuItem>
        <MenuItem
          icon={<RotateCcw />}
          onClick={async () => {
            setMenu(false);
            if (await confirm({ title: "Reset this conversation?", body: "The agent forgets this thread's context and starts fresh. The transcript stays visible.", confirmLabel: "Reset", tone: "danger" }))
              await act("reset", () => client.reset(threadId), "Conversation reset");
          }}
        >
          Reset conversation
        </MenuItem>
        <MenuItem icon={<Copy />} hint={<span className="font-mono">{threadId.slice(0, 10)}…</span>} onClick={() => act("copy", async () => copyText(threadId), "Thread ID copied")}>
          Copy thread ID
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          icon={<Trash />}
          onClick={async () => {
            setMenu(false);
            if (await confirm({ title: "Delete this thread?", body: "The transcript and its durable state are removed. This can't be undone.", confirmLabel: "Delete", tone: "danger" })) {
              await act("delete", async () => {
                await client.deleteThread(threadId);
                local.threadDeleted(threadId);
                navigate("/chat", { replace: true });
              });
            }
          }}
        >
          Delete thread
        </MenuItem>
      </Popover>
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div className="flex flex-col gap-9 pt-8">
      <div className="flex justify-end">
        <Skeleton className="h-10 w-56 rounded-2xl" />
      </div>
      <div className="flex gap-3.5">
        <Skeleton className="size-8 rounded-lg" />
        <div className="flex-1 space-y-3 pt-1">
          <Skeleton className="h-3.5 w-28" />
          <div className="flex items-center gap-2">
            <Skeleton className="size-[18px] rounded-full" />
            <Skeleton className="h-3.5 w-48" />
          </div>
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </div>
      <div className="flex justify-end">
        <Skeleton className={cn("h-10 w-72 rounded-2xl")} />
      </div>
    </div>
  );
}
