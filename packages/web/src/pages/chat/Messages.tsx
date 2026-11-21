import { memo, useMemo, useState, type ReactNode } from "react";
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
  Minus,
  Repeat,
  RotateCcw,
  ShieldAlert,
  Square,
  SquareTerminal,
  TriangleAlert,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type { Agent, Approval, Attachment, LiveState, Message, ToolCallInfo, Usage } from "@soloagent/client";
import { explainError } from "@soloagent/client";
import { ApprovalWaiting } from "../../components/ApprovalActions.tsx";
import { AgentAvatar, SourceBadge, type AgentPresence } from "../../components/brand.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { ImageViewer } from "../../components/ImageViewer.tsx";
import { CopyButton } from "../../components/ui.tsx";
import { cn } from "../../lib/cn.ts";
import { fileSize, fileUrl, PREVIEWABLE } from "../../lib/files.ts";
import { clockTime, cost, duration, fullDate, initials, relativeTime, safeHttpUrl, tokens } from "../../lib/format.ts";

export type AssistantMessage = Extract<Message, { kind: "assistant" }>;
export type ToolMessage = Extract<Message, { kind: "tool" }>;
type UserMessage = Extract<Message, { kind: "user" }>;
export type EventMessage = Extract<Message, { kind: "event" }>;
/** What a run is made of: the agent's turns, tool results that had no call to pair with, and events mid-run. */
export type RunItem = AssistantMessage | ToolMessage | EventMessage;
type LiveTool = LiveState["tools"][number];

const SELF_SOURCES = new Set(["web", "tui", "api"]);

// ---------------------------------------------------------------------------
// People

