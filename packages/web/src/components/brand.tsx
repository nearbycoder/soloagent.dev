import type { Agent, ConnectorKind, Source } from "@soloagent/client";
import { Bot, Clock, Code, Globe, Send, SquareTerminal, Webhook } from "lucide-react";
import { cn } from "../lib/cn.ts";

/** The soloagent mark: a Martian Mono "s" in lime on an ink tile. */
export function SoloMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="var(--mark-tile)" />
      <g fill="var(--mark-glyph)"><path transform="matrix(0.05606 0 0 0.05606 13.220 49.879)" d="M241.33251953125 -194.0Q254.66583251953125 -161.9998779296875 277.66558837890625 -146.333251953125Q300.66534423828125 -130.6666259765625 336.6650390625 -130.6666259765625Q372.33111572265625 -130.6666259765625 392.1642150878906 -143.33331298828125Q411.997314453125 -156.0 411.997314453125 -177.333251953125Q411.997314453125 -198.33319091796875 398.8307800292969 -209.66653442382812Q385.66424560546875 -220.9998779296875 355.3311767578125 -224.66656494140625L270.6651611328125 -236.0Q171.33221435546875 -250.00018310546875 123.99917602539062 -296.5001220703125Q76.6661376953125 -343.00006103515625 76.6661376953125 -429.0Q76.6661376953125 -527.0 143.33251953125 -583.5Q209.9989013671875 -640.0 327.3316650390625 -640.0Q453.3310546875 -640.0 520.9974365234375 -583.1666564941406Q588.663818359375 -526.3333129882812 594.663818359375 -414.0H430.6640625Q419.3306884765625 -452.33343505859375 394.49761962890625 -470.8334045410156Q369.66455078125 -489.3333740234375 327.3316650390625 -489.3333740234375Q289.332275390625 -489.3333740234375 268.33251953125 -476.16668701171875Q247.332763671875 -463.0 247.332763671875 -439.3333740234375Q247.332763671875 -418.66668701171875 260.8326416015625 -407.3333435058594Q274.33251953125 -396.0 303.9989013671875 -391.6666259765625L388.6649169921875 -380.33319091796875Q488.3311767578125 -366.99969482421875 535.49755859375 -321.16644287109375Q582.6639404296875 -275.33319091796875 582.6639404296875 -191.0Q582.6639404296875 -125.3333740234375 553.3307189941406 -78.00003051757812Q523.9974975585938 -30.66668701171875 468.99774169921875 -5.333343505859375Q413.99798583984375 20.0 336.6650390625 20.0Q215.66552734375 20.0 149.83245849609375 -34.0Q83.9993896484375 -88.0 75.332763671875 -194.0Z"/></g>
    </svg>
  );
}

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
