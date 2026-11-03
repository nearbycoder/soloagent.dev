/** Pure formatting helpers shared by the TUI and the print-mode commands. No terminal dependencies. */
import type { Message, Source, Usage } from "@soloagent/client";

export function relTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clock(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

export function money(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 10) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function seconds(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export const SOURCE_ICON: Record<Source, string> = {
  tui: "❯",
  web: "◎",
  api: "λ",
  slack: "#",
  discord: "◆",
  telegram: "➤",
  webhook: "↯",
  schedule: "◷",
  agent: "✦",
};

export const SOURCE_LABEL: Record<Source, string> = {
  tui: "terminal",
  web: "web",
  api: "api",
  slack: "slack",
  discord: "discord",
  telegram: "telegram",
  webhook: "webhook",
  schedule: "schedule",
  agent: "agent",
};

export function sourceIcon(source: Source): string {
  return SOURCE_ICON[source] ?? "•";
}

/** Collapse whitespace so a value fits on one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** `url: "https://…", depth: 2` — compact, single-line rendering of tool arguments. */
export function summarizeArgs(args: unknown, max = 60): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return clip(oneLine(String(args)), max);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  const parts = entries.map(([key, value]) => {
    const rendered = typeof value === "string" ? JSON.stringify(clip(oneLine(value), 48)) : clip(oneLine(JSON.stringify(value) ?? ""), 32);
    return entries.length === 1 ? rendered : `${key}: ${rendered}`;
  });
  return clip(parts.join(", "), max);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

/** Sum token usage over the loaded transcript. */
export function totalUsage(messages: readonly Message[]): Usage & { lastContext: number } {
  const total = { ...emptyUsage(), lastContext: 0 };
  for (const m of messages) {
    if (m.kind !== "assistant" || !m.usage) continue;
    total.input += m.usage.input;
    total.output += m.usage.output;
    total.cacheRead += m.usage.cacheRead;
    total.cacheWrite += m.usage.cacheWrite;
    total.cost += m.usage.cost;
    total.lastContext = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite + m.usage.output;
  }
  return total;
}

export function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
