import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, Copy, Ellipsis, LoaderCircle, MessageSquareDashed, Minimize2, Pencil, RotateCcw, ShieldAlert, Trash } from "lucide-react";
import type { Agent, Message, Thread } from "@soloagent/client";
import { client } from "../../api/client.ts";
import { local, useAgentMap, useApp } from "../../api/store.ts";
import { AgentAvatar, SourceBadge } from "../../components/brand.tsx";
import { MenuItem, MenuSeparator, Popover } from "../../components/overlay.tsx";
import { Button, EmptyState, IconButton, Skeleton } from "../../components/ui.tsx";
import { copyText } from "../../lib/clipboard.ts";
import { cn } from "../../lib/cn.ts";
import { dayLabel } from "../../lib/format.ts";
import { linkHandler, navigate } from "../../lib/router.ts";
import { confirm, toast } from "../../lib/toast.ts";
import { Composer } from "./Composer.tsx";
import { AssistantMessageView, DayDivider, EventNotice, FailureNotice, LiveTurn, RetryNotice, ToolCard, UserBubble } from "./Messages.tsx";
import { useThread } from "./useThread.ts";

type ToolMessage = Extract<Message, { kind: "tool" }>;

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
  const { results, paired } = useMemo(() => {
    const results = new Map<string, ToolMessage>();
    for (const m of view.messages) if (m.kind === "tool") results.set(m.callId, m);
    const paired = new Set<string>();
    for (const m of view.messages) if (m.kind === "assistant") for (const c of m.toolCalls) if (results.has(c.id)) paired.add(c.id);
    return { results, paired };
  }, [view.messages]);

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

  const send = async (text: string, mode: "steer" | "followUp") => {
    atBottom.current = true;
    try {
      await client.send(threadId, text, { source: "web", whenBusy: mode });
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

  const items = buildTimeline(view.messages, paired, agentMap, view.thinkingMs, results, view.live);
  const lastTurn = (() => {
    for (let i = view.messages.length - 1; i >= 0; i--) {
      const m = view.messages[i]!;
      if (m.kind === "tool") continue;
      return m;
    }
    return undefined;
  })();
  const lastIsAssistant = lastTurn?.kind === "assistant";
  // A stopped or errored run already says so on its last message; don't repeat it below.
  const failure = view.live.failure;
  const lastError = lastTurn?.kind === "assistant" ? lastTurn.error : undefined;
  const failureShownAbove =
    lastTurn?.kind === "assistant" &&
    ((failure?.reason === "aborted" && lastTurn.stopReason === "aborted") || (!!lastError && !!failure?.detail && (failure.detail.includes(lastError) || lastError.includes(failure.detail))));
  const showFailure = !!failure && !view.live.busy && !failureShownAbove;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <ConversationHeader threadId={threadId} thread={thread} agent={agent} />

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden [overflow-anchor:none]">
        <div className="mx-auto w-full max-w-3xl px-4 pb-8 pt-4 sm:px-6">
          {view.hasMore && (
            <div className="flex justify-center py-3">
              {view.loadingEarlier ? (
                <LoaderCircle className="size-4 animate-spin text-subtle" />
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    prependFrom.current = scroller.current?.scrollHeight ?? null;
                    if ((await view.loadEarlier()) === 0) prependFrom.current = null;
                  }}
                  className="rounded-full border border-border px-3 py-1 text-[12px] text-subtle hover:bg-surface-2 hover:text-fg"
                >
                  Load earlier messages
                </button>
              )}
            </div>
          )}

          {!view.loaded && view.messages.length === 0 ? (
            <ConversationSkeleton />
          ) : view.messages.length === 0 && !view.live.busy ? (
            <div className="flex flex-col items-center pt-[14vh] text-center">
              <AgentAvatar agent={agent} size="xl" />
              <h2 className="mt-4 text-[18px] font-semibold tracking-tight text-fg">{agent?.name ?? "New conversation"}</h2>
              <p className="mt-1 max-w-sm text-[13.5px] text-subtle">{agent?.description || "Say hello to get started."}</p>
            </div>
          ) : (
            items
          )}

          <LiveTurn
            live={view.live}
            agent={agent}
            head={!lastIsAssistant}
            thinkingMs={view.liveThinkingMs ?? undefined}
            shownCalls={new Set(view.messages.flatMap((m) => (m.kind === "assistant" ? m.toolCalls.map((c) => c.id) : [])))}
          />
          {view.live.retry && <RetryNotice retry={view.live.retry} />}
          {showFailure && view.live.failure && <FailureNotice failure={view.live.failure} />}
        </div>

        {showJump && (
          <div className="pointer-events-none sticky bottom-3 flex justify-center">
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              className="pointer-events-auto flex h-8 animate-scale-in items-center gap-1.5 rounded-full border border-border bg-overlay px-3 text-[12px] font-medium text-muted shadow-md hover:text-fg"
            >
              <ArrowDown className="size-3.5" />
              Latest
            </button>
          </div>
        )}
      </div>

      <Composer
        draftKey={threadId}
        agent={agent}
        busy={view.live.busy}
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

