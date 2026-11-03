import type { Agent, ConnectorKind, Source } from "@soloagent/client";
import { Bot, Clock, Code, Globe, Send, SquareTerminal, Webhook } from "lucide-react";
import { cn } from "../lib/cn.ts";

/** The ✦ mark: a four-point star. */
export function SparkMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 1.5c.7 5.6 4.9 9.8 10.5 10.5-5.6.7-9.8 4.9-10.5 10.5C11.3 16.9 7.1 12.7 1.5 12 7.1 11.3 11.3 7.1 12 1.5z" fill="currentColor" />
    </svg>
  );
}

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-[-0.02em] text-fg", className)}>
      <span className="grid size-6 place-items-center rounded-[7px] bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_2px_8px_-2px_var(--accent)]">
        <SparkMark className="size-3.5" />
      </span>
      {!compact && <span className="text-[15px]">soloagent</span>}
    </span>
  );
}

/** Agent avatar: the glyph on a tile tinted with the agent color. */
export function AgentAvatar({ agent, size = "md", className }: { agent: Pick<Agent, "avatar" | "color" | "name"> | undefined; size?: "xs" | "sm" | "md" | "lg" | "xl"; className?: string }) {
  const color = agent?.color ?? "#71717a";
  const dims = { xs: "size-4 text-[9px] rounded", sm: "size-6 text-[12px] rounded-md", md: "size-8 text-[15px] rounded-lg", lg: "size-11 text-[20px] rounded-xl", xl: "size-14 text-[26px] rounded-2xl" }[size];
  return (
    <span
      className={cn("grid shrink-0 place-items-center leading-none select-none", dims, className)}
      style={{
        background: `color-mix(in srgb, ${color} 18%, var(--surface-2))`,
        color: `color-mix(in srgb, ${color} 75%, var(--fg))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 30%, transparent)`,
      }}
      aria-hidden="true"
    >
      {agent?.avatar || "✦"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Platform marks. Simplified, monochrome-friendly drawings.

export function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="9.5" y="2" width="3.6" height="9" rx="1.8" fill="#36C5F0" />
      <rect x="2" y="10.9" width="9" height="3.6" rx="1.8" fill="#2EB67D" transform="translate(0 -1.4)" />
      <rect x="10.9" y="13" width="3.6" height="9" rx="1.8" fill="#ECB22E" />
      <rect x="13" y="9.5" width="9" height="3.6" rx="1.8" fill="#E01E5A" />
      <circle cx="6.8" cy="6.8" r="1.8" fill="#36C5F0" />
      <circle cx="17.2" cy="6.8" r="1.8" fill="#E01E5A" />
      <circle cx="17.2" cy="17.2" r="1.8" fill="#ECB22E" />
      <circle cx="6.8" cy="17.2" r="1.8" fill="#2EB67D" />
    </svg>
  );
}

export function DiscordMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.6 5.3A17 17 0 0 0 15.4 4l-.5 1a15.7 15.7 0 0 0-5.8 0L8.6 4a17 17 0 0 0-4.2 1.3C1.7 9.3 1 13.2 1.3 17a17 17 0 0 0 5.2 2.6l1.1-1.8c-.6-.2-1.2-.5-1.7-.8l.4-.3a12.2 12.2 0 0 0 11.4 0l.4.3c-.5.3-1.1.6-1.7.8l1.1 1.8a17 17 0 0 0 5.2-2.6c.4-4.4-.7-8.3-3.1-11.7zM8.5 14.7c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1zm7 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z"
      />
    </svg>
  );
}

export const KIND_STYLE: Record<ConnectorKind, { bg: string; fg: string; label: string }> = {
  slack: { bg: "#4A154B", fg: "#ffffff", label: "Slack" },
  discord: { bg: "#5865F2", fg: "#ffffff", label: "Discord" },
  telegram: { bg: "#229ED9", fg: "#ffffff", label: "Telegram" },
  webhook: { bg: "#18181b", fg: "#ffffff", label: "Webhook" },
};

