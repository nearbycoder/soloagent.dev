import type { Agent, ConnectorKind, Source } from "@soloagent/client";
import { useId } from "react";
import { Bot, Clock, Code, Globe, Send, SquareTerminal, Webhook } from "lucide-react";
import { cn } from "../lib/cn.ts";

/**
 * The soloagent mark: a monoline "s" trail (the durable record) with the agent as a dot at its head,
 * on a lit ink squircle. Gradient ids are per instance so several marks can share a page.
 */
export function SoloMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b2a22" />
          <stop offset="1" stopColor="#0d0c09" />
        </linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.35" stopColor="#fff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.03" />
        </linearGradient>
        <linearGradient id={`${id}l`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e6ff74" />
          <stop offset="1" stopColor="#b7dc16" />
        </linearGradient>
      </defs>
      <path d={SQUIRCLE} fill={`url(#${id}t)`} />
      <path d={SQUIRCLE_RIM} fill="none" stroke={`url(#${id}r)`} strokeWidth="1.2" />
      <path d="M26.25 17.01 A8.6 8.6 0 1 0 32 32.00 A8.6 8.6 0 1 1 24.41 44.64" fill="none" stroke={`url(#${id}l)`} strokeWidth="8.4" strokeLinecap="round" />
      <circle cx="39.97" cy="20.18" r="4.7" fill={`url(#${id}l)`} />
    </svg>
  );
}