function buildTimeline(
  messages: Message[],
  paired: Set<string>,
  agentMap: Map<string, Agent>,
  thinkingMs: Map<string, number>,
  results: Map<string, ToolMessage>,
  live: ReturnType<typeof useThread>["live"],
): ReactNode[] {
  const out: ReactNode[] = [];
  let prev: Message | undefined;
  let lastDay = "";
  for (const message of messages) {
    // Some entries (resets, compactions) can arrive without a timestamp; they belong to the current day.
    const day = message.at > 0 ? dayLabel(message.at) : lastDay;
    if (day && day !== lastDay) {
      if (lastDay || messages.length > 4) out.push(<DayDivider key={`day-${message.id}`} label={day} />);
      lastDay = day;
    }
    switch (message.kind) {
      case "user": {
        const first = !(prev?.kind === "user" && prev.author.name === message.author.name && prev.author.source === message.author.source && message.at - prev.at < 5 * 60_000);
        out.push(<UserBubble key={message.id} message={message} first={first} />);
        break;
      }
      case "assistant": {
        // Continue the run (no repeated header) after another assistant message or a tool result from the same agent.
        const head = !(prev && (prev.kind === "assistant" || prev.kind === "tool") && (prev.kind !== "assistant" || prev.agentId === message.agentId));
        out.push(
          <AssistantMessageView
            key={message.id}
            message={message}
            agent={agentMap.get(message.agentId)}
            head={head}
            results={results}
            live={live}
            thinkingMs={thinkingMs.get(message.id)}
          />,
        );
        break;
      }
      case "tool":
        // Paired results render inside their call's card. Orphans get their own card.
        if (!paired.has(message.callId)) {
          out.push(
            <div key={message.id} className="ml-[46px] mt-2">
              <ToolCard call={{ id: message.callId, name: message.name, args: undefined }} result={message} />
            </div>,
          );
        }
        break;
      case "event":
        out.push(<EventNotice key={message.id} message={message} />);
        break;
    }
    prev = message;
  }
  return out;
}

function ConversationHeader({ threadId, thread, agent }: { threadId: string; thread: Thread | undefined; agent: Agent | undefined }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);

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

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
      <a href="/chat" onClick={linkHandler("/chat")} aria-label="Back to threads" className="grid size-8 place-items-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg md:hidden">
        <ArrowLeft className="size-4" />
      </a>
      <AgentAvatar agent={agent} size="sm" className="hidden sm:grid" />
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
            className="h-7 w-full max-w-md rounded-md border border-accent-line/50 bg-surface px-2 text-[14px] font-semibold text-fg outline-none ring-3 ring-accent-line/15"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => {
              setTitle(thread?.title ?? "");
              setRenaming(true);
            }}
            className="block max-w-full truncate text-left text-[14px] font-semibold text-fg"
            title="Double-click to rename"
          >
            {thread?.title || (thread ? "Untitled" : <Skeleton className="h-4 w-40" />)}
          </button>
        )}
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-subtle">
          {agent && <span className="truncate">{agent.name}</span>}
          {thread && thread.source !== "web" && (
            <>
              <span className="text-faint">·</span>
              <SourceBadge source={thread.source} className="h-4 text-[10.5px]" />
            </>
          )}
          {thread?.location && thread.location !== thread.title && (
            <>
              <span className="text-faint">·</span>
              <span className="truncate">{thread.location}</span>
            </>
          )}
          {thread?.waitingApproval ? (
            <span className="ml-1 flex items-center gap-1 text-warning">
              <ShieldAlert className="size-3" />
              waiting for approval
            </span>
          ) : (
            thread?.busy && (
              <span className="ml-1 flex items-center gap-1 text-accent-text">
                <LoaderCircle className="size-3 animate-spin" />
                working
              </span>
            )
          )}
        </div>
      </div>
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
        <MenuItem icon={<Copy />} onClick={() => act("copy", async () => copyText(threadId), "Thread ID copied")}>
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
    <div className="flex flex-col gap-8 pt-6">
      <div className="flex justify-end">
        <Skeleton className="h-10 w-56 rounded-2xl" />
      </div>
      <div className={cn("flex gap-3.5")}>
        <Skeleton className="size-8 rounded-lg" />
        <div className="flex-1 space-y-2.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-10 w-72 rounded-2xl" />
      </div>
    </div>
  );
}
