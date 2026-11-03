import { memo, useState, type ReactNode } from "react";
import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  FilePen,
  FileText,
  Globe,
  Info,
  LoaderCircle,
  RotateCcw,
  SquareTerminal,
  TriangleAlert,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type { Agent, LiveState, Message, ToolCallInfo } from "@soloagent/client";
import { AgentAvatar, SourceBadge } from "../../components/brand.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { CopyButton } from "../../components/ui.tsx";
import { cn } from "../../lib/cn.ts";
import { clockTime, cost, duration, fullDate, initials, relativeTime, tokens } from "../../lib/format.ts";

type AssistantMessage = Extract<Message, { kind: "assistant" }>;
type ToolMessage = Extract<Message, { kind: "tool" }>;
type UserMessage = Extract<Message, { kind: "user" }>;
type EventMessage = Extract<Message, { kind: "event" }>;

const SELF_SOURCES = new Set(["web", "tui", "api"]);

// ---------------------------------------------------------------------------
// Layout primitives

/** Assistant row: avatar gutter + content. `head` false continues a run without repeating the header. */
function AssistantRow({ agent, head, header, children }: { agent: Agent | undefined; head: boolean; header?: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("group/msg flex gap-3.5", head ? "mt-6" : "mt-2")}>
      <div className="w-8 shrink-0">{head && <AgentAvatar agent={agent} size="md" />}</div>
      <div className="min-w-0 flex-1">
        {head && header}
        {children}
      </div>
    </div>
  );
}