const SQUIRCLE = "M64.00 32.00 L63.99 40.76 L63.96 43.56 L63.91 45.59 L63.84 47.24 L63.75 48.64 L63.64 49.88 L63.51 50.99 L63.36 52.01 L63.19 52.93 L63.00 53.79 L62.79 54.59 L62.56 55.33 L62.30 56.03 L62.02 56.68 L61.72 57.30 L61.40 57.87 L61.05 58.42 L60.68 58.93 L60.28 59.41 L59.86 59.86 L59.41 60.28 L58.93 60.68 L58.42 61.05 L57.87 61.40 L57.30 61.72 L56.68 62.02 L56.03 62.30 L55.33 62.56 L54.59 62.79 L53.79 63.00 L52.93 63.19 L52.01 63.36 L50.99 63.51 L49.88 63.64 L48.64 63.75 L47.24 63.84 L45.59 63.91 L43.56 63.96 L40.76 63.99 L32.00 64.00 L23.24 63.99 L20.44 63.96 L18.41 63.91 L16.76 63.84 L15.36 63.75 L14.12 63.64 L13.01 63.51 L11.99 63.36 L11.07 63.19 L10.21 63.00 L9.41 62.79 L8.67 62.56 L7.97 62.30 L7.32 62.02 L6.70 61.72 L6.13 61.40 L5.58 61.05 L5.07 60.68 L4.59 60.28 L4.14 59.86 L3.72 59.41 L3.32 58.93 L2.95 58.42 L2.60 57.87 L2.28 57.30 L1.98 56.68 L1.70 56.03 L1.44 55.33 L1.21 54.59 L1.00 53.79 L0.81 52.93 L0.64 52.01 L0.49 50.99 L0.36 49.88 L0.25 48.64 L0.16 47.24 L0.09 45.59 L0.04 43.56 L0.01 40.76 L0.00 32.00 L0.01 23.24 L0.04 20.44 L0.09 18.41 L0.16 16.76 L0.25 15.36 L0.36 14.12 L0.49 13.01 L0.64 11.99 L0.81 11.07 L1.00 10.21 L1.21 9.41 L1.44 8.67 L1.70 7.97 L1.98 7.32 L2.28 6.70 L2.60 6.13 L2.95 5.58 L3.32 5.07 L3.72 4.59 L4.14 4.14 L4.59 3.72 L5.07 3.32 L5.58 2.95 L6.13 2.60 L6.70 2.28 L7.32 1.98 L7.97 1.70 L8.67 1.44 L9.41 1.21 L10.21 1.00 L11.07 0.81 L11.99 0.64 L13.01 0.49 L14.12 0.36 L15.36 0.25 L16.76 0.16 L18.41 0.09 L20.44 0.04 L23.24 0.01 L32.00 0.00 L40.76 0.01 L43.56 0.04 L45.59 0.09 L47.24 0.16 L48.64 0.25 L49.88 0.36 L50.99 0.49 L52.01 0.64 L52.93 0.81 L53.79 1.00 L54.59 1.21 L55.33 1.44 L56.03 1.70 L56.68 1.98 L57.30 2.28 L57.87 2.60 L58.42 2.95 L58.93 3.32 L59.41 3.72 L59.86 4.14 L60.28 4.59 L60.68 5.07 L61.05 5.58 L61.40 6.13 L61.72 6.70 L62.02 7.32 L62.30 7.97 L62.56 8.67 L62.79 9.41 L63.00 10.21 L63.19 11.07 L63.36 11.99 L63.51 13.01 L63.64 14.12 L63.75 15.36 L63.84 16.76 L63.91 18.41 L63.96 20.44 L63.99 23.24Z";
const SQUIRCLE_RIM = "M63.40 32.00 L63.39 40.60 L63.36 43.34 L63.31 45.34 L63.24 46.95 L63.16 48.33 L63.05 49.55 L62.92 50.64 L62.78 51.63 L62.61 52.54 L62.42 53.38 L62.21 54.17 L61.98 54.90 L61.73 55.58 L61.46 56.22 L61.17 56.82 L60.85 57.39 L60.51 57.92 L60.14 58.42 L59.75 58.89 L59.34 59.34 L58.89 59.75 L58.42 60.14 L57.92 60.51 L57.39 60.85 L56.82 61.17 L56.22 61.46 L55.58 61.73 L54.90 61.98 L54.17 62.21 L53.38 62.42 L52.54 62.61 L51.63 62.78 L50.64 62.92 L49.55 63.05 L48.33 63.16 L46.95 63.24 L45.34 63.31 L43.34 63.36 L40.60 63.39 L32.00 63.40 L23.40 63.39 L20.66 63.36 L18.66 63.31 L17.05 63.24 L15.67 63.16 L14.45 63.05 L13.36 62.92 L12.37 62.78 L11.46 62.61 L10.62 62.42 L9.83 62.21 L9.10 61.98 L8.42 61.73 L7.78 61.46 L7.18 61.17 L6.61 60.85 L6.08 60.51 L5.58 60.14 L5.11 59.75 L4.66 59.34 L4.25 58.89 L3.86 58.42 L3.49 57.92 L3.15 57.39 L2.83 56.82 L2.54 56.22 L2.27 55.58 L2.02 54.90 L1.79 54.17 L1.58 53.38 L1.39 52.54 L1.22 51.63 L1.08 50.64 L0.95 49.55 L0.84 48.33 L0.76 46.95 L0.69 45.34 L0.64 43.34 L0.61 40.60 L0.60 32.00 L0.61 23.40 L0.64 20.66 L0.69 18.66 L0.76 17.05 L0.84 15.67 L0.95 14.45 L1.08 13.36 L1.22 12.37 L1.39 11.46 L1.58 10.62 L1.79 9.83 L2.02 9.10 L2.27 8.42 L2.54 7.78 L2.83 7.18 L3.15 6.61 L3.49 6.08 L3.86 5.58 L4.25 5.11 L4.66 4.66 L5.11 4.25 L5.58 3.86 L6.08 3.49 L6.61 3.15 L7.18 2.83 L7.78 2.54 L8.42 2.27 L9.10 2.02 L9.83 1.79 L10.62 1.58 L11.46 1.39 L12.37 1.22 L13.36 1.08 L14.45 0.95 L15.67 0.84 L17.05 0.76 L18.66 0.69 L20.66 0.64 L23.40 0.61 L32.00 0.60 L40.60 0.61 L43.34 0.64 L45.34 0.69 L46.95 0.76 L48.33 0.84 L49.55 0.95 L50.64 1.08 L51.63 1.22 L52.54 1.39 L53.38 1.58 L54.17 1.79 L54.90 2.02 L55.58 2.27 L56.22 2.54 L56.82 2.83 L57.39 3.15 L57.92 3.49 L58.42 3.86 L58.89 4.25 L59.34 4.66 L59.75 5.11 L60.14 5.58 L60.51 6.08 L60.85 6.61 L61.17 7.18 L61.46 7.78 L61.73 8.42 L61.98 9.10 L62.21 9.83 L62.42 10.62 L62.61 11.46 L62.78 12.37 L62.92 13.36 L63.05 14.45 L63.16 15.67 L63.24 17.05 L63.31 18.66 L63.36 20.66 L63.39 23.40Z";

/** Kept for callers that want the glyph alone, e.g. loading states. */
export const SparkMark = SoloMark;

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-[-0.02em] text-fg", className)}>
      <SoloMark className="size-6" />
      {!compact && <span className="font-display text-[16px]">soloagent</span>}
    </span>
  );
}

/** Agent avatar: the glyph on a tile tinted with the agent color. */
export function AgentAvatar({ agent, size = "md", className }: { agent: Pick<Agent, "avatar" | "color" | "name"> | undefined; size?: "xs" | "sm" | "md" | "lg" | "xl"; className?: string }) {
  const color = agent?.color ?? "#9cbf10";
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
      {agent?.avatar || "●"}
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
  webhook: { bg: "#d2f53c", fg: "#15140f", label: "Webhook" },
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
    demo: "#9cbf10",
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
  const dims = { sm: "size-6 text-[11px] rounded-md", md: "size-9 text-[14px] rounded-lg", lg: "size-11 text-[17px] rounded-xl" }[size];
  // The built-in demo provider is soloagent itself: show the mark, not a monogram.
  if (id === "demo") return <SoloMark className={cn("shrink-0", dims.split(" ")[0])} />;
  const label = id === "xai" ? "𝕏" : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?";
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