/** A colored tile with the platform mark. */
export function ConnectorTile({ kind, size = "md", className }: { kind: ConnectorKind; size?: "sm" | "md" | "lg"; className?: string }) {
  const s = KIND_STYLE[kind];
  const dims = { sm: "size-7 rounded-md", md: "size-9 rounded-lg", lg: "size-11 rounded-xl" }[size];
  const icon = { sm: "size-4", md: "size-5", lg: "size-6" }[size];
  return (
    <span
      className={cn("grid shrink-0 place-items-center shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]", dims, className)}
      style={{ background: kind === "slack" ? "#ffffff" : s.bg, color: s.fg }}
    >
      {kind === "slack" ? (
        <SlackMark className={icon} />
      ) : kind === "discord" ? (
        <DiscordMark className={icon} />
      ) : kind === "telegram" ? (
        <Send className={cn(icon, "-translate-x-px translate-y-px")} strokeWidth={2.2} />
      ) : (
        <Webhook className={icon} />
      )}
    </span>
  );
}

export const SOURCE_LABEL: Record<Source, string> = {
  web: "Web",
  tui: "Terminal",
  api: "API",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  webhook: "Webhook",
  schedule: "Schedule",
  agent: "Agent",
};

/** Small inline icon for where a thread or message came from. */
export function SourceIcon({ source, className }: { source: Source; className?: string }) {
  const c = cn("size-3.5 shrink-0", className);
  switch (source) {
    case "slack":
      return <SlackMark className={c} />;
    case "discord":
      return <DiscordMark className={cn(c, "text-[#5865F2]")} />;
    case "telegram":
      return <Send className={cn(c, "text-[#229ED9]")} />;
    case "webhook":
      return <Webhook className={cn(c, "text-warning")} />;
    case "tui":
      return <SquareTerminal className={cn(c, "text-success")} />;
    case "api":
      return <Code className={cn(c, "text-info")} />;
    case "schedule":
      return <Clock className={cn(c, "text-accent-text")} />;
    case "agent":
      return <Bot className={cn(c, "text-accent-text")} />;
    default:
      return <Globe className={cn(c, "text-subtle")} />;
  }
}

export function SourceBadge({ source, className }: { source: Source; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 text-[11px] font-medium text-muted", className)}>
      <SourceIcon source={source} className="size-3" />
      {SOURCE_LABEL[source]}
    </span>
  );
}

/** Deterministic monogram tile for model providers. */
export function ProviderMark({ id, name, size = "md" }: { id: string; name: string; size?: "sm" | "md" | "lg" }) {
  const palette: Record<string, string> = {
    anthropic: "#d97757",
    openai: "#10a37f",
    "openai-codex": "#10a37f",
    "github-copilot": "#6e40c9",
    google: "#4285f4",
    "google-vertex": "#4285f4",
    xai: "#71717a",
    openrouter: "#6467f2",
    groq: "#f55036",
    mistral: "#fa520f",
    deepseek: "#4d6bfe",
    demo: "#8b5cf6",
    meta: "#0866ff",
    "kimi-coding": "#1f2937",
    "amazon-bedrock": "#ff9900",
    azure: "#0078d4",
    cerebras: "#f15a29",
    huggingface: "#ffbd2e",
    nvidia: "#76b900",
    together: "#0f6fff",
    fireworks: "#5019c5",
  };
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = palette[id] ?? `hsl(${hash % 360} 55% 52%)`;
  const label = id === "demo" ? "✦" : id === "xai" ? "𝕏" : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1) || "?";
  const dims = { sm: "size-6 text-[11px] rounded-md", md: "size-9 text-[14px] rounded-lg", lg: "size-11 text-[17px] rounded-xl" }[size];
  return (
    <span
      className={cn("grid shrink-0 place-items-center font-semibold select-none", dims)}
      style={{ background: `color-mix(in srgb, ${color} 16%, var(--surface-2))`, color: `color-mix(in srgb, ${color} 80%, var(--fg))`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 28%, transparent)` }}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}
