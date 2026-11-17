import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  ArrowUp,
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
} from "lucide-react";
import type { Agent } from "@soloagent/client";
import { startChat } from "../api/actions.ts";
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
  label: ReactNode;
  /** Text matched against the query. Defaults to the label when it's a string. */
  text?: string;
  hint?: ReactNode;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
};

/** Pages members don't see. */
const ADMIN_PAGES = new Set(["p-providers", "p-connections", "p-tools", "p-team"]);

/** "@coder fix the build" → the coder agent and "fix the build". */
function addressed(query: string, agents: Agent[]): { agent: Agent | undefined; text: string } {
  const match = /^@([a-z0-9][a-z0-9-]*)\s+([\s\S]+)$/i.exec(query.trim());
  if (match) {
    const agent = agents.find((a) => a.handle.toLowerCase() === match[1]!.toLowerCase());
    if (agent) return { agent, text: match[2]!.trim() };
  }
  return { agent: agents.find((a) => a.isDefault) ?? agents[0], text: query.trim() };
}

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
      { id: "p-overview", group: "Go to", label: "Overview", icon: <LayoutDashboard />, run: go("/"), keywords: "home dashboard mission control" },
      { id: "p-chat", group: "Go to", label: "Chat", icon: <MessagesSquare />, run: go("/chat"), keywords: "threads conversations inbox" },
      { id: "p-agents", group: "Go to", label: "Agents", icon: <Bot />, run: go("/agents") },
      { id: "p-providers", group: "Go to", label: "Providers", icon: <KeyRound />, run: go("/providers"), keywords: "subscriptions keys models login claude chatgpt copilot" },
      { id: "p-connections", group: "Go to", label: "Connections", icon: <Plug />, run: go("/connections"), keywords: "slack discord telegram webhook connectors" },
      { id: "p-tools", group: "Go to", label: "Tools", icon: <Wrench />, run: go("/tools"), keywords: "mcp servers github linear integrations" },
      { id: "p-activity", group: "Go to", label: "Activity", icon: <Activity />, run: go("/activity"), keywords: "tasks schedules log events" },
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
      hint: <span className="font-mono">{shortTime(thread.updatedAt)}</span>,
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
        const label = (item.text ?? (typeof item.label === "string" ? item.label : "")).toLowerCase();
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
    const matched = order.flatMap((group) => scored.filter((s) => s.item.group === group).slice(0, group === "Threads" ? 12 : 20).map((s) => s.item));

    // Anything typed can go straight to an agent. It leads when the query reads like a request (a mention, a
    // question, a sentence) or nothing else matched; otherwise it waits at the end so "agents" still opens Agents.
    const target = addressed(query, agents ?? []);
    if (!target.agent || !target.text) return matched;
    const agent = target.agent;
    const ask: Item = {
      id: "ask",
      group: "Ask an agent",
      text: query,
      label: (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-subtle">Ask {agent.name}</span>
          <span className="truncate text-fg">“{target.text}”</span>
        </span>
      ),
      hint: <span className="font-mono">@{agent.handle}</span>,
      icon: <AgentAvatar agent={agent} size="xs" className="size-[18px] text-[10px]" />,
      run: () => {
        void startChat(agent.id, target.text).then((id) => id && navigate(`/chat/${id}`));
      },
    };
    const leads = query.trim().startsWith("@") || /\?\s*$/.test(query) || terms.length >= 3 || matched.length === 0;
    return leads ? [ask, ...matched] : [...matched, ask];
  }, [items, query, agents]);

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
    <div className="fixed inset-0 z-[70] flex justify-center px-3 pt-[10vh] sm:pt-[13vh]">
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)] backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="lit relative flex max-h-[min(580px,74vh)] w-full max-w-[640px] animate-scale-in flex-col overflow-hidden rounded-2xl border border-border-strong bg-overlay/95 shadow-lg backdrop-blur-xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-[18px] shrink-0 text-subtle" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, jump to, or ask an agent…"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[index] ? `palette-${results[index].id}` : undefined}
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={list} id="palette-list" role="listbox" className="min-h-0 overflow-y-auto p-2">
          {results.length === 0 && <div className="px-4 py-12 text-center text-[13px] text-subtle">No results for “{query}”</div>}
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            const active = i === index;
            return (
              <div key={item.id}>
                {header && <div className="label-mono px-2.5 pb-1.5 pt-3 text-faint first:pt-1.5">{header}</div>}
                <button
                  type="button"
                  id={`palette-${item.id}`}
                  role="option"
                  aria-selected={active}
                  data-index={i}
                  onMouseMove={() => !active && setIndex(i)}
                  onClick={() => run(item)}
                  className={cn(
                    "relative flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13.5px] transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
                    active ? "bg-surface-2 text-fg shadow-[inset_0_0_0_1px_var(--border)]" : "text-muted",
                  )}
                >
                  <span className={cn("grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface", active ? "text-fg" : "text-subtle")}>{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-[11.5px] text-faint">{item.hint}</span>}
                  {active &&
                    (item.id === "ask" ? (
                      <span className="grid size-5 place-items-center rounded-md bg-accent text-accent-fg">
                        <ArrowUp className="!size-3" strokeWidth={2.5} />
                      </span>
                    ) : (
                      <CornerDownLeft className="!size-3.5 text-subtle" />
                    ))}
                </button>
              </div>
            );
          })}
        </div>
        <div className="hidden items-center gap-4 border-t border-border bg-surface/40 px-4 py-2.5 text-[11.5px] text-faint sm:flex">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> open
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>@</Kbd> handle to ask a specific agent
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