function AssistantHeader({ agent, model, at, extra }: { agent: Agent | undefined; model?: string; at?: number; extra?: ReactNode }) {
  return (
    <div className="mb-1 flex h-6 min-w-0 items-center gap-2">
      <span className="truncate text-[13.5px] font-semibold text-fg">{agent?.name ?? "Agent"}</span>
      {model && <span className="hidden truncate font-mono text-[11.5px] text-faint sm:inline">{model}</span>}
      {at && (
        <time className="shrink-0 text-[11.5px] text-faint" dateTime={new Date(at).toISOString()} title={fullDate(at)}>
          {clockTime(at)}
        </time>
      )}
      {extra}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages

export const UserBubble = memo(function UserBubble({ message, first }: { message: UserMessage; first: boolean }) {
  const self = SELF_SOURCES.has(message.author.source);
  if (self) {
    return (
      <div className={cn("group/msg flex flex-col items-end", first ? "mt-6" : "mt-1.5")}>
        <div className="max-w-[min(85%,640px)] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border bg-surface-2 px-3.5 py-2 text-[14.5px] leading-relaxed text-fg">
          {message.text}
        </div>
        <div className="mt-1 flex h-4 items-center gap-1.5 pr-1 text-[11px] text-faint opacity-0 transition-opacity group-hover/msg:opacity-100">
          {message.author.source !== "web" && <SourceBadge source={message.author.source} className="h-4 text-[10px]" />}
          <span title={fullDate(message.at)}>{clockTime(message.at)}</span>
        </div>
      </div>
    );
  }
  // Someone on Slack/Discord/Telegram/a webhook: left-aligned with their name and platform.
  return (
    <div className={cn("group/msg flex gap-3.5", first ? "mt-6" : "mt-2")}>
      <div className="w-8 shrink-0">
        {first &&
          (message.author.avatarUrl ? (
            <img src={message.author.avatarUrl} alt="" className="size-8 rounded-lg object-cover" />
          ) : (
            <span className="grid size-8 place-items-center rounded-lg bg-surface-3 text-[12px] font-semibold text-muted">{initials(message.author.name)}</span>
          ))}
      </div>
      <div className="min-w-0 flex-1">
        {first && (
          <div className="mb-1 flex h-6 items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-fg">{message.author.name}</span>
            <SourceBadge source={message.author.source} />
            <time className="text-[11.5px] text-faint" title={fullDate(message.at)}>
              {clockTime(message.at)}
            </time>
          </div>
        )}
        <div className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-fg">{message.text}</div>
      </div>
    </div>
  );
});

export function EventNotice({ message }: { message: Pick<EventMessage, "text" | "tone" | "at"> }) {
  const Icon = message.tone === "error" ? CircleAlert : message.tone === "warn" ? TriangleAlert : Info;
  return (
    <div className="my-5 flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <div
        className={cn(
          "flex max-w-[80%] items-center gap-1.5 rounded-full border px-3 py-1 text-[12px]",
          message.tone === "error"
            ? "border-danger/25 bg-danger-soft text-danger"
            : message.tone === "warn"
              ? "border-warning/25 bg-warning-soft text-warning"
              : "border-border bg-surface-2 text-subtle",
        )}
        title={fullDate(message.at)}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{message.text}</span>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-6 flex items-center gap-3 text-[11.5px] font-medium text-faint">
      <div className="h-px flex-1 bg-border" />
      {label}
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function UsageHint({ message }: { message: AssistantMessage }) {
  const u = message.usage;
  if (!u) return null;
  const detail = [
    `Input ${tokens(u.input)}`,
    `Output ${tokens(u.output)}`,
    u.cacheRead ? `Cache read ${tokens(u.cacheRead)}` : null,
    u.cacheWrite ? `Cache write ${tokens(u.cacheWrite)}` : null,
    `Cost ${cost(u.cost)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      title={detail}
      className="ml-auto hidden shrink-0 items-center gap-2 rounded-md border border-border bg-surface-2 px-1.5 font-mono text-[10.5px] leading-[18px] text-subtle opacity-0 transition-opacity group-hover/msg:opacity-100 sm:inline-flex"
    >
      <span>{tokens(u.input + u.cacheRead + u.cacheWrite)} in</span>
      <span>{tokens(u.output)} out</span>
      {u.cacheRead > 0 && <span className="text-success">{Math.round((u.cacheRead / Math.max(1, u.input + u.cacheRead + u.cacheWrite)) * 100)}% cached</span>}
      <span className="text-fg">{cost(u.cost)}</span>
    </span>
  );
}

export const AssistantMessageView = memo(function AssistantMessageView({
  message,
  agent,
  head,
  results,
  live,
  thinkingMs,
}: {
  message: AssistantMessage;
  agent: Agent | undefined;
  head: boolean;
  results: Map<string, ToolMessage>;
  live: LiveState;
  thinkingMs?: number;
}) {
  return (
    <AssistantRow agent={agent} head={head} header={<AssistantHeader agent={agent} model={message.model} at={message.at} extra={<UsageHint message={message} />} />}>
      {!head && message.usage && (
        <div className="-mt-1 flex h-0 justify-end overflow-visible">
          <UsageHint message={message} />
        </div>
      )}
      {message.thinking && <ThinkingBlock text={message.thinking} ms={thinkingMs} />}
      {message.text && <Markdown text={message.text} />}
      {message.toolCalls.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {message.toolCalls.map((call) => (
            <ToolCard key={call.id} call={call} result={results.get(call.id)} liveTool={live.tools.find((t) => t.callId === call.id)} busy={live.busy} />
          ))}
        </div>
      )}
      {message.error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{message.error}</span>
        </div>
      )}
      {message.stopReason === "aborted" && !message.error && <p className="mt-1.5 text-[12px] italic text-faint">Stopped</p>}
      {message.text && (
        <div className="mt-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100">
          <CopyButton text={message.text} label="Copy message" size="xs" />
        </div>
      )}
    </AssistantRow>
  );
});

/** The in-progress turn: streamed text with a caret, running tools, and the typing state. */
export function LiveTurn({ live, agent, head, thinkingMs }: { live: LiveState; agent: Agent | undefined; head: boolean; thinkingMs?: number }) {
  const partial = live.partial;
  const hasContent = !!partial && (!!partial.text || !!partial.thinking || partial.toolCalls.length > 0);
  const pendingTools = live.tools.filter((t) => t.status !== "done" && !partial?.toolCalls.some((c) => c.id === t.callId));
  if (!live.busy && !hasContent) return null;
  return (
    <AssistantRow agent={agent} head={head} header={<AssistantHeader agent={agent} extra={<span className="text-[11.5px] text-faint">{live.turns > 1 ? `turn ${live.turns}` : null}</span>} />}>
      {partial?.thinking && <ThinkingBlock text={partial.thinking} live={!partial.text && partial.toolCalls.length === 0} ms={thinkingMs} />}
      {partial?.text ? <Markdown text={partial.text} live /> : null}
      {partial && partial.toolCalls.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {partial.toolCalls.map((call) => (
            <ToolCard key={call.id} call={call} liveTool={live.tools.find((t) => t.callId === call.id)} busy streaming />
          ))}
        </div>
      )}
      {pendingTools.length > 0 && !partial && (
        <div className="mt-1 flex flex-col gap-1.5">
          {pendingTools.map((tool) => (
            <ToolCard key={tool.callId} call={{ id: tool.callId, name: tool.name, args: undefined }} liveTool={tool} busy />
          ))}
        </div>
      )}
      {!hasContent && pendingTools.length === 0 && <TypingDots />}
    </AssistantRow>
  );
}

function TypingDots() {
  return (
    <div className="flex h-7 items-center gap-1" aria-label="Agent is working" role="status">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 animate-bounce rounded-full bg-accent/70" style={{ animationDelay: `${i * 140}ms`, animationDuration: "1s" }} />
      ))}
    </div>
  );
}

export function RetryNotice({ retry }: { retry: NonNullable<LiveState["retry"]> }) {
  return (
    <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-warning/25 bg-warning-soft px-3.5 py-2.5 text-[13px]">
      <RotateCcw className="mt-0.5 size-4 shrink-0 animate-spin text-warning [animation-direction:reverse] [animation-duration:2s]" />
      <div className="min-w-0">
        <p className="font-medium text-warning">Provider hiccup — retrying {retry.at > Date.now() ? relativeTime(retry.at) : "now"}</p>
        <p className="mt-0.5 break-words text-[12.5px] text-muted">{retry.error}</p>
      </div>
    </div>
  );
}

export function FailureNotice({ failure }: { failure: NonNullable<LiveState["failure"]> }) {
  return (
    <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-[13px]">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0">
        <p className="font-medium text-danger">{failure.reason}</p>
        {failure.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] text-muted">{failure.detail}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thinking

function ThinkingBlock({ text, live, ms }: { text: string; live?: boolean; ms?: number }) {
  const [open, setOpen] = useState(false);
  const label = live ? "Thinking" : ms !== undefined ? `Thought for ${ms < 1000 ? "a moment" : duration(ms)}` : "Thought process";
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group/think -ml-1 inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-[13px] text-subtle transition-colors hover:text-fg"
      >
        <Brain className={cn("size-3.5", live && "animate-pulse-soft text-accent-text")} />
        <span className={cn(live && "shimmer-text font-medium")}>{label}</span>
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="ml-[7px] mt-1 animate-fade-in border-l-2 border-border pl-4 text-[13px] leading-relaxed whitespace-pre-wrap text-subtle">{text}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool calls

const TOOL_ICONS: [RegExp, typeof Wrench][] = [
  [/fetch|web|browse|http|search/i, Globe],
  [/memory|remember|recall|forget/i, Brain],
  [/agent|delegate|ask_/i, Users],
  [/schedule|remind|sleep|timer/i, Clock],
  [/bash|shell|exec|run/i, SquareTerminal],
  [/write|edit|patch/i, FilePen],
  [/read|file|ls|glob|grep/i, FileText],
];

function toolIcon(name: string) {
  return TOOL_ICONS.find(([re]) => re.test(name))?.[1] ?? Wrench;
}

/** One-line summary of tool args: the most telling string value. */
function argSummary(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const record = args as Record<string, unknown>;
  for (const key of ["command", "url", "query", "path", "file_path", "text", "question", "message", "prompt", "agent", "key", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const first = Object.values(record).find((v) => typeof v === "string" || typeof v === "number");
  return first === undefined ? "" : String(first);
}

function prettyArgs(args: unknown): string {
  if (args === undefined) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function ToolCard({
  call,
  result,
  liveTool,
  busy,
  streaming,
}: {
  call: ToolCallInfo;
  result?: ToolMessage;
  liveTool?: LiveState["tools"][number];
  busy?: boolean;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status: "running" | "pending" | "done" | "error" | "unknown" = result
    ? result.isError
      ? "error"
      : "done"
    : liveTool
      ? liveTool.status === "done"
        ? "done"
        : liveTool.status
      : busy || streaming
        ? "pending"
        : "unknown";
  const output = result?.text ?? liveTool?.output;
  const Icon = toolIcon(call.name);
  const summary = argSummary(call.args).replace(/\s+/g, " ");
  const args = prettyArgs(call.args);

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-surface transition-colors", status === "error" ? "border-danger/30" : "border-border", open && "shadow-sm")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-9 w-full min-w-0 items-center gap-2.5 px-2.5 text-left transition-colors hover:bg-surface-2/60"
      >
        <span
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-md [&_svg]:size-3",
            status === "error" ? "bg-danger-soft text-danger" : status === "done" ? "bg-surface-3 text-muted" : "bg-accent-soft text-accent-text",
          )}
        >
          <Icon />
        </span>
        <span className="shrink-0 font-mono text-[12.5px] font-medium text-fg">{call.name}</span>
        {summary && <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-subtle">{summary}</span>}
        {!summary && <span className="flex-1" />}
        <ToolStatus status={status} />
        <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="animate-fade-in border-t border-border bg-code">
          {args && (
            <ToolSection label="Input" copy={args}>
              {args}
            </ToolSection>
          )}
          <ToolSection label={status === "error" ? "Error" : "Output"} copy={output} tone={status === "error" ? "error" : undefined}>
            {output ?? (status === "running" || status === "pending" ? "Running…" : "No output")}
          </ToolSection>
        </div>
      )}
    </div>
  );
}

function ToolSection({ label, children, copy, tone }: { label: string; children: ReactNode; copy?: string; tone?: "error" }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center justify-between px-3 pt-1.5">
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-faint">{label}</span>
        {copy && <CopyButton text={copy} size="xs" />}
      </div>
      <pre className={cn("max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 pb-2.5 pt-0.5 font-mono text-[12px] leading-relaxed", tone === "error" ? "text-danger" : "text-muted")}>
        {children}
      </pre>
    </div>
  );
}

function ToolStatus({ status }: { status: "running" | "pending" | "done" | "error" | "unknown" }) {
  switch (status) {
    case "running":
    case "pending":
      return (
        <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-accent-text">
          <LoaderCircle className="size-3.5 animate-spin" />
          <span className="hidden sm:inline">{status === "pending" ? "Queued" : "Running"}</span>
        </span>
      );
    case "done":
      return <Check className="size-3.5 shrink-0 text-success" aria-label="Done" />;
    case "error":
      return <X className="size-3.5 shrink-0 text-danger" aria-label="Failed" />;
    default:
      return null;
  }
}