/** Image thumbnails (click for full size) and file chips (download) shared with a message. */
function Attachments({ files, align }: { files: Attachment[]; align: "start" | "end" }) {
  // An image that fails to load (deleted, corrupt) falls back to a file card instead of a broken-image icon.
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const images = files.filter((f) => PREVIEWABLE.has(f.mimeType) && !broken.has(f.sha256));
  const others = files.filter((f) => !PREVIEWABLE.has(f.mimeType) || broken.has(f.sha256));
  return (
    <div className={cn("mb-1.5 flex max-w-[min(85%,640px)] flex-col gap-1.5", align === "end" ? "items-end" : "items-start")}>
      {images.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5", align === "end" && "justify-end")}>
          {images.map((f) => (
            <a
              key={f.sha256}
              href={fileUrl(f.sha256)}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                // Plain clicks open the viewer; cmd/ctrl/middle-click still open a tab.
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                setViewing(f);
              }}
              title={`${f.name} · ${fileSize(f.size)}`}
              className="block overflow-hidden rounded-xl border border-border bg-surface-2 shadow-sm transition-[opacity,border-color] hover:border-border-strong hover:opacity-90"
            >
              <img
                src={fileUrl(f.sha256)}
                alt={f.name}
                loading="lazy"
                onError={() => setBroken((b) => new Set(b).add(f.sha256))}
                className={cn("block object-cover", images.length === 1 ? "max-h-72 max-w-full" : "size-32")}
              />
            </a>
          ))}
        </div>
      )}
      {viewing && <ImageViewer src={fileUrl(viewing.sha256)} name={viewing.name} onClose={() => setViewing(null)} />}
      {others.map((f) => (
        <a
          key={f.sha256}
          href={fileUrl(f.sha256)}
          download={f.name}
          title={`Download ${f.name}`}
          className="flex max-w-full items-center gap-2.5 rounded-xl border border-border bg-surface py-2 pl-2 pr-3 shadow-xs transition-colors hover:border-border-strong hover:bg-surface-2"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-subtle ring-1 ring-border">
            <FileText className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-fg">{f.name}</span>
            <span className="block font-mono text-[11px] text-faint">{fileSize(f.size)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

export const UserBubble = memo(function UserBubble({ message, first }: { message: UserMessage; first: boolean }) {
  const self = SELF_SOURCES.has(message.author.source);
  if (self) {
    return (
      <div className={cn("group/msg flex flex-col items-end", first ? "mt-7" : "mt-1.5")}>
        {message.attachments?.length ? <Attachments files={message.attachments} align="end" /> : null}
        {message.text && (
          <div className="max-w-[min(85%,620px)] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border bg-surface-2 px-4 py-2.5 text-[14.5px] leading-relaxed text-fg shadow-xs">
            {message.text}
          </div>
        )}
        <div className="mt-1 flex h-4 items-center gap-1.5 pr-1 font-mono text-[10.5px] text-faint opacity-0 transition-opacity group-hover/msg:opacity-100">
          {message.author.source !== "web" && <SourceBadge source={message.author.source} className="h-4 font-sans text-[10px]" />}
          <span title={fullDate(message.at)}>{clockTime(message.at)}</span>
        </div>
      </div>
    );
  }
  const avatarSrc = safeHttpUrl(message.author.avatarUrl);
  // Someone on Slack/Discord/Telegram/a webhook: left-aligned with their name and platform. People are round;
  // agents are tiles.
  return (
    <div className={cn("group/msg flex gap-3.5", first ? "mt-7" : "mt-2")}>
      <div className="w-8 shrink-0">
        {first &&
          (avatarSrc ? (
            <img src={avatarSrc} alt="" className="size-8 rounded-full object-cover ring-1 ring-border" />
          ) : (
            <span className="grid size-8 place-items-center rounded-full bg-gradient-to-b from-surface-3 to-surface-2 text-[11px] font-semibold text-muted ring-1 ring-border-strong">
              {initials(message.author.name)}
            </span>
          ))}
      </div>
      <div className="min-w-0 flex-1">
        {first && (
          <div className="mb-1 flex h-8 items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-fg">{message.author.name}</span>
            <SourceBadge source={message.author.source} />
            <time className="font-mono text-[11px] text-faint" title={fullDate(message.at)}>
              {clockTime(message.at)}
            </time>
          </div>
        )}
        {message.attachments?.length ? <Attachments files={message.attachments} align="start" /> : null}
        {message.text && <div className="-mt-1 whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-fg">{message.text}</div>}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Thread-level notices

function eventIcon(message: Pick<EventMessage, "text" | "tone">) {
  if (message.tone === "error") return CircleAlert;
  if (message.tone === "warn") return TriangleAlert;
  if (/^reminder/i.test(message.text)) return Clock;
  if (/^automation/i.test(message.text)) return Repeat;
  return Info;
}

export function EventNotice({ message }: { message: Pick<EventMessage, "text" | "tone" | "at"> }) {
  const Icon = eventIcon(message);
  return (
    <div className="my-6 flex items-center gap-3">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-border" />
      <div
        className={cn(
          "flex h-7 max-w-[80%] items-center gap-1.5 rounded-full border px-3 text-[12px] shadow-xs",
          message.tone === "error"
            ? "border-danger/25 bg-danger-soft text-danger"
            : message.tone === "warn"
              ? "border-warning/25 bg-warning-soft text-warning"
              : "border-border bg-surface text-subtle",
        )}
        title={message.at > 0 ? fullDate(message.at) : undefined}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{message.text}</span>
      </div>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-border" />
    </div>
  );
}

export function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-8 flex items-center gap-3">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-border" />
      <span className="label-mono text-faint">{label}</span>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-border" />
    </div>
  );
}

export function RetryNotice({ retry }: { retry: NonNullable<LiveState["retry"]> }) {
  return (
    <div className="ml-[46px] mt-4 flex items-start gap-3 rounded-xl border border-warning/25 bg-warning-soft px-3.5 py-3 text-[13px]">
      <RotateCcw className="mt-0.5 size-4 shrink-0 animate-spin text-warning [animation-direction:reverse] [animation-duration:2s]" />
      <div className="min-w-0">
        <p className="font-medium text-warning">Provider hiccup — retrying {retry.at > Date.now() ? relativeTime(retry.at) : "now"}</p>
        <p className="mt-0.5 break-words font-mono text-[11.5px] leading-relaxed text-muted">{retry.error}</p>
      </div>
    </div>
  );
}

/** Provider errors often arrive as `401 {"error":{"message":"…"}}`; show the message, keep the raw text in a tooltip. */
function friendlyError(text: string): string {
  const match = /^(\d{3})\s+(\{[\s\S]*\})\s*$/.exec(text.trim());
  if (!match) return text;
  try {
    const body = JSON.parse(match[2]!) as { error?: { message?: string } | string; message?: string };
    const message = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
    return message ? `${message} (HTTP ${match[1]})` : text;
  } catch {
    return text;
  }
}

/** "rate_limited" → "Rate limited". */
function humanizeReason(reason: string): string {
  const text = reason.replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function StoppedNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex h-7 items-center gap-1.5 font-mono text-[11.5px] text-subtle", className)}>
      <Square className="size-2.5 fill-current" />
      Stopped
    </p>
  );
}

export function FailureNotice({ failure }: { failure: NonNullable<LiveState["failure"]> }) {
  // A run the user stopped is not a failure.
  if (failure.reason === "aborted") return <StoppedNote className="ml-[46px] mt-2" />;
  return (
    <div className="ml-[46px] mt-4 flex items-start gap-3 rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-3 text-[13px]">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0">
        <p className="font-medium text-danger">{(failure.detail && explainError(failure.detail)) ?? humanizeReason(failure.reason)}</p>
        {failure.detail && (
          <p className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted" title={failure.detail}>
            {friendlyError(failure.detail)}
          </p>
        )}
      </div>
    </div>
  );
}

function ErrorBox({ error, repeats, onRetry }: { error: string; repeats: number; onRetry?: () => void }) {
  const explained = explainError(error);
  const detail = friendlyError(error);
  return (
    <div className="my-1.5 flex items-start gap-3 rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-3 text-[13px]">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-danger">{explained ?? detail}</p>
        {explained && (
          <p className="mt-0.5 break-words font-mono text-[11.5px] leading-relaxed text-muted" title={error}>
            {detail}
          </p>
        )}
        {(repeats > 1 || onRetry) && (
          <div className="mt-2.5 flex items-center gap-3">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-control px-2.5 text-[12px] font-medium text-fg shadow-xs transition-colors hover:border-border-strong hover:bg-control-hover"
              >
                <RotateCcw className="size-3.5" />
                Try again
              </button>
            )}
            {repeats > 1 && <span className="font-mono text-[11.5px] text-subtle">failed {repeats}× in a row</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs: an agent's work rendered as a trace. Reasoning, tool calls, and mid-run events are steps on a rail that
// hangs from the agent's avatar; the answer text sits beside it.

type Block =
  | { type: "thinking"; key: string; text: string; ms?: number; live?: boolean }
  | { type: "text"; key: string; text: string; live?: boolean }
  | { type: "tool"; key: string; call: ToolCallInfo; result?: ToolMessage; liveTool?: LiveTool; approval?: Approval; busy?: boolean; streaming?: boolean }
  | { type: "event"; key: string; message: EventMessage }
  | { type: "working"; key: string; turns: number }
  | { type: "error"; key: string; error: string; repeats: number; onRetry?: () => void }
  | { type: "stopped"; key: string };

const isStep = (block: Block) => block.type === "thinking" || block.type === "tool" || block.type === "event" || block.type === "working";

/** The live part of a run: what's streaming right now, and tools still pending. Empty when nothing shows. */
export function liveBlocks(
  live: LiveState,
  shownCalls: ReadonlySet<string>,
  thinkingMs?: number,
  liveToolsByCall?: ReadonlyMap<string, LiveTool>,
  approvalsByCall?: ReadonlyMap<string, Approval>,
): Block[] {
  const partial = live.partial;
  const hasContent = !!partial && (!!partial.text || !!partial.thinking || partial.toolCalls.length > 0);
  const partialIds = partial?.toolCalls.length ? new Set(partial.toolCalls.map((c) => c.id)) : undefined;
  const pendingTools = live.tools.filter((t) => t.status !== "done" && !shownCalls.has(t.callId) && !partialIds?.has(t.callId));
  if (!live.busy && !hasContent) return [];
  // Paused on an approval: its tool step says so; no "working" step.
  if (!hasContent && pendingTools.length === 0 && live.approvals?.length) return [];
  const toolsMap = liveToolsByCall ?? new Map(live.tools.map((t) => [t.callId, t]));
  const approvalsMap = approvalsByCall ?? new Map((live.approvals ?? []).map((a) => [a.callId, a]));
  const blocks: Block[] = [];
  if (partial?.thinking) blocks.push({ type: "thinking", key: "live:thinking", text: partial.thinking, live: !partial.text && partial.toolCalls.length === 0, ms: thinkingMs });
  if (partial?.text) blocks.push({ type: "text", key: "live:text", text: partial.text, live: true });
  for (const call of partial?.toolCalls ?? []) {
    blocks.push({
      type: "tool",
      key: `live:${call.id}`,
      call,
      liveTool: toolsMap.get(call.id),
      approval: approvalsMap.get(call.id),
      busy: true,
      streaming: true,
    });
  }
  if (!partial) {
    for (const tool of pendingTools) {
      const approval = approvalsMap.get(tool.callId);
      blocks.push({ type: "tool", key: `live:${tool.callId}`, call: { id: tool.callId, name: tool.name, args: approval?.args }, liveTool: tool, approval, busy: true });
    }
  }
  // Nothing streaming yet: say the agent is at work, unless a tool step above already shows it running.
  const runningAbove = live.tools.some((t) => t.status !== "done" && shownCalls.has(t.callId));
  if (!hasContent && pendingTools.length === 0 && !runningAbove) blocks.push({ type: "working", key: "live:working", turns: live.turns });
  return blocks;
}

function sumUsage(items: RunItem[]): Usage | undefined {
  let total: Usage | undefined;
  for (const item of items) {
    if (item.kind !== "assistant" || !item.usage) continue;
    const u = item.usage;
    total = total
      ? { input: total.input + u.input, output: total.output + u.output, cacheRead: total.cacheRead + u.cacheRead, cacheWrite: total.cacheWrite + u.cacheWrite, cost: total.cost + u.cost }
      : { ...u };
  }
  return total;
}

export type RunTail = { thinkingMs?: number; shownCalls: ReadonlySet<string> };

/**
 * One agent run: consecutive turns by the same agent. With `tail`, it is the run in progress and also shows what is
 * streaming. `head` false continues a run whose header is above (or a lone tool result).
 */
export const RunView = memo(function RunView({
  agent,
  items,
  head,
  results,
  live,
  thinkingMs,
  repeats,
  retryId,
  onRetry,
  tail,
}: {
  agent: Agent | undefined;
  items: RunItem[];
  head: boolean;
  results: Map<string, ToolMessage>;
  live: LiveState;
  thinkingMs: Map<string, number>;
  repeats: Map<string, number>;
  /** The message offered "Try again" (the thread's last, when it failed). */
  retryId?: string;
  onRetry?: () => void;
  tail?: RunTail;
}) {
  const liveToolsByCall = live.tools.length ? new Map(live.tools.map((t) => [t.callId, t])) : undefined;
  const approvalsByCall = live.approvals?.length ? new Map(live.approvals.map((a) => [a.callId, a])) : undefined;
  const blocks: Block[] = [];
  for (const item of items) {
    if (item.kind === "assistant") {
      if (item.thinking) blocks.push({ type: "thinking", key: `${item.id}:thinking`, text: item.thinking, ms: thinkingMs.get(item.id) });
      if (item.text) blocks.push({ type: "text", key: `${item.id}:text`, text: item.text });
      for (const call of item.toolCalls) {
        blocks.push({
          type: "tool",
          key: call.id,
          call,
          result: results.get(call.id),
          liveTool: liveToolsByCall?.get(call.id),
          approval: approvalsByCall?.get(call.id),
          busy: live.busy,
        });
      }
      if (item.stopReason === "aborted") blocks.push({ type: "stopped", key: `${item.id}:stopped` });
      else if (item.error)
        blocks.push({ type: "error", key: `${item.id}:error`, error: item.error, repeats: repeats.get(item.id) ?? 1, onRetry: item.id === retryId ? onRetry : undefined });
    } else if (item.kind === "tool") {
      blocks.push({ type: "tool", key: item.id, call: { id: item.callId, name: item.name, args: undefined }, result: item });
    } else {
      blocks.push({ type: "event", key: item.id, message: item });
    }
  }
  if (tail) blocks.push(...liveBlocks(live, tail.shownCalls, tail.thinkingMs, liveToolsByCall, approvalsByCall));
  if (blocks.length === 0 && !head) return null;
  if (blocks.length === 0 && items.length === 0) return null;

  const firstAssistant = items.find((i): i is AssistantMessage => i.kind === "assistant");
  const model = firstAssistant?.model;
  const at = items.find((i) => i.at > 0)?.at;
  const usage = sumUsage(items);
  const copy = items
    .filter((i): i is AssistantMessage => i.kind === "assistant" && !!i.text)
    .map((i) => i.text)
    .join("\n\n");
  const streaming = !!tail && blocks.some((b) => (b.type === "text" || b.type === "thinking") && b.live);
  const presence: AgentPresence | undefined = tail && live.busy ? (live.approvals?.some((a) => a.status === "pending") ? "approval" : "working") : undefined;

  // The rail runs from the avatar (or the first step) down to the last step.
  let lastStep = -1;
  blocks.forEach((b, i) => isStep(b) && (lastStep = i));
  let railStarted = head && lastStep >= 0;

  return (
    <div className={cn("group/run", head ? "mt-7" : "mt-1")}>
      {head && (
        <div className="flex h-8 items-center gap-3.5">
          <AgentAvatar agent={agent} size="md" presence={presence} className="[--presence-ring:var(--panel)]" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-fg">{agent?.name ?? "Agent"}</span>
            {model ? (
              <span className="hidden truncate font-mono text-[11px] text-faint sm:inline">{model}</span>
            ) : (
              tail && agent?.model && <span className="hidden truncate font-mono text-[11px] text-faint sm:inline">{agent.model.modelId}</span>
            )}
            {at ? (
              <time className="shrink-0 font-mono text-[11px] text-faint" dateTime={new Date(at).toISOString()} title={fullDate(at)}>
                {clockTime(at)}
              </time>
            ) : null}
            {tail && live.busy && live.turns > 1 && <span className="shrink-0 font-mono text-[11px] text-accent-text">turn {live.turns}</span>}
            {usage && <UsageHint usage={usage} />}
          </div>
        </div>
      )}
      {blocks.map((block, i) => {
        const rail = { above: railStarted, below: i < lastStep };
        if (isStep(block)) railStarted = true;
        return <BlockView key={block.key} block={block} rail={rail} first={i === 0} />;
      })}
      {copy && !streaming && (
        <div className="flex gap-3.5">
          <div className="w-8 shrink-0" />
          <div className="-ml-1.5 flex h-7 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/run:opacity-100">
            <CopyButton text={copy} label="Copy message" size="xs" />
          </div>
        </div>
      )}
    </div>
  );
});

function UsageHint({ usage: u }: { usage: Usage }) {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
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
      className="ml-auto hidden shrink-0 items-center gap-2.5 font-mono text-[10.5px] text-faint opacity-0 transition-opacity group-hover/run:opacity-100 sm:inline-flex"
    >
      <span>{tokens(prompt)} in</span>
      <span>{tokens(u.output)} out</span>
      {u.cacheRead > 0 && <span className="text-success/90">{Math.round((u.cacheRead / Math.max(1, prompt)) * 100)}% cached</span>}
      <span className="text-muted">{cost(u.cost)}</span>
    </span>
  );
}

type Rail = { above: boolean; below: boolean };

/** One row of a run: the gutter (rail and step node) under the avatar, and the content beside it. */
function TraceRow({ rail, node, glow, children, className }: { rail: Rail; node?: ReactNode; glow?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex gap-3.5", className)}>
      <div className="relative w-8 shrink-0" aria-hidden>
        {node ? (
          <>
            {rail.above && (
              <span className={cn("absolute left-1/2 top-0 h-[7px] w-px -translate-x-1/2", glow ? "bg-gradient-to-b from-border-strong to-accent-line" : "bg-border-strong")} />
            )}
            <span className="absolute left-1/2 top-[7px] -translate-x-1/2">{node}</span>
            {rail.below && <span className="absolute bottom-0 left-1/2 top-[25px] w-px -translate-x-1/2 bg-border-strong" />}
          </>
        ) : (
          rail.above && rail.below && <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-strong" />
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

type NodeTone = "done" | "running" | "queued" | "error" | "approval" | "idle" | "thinking" | "live" | "info" | "warn";

function StepNode({ tone, icon: Icon }: { tone: NodeTone; icon?: typeof Wrench }) {
  const base = "grid size-[18px] place-items-center rounded-full ring-1 [&_svg]:size-[11px]";
  switch (tone) {
    case "done":
      return (
        <span className={cn(base, "bg-surface-2 text-success ring-border-strong")}>
          <Check strokeWidth={2.75} />
        </span>
      );
    case "running":
    case "live":
      return (
        <span className={cn(base, "bg-accent-soft text-accent-text ring-accent-line/55 shadow-[0_0_12px_-2px_var(--accent-glow)]")}>
          {Icon ? <Icon className="animate-pulse-soft" /> : <LoaderCircle className="animate-spin" strokeWidth={2.5} />}
        </span>
      );
    case "queued":
      return (
        <span className={cn(base, "bg-surface-2 text-subtle ring-border-strong")}>
          <LoaderCircle className="animate-spin" strokeWidth={2.5} />
        </span>
      );
    case "error":
      return (
        <span className={cn(base, "bg-danger-soft text-danger ring-danger/45")}>
          <X strokeWidth={2.75} />
        </span>
      );
    case "approval":
      return (
        <span className={cn(base, "bg-warning-soft text-warning ring-warning/55 shadow-[0_0_12px_-3px_var(--warning)]")}>
          <ShieldAlert strokeWidth={2.25} />
        </span>
      );
    case "warn":
      return <span className={cn(base, "bg-warning-soft text-warning ring-warning/40")}>{Icon ? <Icon /> : <TriangleAlert />}</span>;
    case "thinking":
    case "info":
      return <span className={cn(base, "bg-surface-2 text-subtle ring-border-strong")}>{Icon ? <Icon /> : <Info />}</span>;
    default:
      return (
        <span className={cn(base, "bg-surface-2 text-faint ring-border")}>
          <Minus strokeWidth={2.5} />
        </span>
      );
  }
}

function BlockView({ block, rail, first }: { block: Block; rail: Rail; first: boolean }) {
  switch (block.type) {
    case "thinking":
      return <ThinkingStep block={block} rail={rail} />;
    case "tool":
      return <ToolStep block={block} rail={rail} />;
    case "event": {
      const Icon = eventIcon(block.message);
      const tone = block.message.tone === "error" ? "error" : block.message.tone === "warn" ? "warn" : "info";
      return (
        <TraceRow rail={rail} node={tone === "error" ? <StepNode tone="error" /> : <StepNode tone={tone} icon={Icon} />}>
          <p
            className={cn("flex h-8 min-w-0 items-center text-[12.5px]", tone === "error" ? "text-danger" : tone === "warn" ? "text-warning" : "text-subtle")}
            title={block.message.at > 0 ? `${block.message.text}\n${fullDate(block.message.at)}` : block.message.text}
          >
            <span className="truncate">{block.message.text}</span>
          </p>
        </TraceRow>
      );
    }
    case "working":
      return (
        <TraceRow rail={rail} node={<StepNode tone="running" />} glow>
          <div className="flex h-8 items-center gap-2" role="status" aria-label="Agent is working">
            <span className="shimmer-text text-[13px] font-medium">Working</span>
            {block.turns > 1 && <span className="font-mono text-[11px] text-faint">turn {block.turns}</span>}
          </div>
        </TraceRow>
      );
    case "text":
      return (
        <TraceRow rail={rail} className={cn(first ? "pt-1" : "pt-1.5", "pb-1")}>
          <Markdown text={block.text} live={block.live} />
        </TraceRow>
      );
    case "error":
      return (
        <TraceRow rail={rail}>
          <ErrorBox error={block.error} repeats={block.repeats} onRetry={block.onRetry} />
        </TraceRow>
      );
    case "stopped":
      return (
        <TraceRow rail={rail}>
          <StoppedNote />
        </TraceRow>
      );
  }
}

// ---------------------------------------------------------------------------
// Reasoning

function ThinkingStep({ block, rail }: { block: Extract<Block, { type: "thinking" }>; rail: Rail }) {
  const [open, setOpen] = useState(false);
  const label = block.live ? "Reasoning" : block.ms !== undefined ? `Thought for ${block.ms < 1000 ? "a moment" : duration(block.ms)}` : "Reasoning";
  // While it thinks, the latest line of thought shows beside the label.
  const latest = block.live ? block.text.trim().split("\n").filter(Boolean).pop()?.slice(-160) : undefined;
  return (
    <TraceRow rail={rail} node={<StepNode tone={block.live ? "live" : "thinking"} icon={Brain} />} glow={block.live}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group/step -ml-2 flex h-8 w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-subtle transition-colors hover:bg-surface-2/60 hover:text-fg"
      >
        <span className={cn("shrink-0", block.live && "shimmer-text font-medium")}>{label}</span>
        {latest ? <span className="min-w-0 flex-1 truncate text-[12.5px] italic text-faint">{latest}</span> : <span className="flex-1" />}
        <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mb-2 mt-0.5 max-h-80 animate-fade-in overflow-y-auto whitespace-pre-wrap border-l-2 border-border-strong pl-3.5 text-[13px] leading-relaxed text-subtle">
          {block.text}
        </div>
      )}
    </TraceRow>
  );
}

// ---------------------------------------------------------------------------
// Tool calls

const TOOL_ICONS: [RegExp, typeof Wrench][] = [
  [/fetch|web|browse|http|search/i, Globe],
  [/memory|remember|recall|forget/i, Brain],
  [/agent|delegate|ask_/i, Users],
  [/schedule|remind|sleep|timer|automation/i, Clock],
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

type ToolState = "running" | "pending" | "approval" | "done" | "error" | "unknown";

const NODE_FOR: Record<ToolState, NodeTone> = { running: "running", pending: "queued", approval: "approval", done: "done", error: "error", unknown: "idle" };

function ToolStep({ block, rail }: { block: Extract<Block, { type: "tool" }>; rail: Rail }) {
  const { call, result, liveTool, approval, busy, streaming } = block;
  const [open, setOpen] = useState(false);
  const waiting = !result && approval?.status === "pending";
  const status: ToolState = result
    ? result.isError
      ? "error"
      : "done"
    : waiting
      ? "approval"
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
  const args = useMemo(() => (open ? prettyArgs(call.args) : ""), [open, call.args]);

  return (
    <TraceRow rail={rail} node={<StepNode tone={NODE_FOR[status]} />} glow={status === "running"}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group/step -ml-2 flex h-8 w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-surface-2/60"
      >
        <Icon className={cn("size-3.5 shrink-0", status === "running" ? "text-accent-text" : "text-faint")} />
        <span className="shrink-0 font-mono text-[12.5px] font-medium text-fg">{call.name}</span>
        {summary ? <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-subtle">{summary}</span> : <span className="flex-1" />}
        <ToolStatusLabel status={status} />
        <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform group-hover/step:text-subtle", open && "rotate-90")} />
      </button>
      {waiting && approval && <ApprovalWaiting approval={approval} className="mb-2 mt-1" />}
      {open && (
        <div className="mb-2 mt-1 animate-fade-in overflow-hidden rounded-xl border border-border bg-code shadow-xs">
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
    </TraceRow>
  );
}

/** A tool result that arrived without its call, shown as a lone step. */
export function OrphanToolStep({ message }: { message: ToolMessage }) {
  return (
    <div className="mt-2">
      <ToolStep block={{ type: "tool", key: message.id, call: { id: message.callId, name: message.name, args: undefined }, result: message }} rail={{ above: false, below: false }} />
    </div>
  );
}

function ToolStatusLabel({ status }: { status: ToolState }) {
  switch (status) {
    case "running":
      return <span className="shrink-0 font-mono text-[11px] text-accent-text">running</span>;
    case "pending":
      return <span className="shrink-0 font-mono text-[11px] text-faint">queued</span>;
    case "approval":
      return <span className="shrink-0 font-mono text-[11px] text-warning">needs approval</span>;
    case "error":
      return <span className="shrink-0 font-mono text-[11px] text-danger">failed</span>;
    default:
      return null;
  }
}

function ToolSection({ label, children, copy, tone }: { label: string; children: ReactNode; copy?: string; tone?: "error" }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex h-8 items-center justify-between pl-3 pr-1.5">
        <span className="label-mono text-faint">{label}</span>
        {copy && <CopyButton text={copy} size="xs" />}
      </div>
      <pre className={cn("max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[12px] leading-relaxed", tone === "error" ? "text-danger" : "text-muted")}>
        {children}
      </pre>
    </div>
  );
}
