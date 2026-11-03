import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Bot,
  ChartNoAxesColumn,
  CornerDownLeft,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Moon,
  Plug,
  Plus,
  Repeat,
  ShieldCheck,
  Wrench,
  Search,
  Settings,
  Users,
  SquarePen,
} from "lucide-react";
import { useApp, useIsAdmin } from "../api/store.ts";
import { cn } from "../lib/cn.ts";
import { shortTime } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { toggleTheme } from "../lib/theme.ts";
import { AgentAvatar, SourceIcon } from "./brand.tsx";
import { Kbd } from "./ui.tsx";

type Item = {
  id: string;
  group: string;
  label: string;
  hint?: ReactNode;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
};

/** Pages members don't see. */
const ADMIN_PAGES = new Set(["p-providers", "p-connections", "p-tools", "p-team"]);

export function CommandPalette({ open, onClose, onSignOut }: { open: boolean; onClose: () => void; onSignOut: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const agents = useApp((s) => s.agents);
  const threads = useApp((s) => s.threads);
  const isAdmin = useIsAdmin();

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (path: string) => () => navigate(path);
    const pages: Item[] = [
      { id: "p-overview", group: "Go to", label: "Overview", icon: <LayoutDashboard />, run: go("/"), keywords: "home dashboard" },
      { id: "p-chat", group: "Go to", label: "Chat", icon: <MessagesSquare />, run: go("/chat"), keywords: "threads conversations" },
      { id: "p-agents", group: "Go to", label: "Agents", icon: <Bot />, run: go("/agents") },
      { id: "p-providers", group: "Go to", label: "Providers", icon: <KeyRound />, run: go("/providers"), keywords: "subscriptions keys models login claude chatgpt copilot" },
      { id: "p-connections", group: "Go to", label: "Connections", icon: <Plug />, run: go("/connections"), keywords: "slack discord telegram webhook connectors" },
      { id: "p-tools", group: "Go to", label: "Tools", icon: <Wrench />, run: go("/tools"), keywords: "mcp servers github linear integrations" },
      { id: "p-activity", group: "Go to", label: "Activity", icon: <Activity />, run: go("/activity"), keywords: "tasks schedules log" },
      { id: "p-approvals", group: "Go to", label: "Approvals", icon: <ShieldCheck />, run: go("/approvals"), keywords: "approve deny pending tool calls" },
      { id: "p-automations", group: "Go to", label: "Automations", icon: <Repeat />, run: go("/automations"), keywords: "cron recurring schedule standup digest" },
      { id: "p-usage", group: "Go to", label: "Usage", icon: <ChartNoAxesColumn />, run: go("/usage"), keywords: "cost tokens spend" },
      { id: "p-team", group: "Go to", label: "Team", icon: <Users />, run: go("/team"), keywords: "users members invites roles" },
      { id: "p-settings", group: "Go to", label: "Settings", icon: <Settings />, run: go("/settings"), keywords: "tui terminal theme" },
    ];
    const chats: Item[] = (agents ?? []).map((agent) => ({
      id: `a-${agent.id}`,
      group: "New chat",
      label: `New chat with ${agent.name}`,
      hint: <span className="font-mono">@{agent.handle}</span>,
      keywords: `${agent.handle} ${agent.description}`,
      icon: <AgentAvatar agent={agent} size="xs" className="size-[18px] text-[10px]" />,
      run: go(`/chat/new/${agent.id}`),
    }));
    const agentMap = new Map((agents ?? []).map((a) => [a.id, a]));
    const recent: Item[] = (threads ?? []).slice(0, 200).map((thread) => ({
      id: `t-${thread.id}`,
      group: "Threads",
      label: thread.title || "Untitled",
      hint: shortTime(thread.updatedAt),
      keywords: `${thread.preview} ${thread.location ?? ""} ${thread.source} ${agentMap.get(thread.agentId)?.name ?? ""}`,
      icon: <SourceIcon source={thread.source} />,
      run: go(`/chat/${thread.id}`),
    }));
    const actions: Item[] = [
      ...(isAdmin
        ? [
            { id: "x-agent", group: "Actions", label: "Create an agent", icon: <Plus />, run: go("/agents/new") },
            { id: "x-connect", group: "Actions", label: "Add a connection", icon: <Plug />, run: go("/connections/new"), keywords: "slack discord telegram webhook" },
            { id: "x-invite", group: "Actions", label: "Invite someone", icon: <Users />, run: go("/team"), keywords: "team users members invite" },
          ]
        : []),
      { id: "x-theme", group: "Actions", label: "Toggle light / dark theme", icon: <Moon />, run: toggleTheme, keywords: "appearance mode" },
      { id: "x-out", group: "Actions", label: "Sign out", icon: <LogOut />, run: onSignOut, keywords: "logout" },
    ];
    return [...pages.filter((p) => isAdmin || !ADMIN_PAGES.has(p.id)), ...chats, ...recent, ...actions];
  }, [agents, threads, onSignOut, isAdmin]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Without a query, show pages, new-chat shortcuts, and the most recent threads.
      let threadCount = 0;
      return items.filter((item) => item.group !== "Threads" || threadCount++ < 6);
    }
    const terms = q.split(/\s+/);
    const scored = items
      .map((item) => {
        const label = item.label.toLowerCase();
        const hay = `${label} ${item.keywords ?? ""}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return null;
        const score = (label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2) + (item.group === "Threads" ? 0.5 : 0);
        return { item, score };
      })
      .filter((x): x is { item: Item; score: number } => x !== null)
      .sort((a, b) => a.score - b.score);
    // Keep groups together in their first-seen order.
    const order: string[] = [];
    for (const { item } of scored) if (!order.includes(item.group)) order.push(item.group);
    return order.flatMap((group) => scored.filter((s) => s.item.group === group).slice(0, group === "Threads" ? 12 : 20).map((s) => s.item));
  }, [items, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[index]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";
  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-center px-3 pt-[10vh] sm:pt-[14vh]">
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)] backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative flex max-h-[min(560px,72vh)] w-full max-w-[600px] animate-scale-in flex-col overflow-hidden rounded-2xl border border-border bg-overlay shadow-lg"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-subtle" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, agents, threads…"
            className="h-13 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[index] ? `palette-${results[index].id}` : undefined}
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={list} id="palette-list" role="listbox" className="min-h-0 overflow-y-auto p-1.5">
          {results.length === 0 && <div className="px-4 py-10 text-center text-[13px] text-subtle">No results for “{query}”</div>}
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wider text-faint">{header}</div>}
                <button
                  type="button"
                  id={`palette-${item.id}`}
                  role="option"
                  aria-selected={i === index}
                  data-index={i}
                  onMouseMove={() => i !== index && setIndex(i)}
                  onClick={() => run(item)}
                  className={cn(
                    "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13.5px] [&_svg]:size-4 [&_svg]:shrink-0",
                    i === index ? "bg-surface-2 text-fg" : "text-muted",
                  )}
                >
                  <span className="grid w-[18px] place-items-center text-subtle">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-[12px] text-faint">{item.hint}</span>}
                  {i === index && <CornerDownLeft className="!size-3.5 text-subtle" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="hidden items-center gap-4 border-t border-border px-4 py-2 text-[11.5px] text-faint sm:flex">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> open
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <SquarePen className="size-3" /> type an agent name to start a chat
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
