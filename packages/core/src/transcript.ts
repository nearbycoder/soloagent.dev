import type { EntryRecord, LiveState as PiLiveState } from "@earendil-works/pi-durable";
import type { Author, LiveState, Message, Source, ToolCallInfo, Usage } from "@soloagent/client";

/** Entry kind soloagent places inputs as, carrying who said it and where. */
export const MESSAGE_ENTRY = "solo.message";
/** Display-only notices: connector events, reminders set, delegations. */
export const EVENT_ENTRY = "solo.event";

export type MessageEntryData = { author: Author; text: string; at: number };
export type EventEntryData = { text: string; tone: "info" | "warn" | "error"; at: number };

type AnyBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type AnyMessage = {
  role: string;
  content?: string | AnyBlock[];
  timestamp?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } };
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export function textOf(content: AnyMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function thinkingOf(content: AnyMessage["content"]): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b) => b.type === "thinking")
    .map((b) => b.thinking ?? "")
    .join("\n")
    .trim();
  return text || undefined;
}

function toolCallsOf(content: AnyMessage["content"]): ToolCallInfo[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "toolCall")
    .map((b) => ({ id: b.id ?? "", name: b.name ?? "tool", args: b.arguments ?? {} }));
}

export function usageOf(usage: AnyMessage["usage"]): Usage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost?.total ?? 0,
  };
}

/** Normalize one Pi Durable entry into zero or more transcript messages. */
export function toMessages(entry: EntryRecord, threadId: string, agentId: string): Message[] {
  const id = String(entry.id);
  const message = entry.model?.[0] as AnyMessage | undefined;
  const at = message?.timestamp ?? 0;
  switch (entry.kind) {
    case MESSAGE_ENTRY: {
      const data = entry.data as MessageEntryData;
      return [{ id, kind: "user", threadId, author: data.author, text: data.text, at: data.at }];
    }
    case "pi.user":
      return [{ id, kind: "user", threadId, author: { name: "You", source: "api" }, text: textOf(message?.content), at }];
    case "pi.assistant": {
      if (!message) return [];
      return [
        {
          id,
          kind: "assistant",
          threadId,
          agentId,
          text: textOf(message.content),
          thinking: thinkingOf(message.content),
          toolCalls: toolCallsOf(message.content),
          model: message.provider && message.model ? `${message.provider}/${message.model}` : undefined,
          usage: usageOf(message.usage),
          stopReason: message.stopReason,
          error: message.stopReason === "error" || message.stopReason === "aborted" ? (message.errorMessage ?? message.stopReason) : undefined,
          at,
        },
      ];
    }
    case "pi.tool-result": {
      if (!message) return [];
      return [
        {
          id,
          kind: "tool",
          threadId,
          callId: message.toolCallId ?? "",
          name: message.toolName ?? "tool",
          text: textOf(message.content),
          isError: message.isError === true,
          at,
        },
      ];
    }
    case "pi.reset":
      return [{ id, kind: "event", threadId, text: "Context reset — the agent starts fresh from here.", tone: "info", at }];
    case "pi.compaction":
      return [{ id, kind: "event", threadId, text: "Earlier messages were summarized to make room.", tone: "info", at }];
    case EVENT_ENTRY: {
      const data = entry.data as EventEntryData;
      return [{ id, kind: "event", threadId, text: data.text, tone: data.tone, at: data.at }];
    }
    default:
      return [];
  }
}

export function toLive(docs: Readonly<Record<string, unknown>>): LiveState {
  const live = (docs["pi.live"] ?? {}) as PiLiveState;
  const inbox = (docs["pi.inbox"] ?? {}) as { items?: unknown[] };
  const message = live.generation?.message as AnyMessage | undefined;
  return {
    busy: live.run !== undefined,
    queued: Array.isArray(inbox.items) ? inbox.items.length : 0,
    turns: live.run?.turns ?? 0,
    partial: message
      ? { text: textOf(message.content), thinking: thinkingOf(message.content), toolCalls: toolCallsOf(message.content) }
      : undefined,
    tools: (live.tools ?? []).map((slot) => ({ callId: slot.callId, name: slot.name, status: slot.status, output: slot.output?.slice(-4000) })),
    retry: live.generation?.retry,
    failure: live.run === undefined && live.runFailure ? { reason: live.runFailure.reason, detail: live.runFailure.detail } : undefined,
  };
}

export function sourceLabel(source: Source): string {
  return { web: "Web", tui: "Terminal", api: "API", slack: "Slack", discord: "Discord", telegram: "Telegram", webhook: "Webhook", schedule: "Schedule", agent: "Agent" }[source];
}
