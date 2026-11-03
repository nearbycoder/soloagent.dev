import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  ChartNoAxesColumn,
  KeyRound,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Settings,
  SquarePen,
  Sun,
  X,
} from "lucide-react";
import { useApp, type ConnectionStatus } from "../api/store.ts";
import { cn } from "../lib/cn.ts";
import { linkHandler, navigate, parseRoute, usePath, type Route } from "../lib/router.ts";
import { toggleTheme, useTheme } from "../lib/theme.ts";
import { AgentAvatar, Logo } from "./brand.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Dot, Kbd, Spinner } from "./ui.tsx";
import { Overview } from "../pages/Overview.tsx";
import { Chat } from "../pages/chat/Chat.tsx";

const Agents = lazy(() => import("../pages/Agents.tsx").then((m) => ({ default: m.Agents })));
const Providers = lazy(() => import("../pages/Providers.tsx").then((m) => ({ default: m.Providers })));
const Connections = lazy(() => import("../pages/Connections.tsx").then((m) => ({ default: m.Connections })));
const ActivityPage = lazy(() => import("../pages/Activity.tsx").then((m) => ({ default: m.ActivityPage })));
const Usage = lazy(() => import("../pages/Usage.tsx").then((m) => ({ default: m.Usage })));
const SettingsPage = lazy(() => import("../pages/Settings.tsx").then((m) => ({ default: m.SettingsPage })));

export const NAV: { page: Route["page"]; path: string; label: string; icon: ReactNode }[] = [
  { page: "overview", path: "/", label: "Overview", icon: <LayoutDashboard /> },
  { page: "chat", path: "/chat", label: "Chat", icon: <MessagesSquare /> },
  { page: "agents", path: "/agents", label: "Agents", icon: <Bot /> },
  { page: "providers", path: "/providers", label: "Providers", icon: <KeyRound /> },
  { page: "connections", path: "/connections", label: "Connections", icon: <Plug /> },
  { page: "activity", path: "/activity", label: "Activity", icon: <Activity /> },
  { page: "usage", path: "/usage", label: "Usage", icon: <ChartNoAxesColumn /> },
  { page: "settings", path: "/settings", label: "Settings", icon: <Settings /> },
];

const COLLAPSE_KEY = "solo.sidebar.collapsed";

export function Shell({ onSignOut }: { onSignOut: () => void }) {
  const path = usePath();
  const route = parseRoute(path);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }, [collapsed]);

  useEffect(() => setDrawer(false), [path]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((p) => !p);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const label = NAV.find((n) => n.page === route.page)?.label;
    document.title = label && route.page !== "overview" ? `${label} · soloagent` : "soloagent";
  }, [route.page]);

  return (
    <div className="flex h-full bg-bg">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 border-r border-border bg-bg-subtle transition-[width] duration-200 ease-out md:flex",
          collapsed ? "w-[60px]" : "w-[244px]",
        )}
      >
        <SidebarContent route={route} collapsed={collapsed} onToggleCollapse={() => setCollapsed((c) => !c)} onSearch={() => setPalette(true)} />
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)]" onClick={() => setDrawer(false)} />
          <aside className="relative flex h-full w-[280px] max-w-[85vw] animate-slide-in-left border-r border-border bg-bg-subtle shadow-lg">
            <SidebarContent route={route} collapsed={false} onClose={() => setDrawer(false)} onSearch={() => setPalette(true)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-subtle/90 px-2 backdrop-blur md:hidden">
          <button type="button" aria-label="Open menu" onClick={() => setDrawer(true)} className="grid size-9 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
            <Menu className="size-5" />
          </button>
          <a href="/" onClick={linkHandler("/")} className="flex-1">
            <Logo />
          </a>
          <StatusPill compact />
          <button type="button" aria-label="Search" onClick={() => setPalette(true)} className="grid size-9 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
            <Search className="size-[18px]" />
          </button>
        </header>

        <main className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="grid h-full place-items-center">
                <Spinner />
              </div>
            }
          >
            <PageFor route={route} onSignOut={onSignOut} />
          </Suspense>
        </main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} onSignOut={onSignOut} />
    </div>
  );
}

function PageFor({ route, onSignOut }: { route: Route; onSignOut: () => void }) {
  switch (route.page) {
    case "overview":
      return <Overview />;
    case "chat":
      return <Chat route={route} />;
    case "agents":
      return <Agents editId={route.agentId} />;
    case "providers":
      return <Providers />;
    case "connections":
      return <Connections editId={route.connectorId} />;
    case "activity":
      return <ActivityPage />;
    case "usage":
      return <Usage />;
    case "settings":
      return <SettingsPage onSignOut={onSignOut} />;
  }
}

function SidebarContent({
  route,
  collapsed,
  onToggleCollapse,
  onClose,
  onSearch,
}: {
  route: Route;
  collapsed: boolean;
  onToggleCollapse?: () => void;
  onClose?: () => void;
  onSearch: () => void;
}) {
  const agents = useApp((s) => s.agents);
  const busy = useApp((s) => s.threads?.filter((t) => t.busy).length ?? 0);
  const connectorErrors = useApp((s) => s.connectors?.filter((c) => c.enabled && c.status === "error").length ?? 0);
  const { resolved } = useTheme();

  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className={cn("flex h-14 shrink-0 items-center", collapsed ? "justify-center px-0" : "justify-between pl-4 pr-2")}>
        <a href="/" onClick={linkHandler("/")} className="rounded-md" aria-label="soloagent home">
          <Logo compact={collapsed} />
        </a>
        {!collapsed &&
          (onClose ? (
            <button type="button" aria-label="Close menu" onClick={onClose} className="grid size-8 place-items-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg">
              <X className="size-4" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Collapse sidebar"
              title="Collapse sidebar (⌘\)"
              onClick={onToggleCollapse}
              className="grid size-8 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-fg"
            >
              <PanelLeftClose className="size-4" />
            </button>
          ))}
      </div>

      <div className={cn("flex flex-col gap-1", collapsed ? "px-2.5" : "px-3")}>
        <button
          type="button"
          onClick={() => {
            navigate("/chat/new");
            onClose?.();
          }}
          title={collapsed ? "New chat" : undefined}
          className={cn(
            "flex h-8 items-center gap-2 rounded-lg border border-border bg-surface text-[13px] font-medium text-fg shadow-sm transition-colors hover:border-border-strong hover:bg-surface-2",
            collapsed ? "w-full justify-center" : "px-2.5",
          )}
        >
          <SquarePen className="size-4 text-accent-text" />
          {!collapsed && <span className="flex-1 text-left">New chat</span>}
        </button>
        <button
          type="button"
          onClick={onSearch}
          title={collapsed ? "Search (⌘K)" : undefined}
          className={cn(
            "flex h-8 items-center gap-2 rounded-lg text-[13px] text-subtle transition-colors hover:bg-surface-2 hover:text-fg",
            collapsed ? "w-full justify-center" : "px-2.5",
          )}
        >
          <Search className="size-4" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Search</span>
              <Kbd>⌘K</Kbd>
            </>
          )}
        </button>
      </div>

      <nav className={cn("mt-3 flex flex-col gap-px", collapsed ? "px-2.5" : "px-3")} aria-label="Main">
        {NAV.map((item) => {
          const active = route.page === item.page;
          const badge = item.page === "chat" && busy > 0 ? busy : item.page === "connections" && connectorErrors > 0 ? connectorErrors : 0;
          return (
            <a
              key={item.page}
              href={item.path}
              onClick={linkHandler(item.path, onClose)}
              aria-current={active ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              className={cn(
                "group relative flex h-8 items-center gap-2.5 rounded-lg text-[13.5px] transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
                collapsed ? "justify-center" : "px-2.5",
                active ? "bg-surface-2 font-medium text-fg shadow-[inset_0_0_0_1px_var(--border)]" : "text-muted hover:bg-surface-2/70 hover:text-fg",
              )}
            >
              <span className={cn(active ? "text-accent-text" : "text-subtle group-hover:text-muted")}>{item.icon}</span>
              {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
              {badge > 0 &&
                (collapsed ? (
                  <span className={cn("absolute right-1.5 top-1.5 size-1.5 rounded-full", item.page === "chat" ? "bg-accent" : "bg-danger")} />
                ) : (
                  <span
                    className={cn(
                      "grid h-4.5 min-w-4.5 place-items-center rounded-full px-1 text-[10.5px] font-semibold tabular-nums",
                      item.page === "chat" ? "bg-accent-soft text-accent-text" : "bg-danger-soft text-danger",
                    )}
                  >
                    {badge}
                  </span>
                ))}
            </a>
          );
        })}
      </nav>

      {!collapsed && agents && agents.length > 0 && (
        <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-3">
          <div className="mb-1 flex items-center justify-between px-2.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-faint">Agents</span>
          </div>
          <div className="flex flex-col gap-px">
            {agents.slice(0, 12).map((agent) => (
              <a
                key={agent.id}
                href={`/chat/new/${agent.id}`}
                onClick={linkHandler(`/chat/new/${agent.id}`, onClose)}
                className="group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-muted transition-colors hover:bg-surface-2/70 hover:text-fg"
                title={`New chat with ${agent.name}`}
              >
                <AgentAvatar agent={agent} size="xs" className="size-[18px] text-[10px]" />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                <SquarePen className="size-3.5 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
              </a>
            ))}
          </div>
        </div>
      )}
      {(collapsed || !agents || agents.length === 0) && <div className="flex-1" />}

      <div className={cn("flex shrink-0 items-center gap-1 border-t border-border py-2.5", collapsed ? "flex-col px-2" : "px-3")}>
        <StatusPill collapsed={collapsed} />
        <div className={cn("flex items-center", collapsed ? "flex-col gap-1" : "ml-auto gap-0.5")}>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={resolved === "dark" ? "Light theme" : "Dark theme"}
            className="grid size-7 place-items-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg"
          >
            {resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          {collapsed && onToggleCollapse && (
            <button
              type="button"
              aria-label="Expand sidebar"
              title="Expand sidebar (⌘\)"
              onClick={onToggleCollapse}
              className="grid size-7 place-items-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<ConnectionStatus, string> = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" };

function StatusPill({ collapsed, compact }: { collapsed?: boolean; compact?: boolean }) {
  const status = useApp((s) => s.status);
  const version = useApp((s) => s.version);
  const tone = status === "live" ? "success" : "warning";
  const title = `${STATUS_LABEL[status]}${version ? ` · v${version}` : ""}`;
  if (collapsed || compact) {
    return (
      <span title={title} className="grid size-7 place-items-center" role="status" aria-label={title}>
        <Dot tone={tone} pulse={status !== "live"} />
      </span>
    );
  }
  return (
    <div role="status" title={title} className="flex h-7 items-center gap-2 rounded-md px-1.5 text-[12px] text-subtle">
      <Dot tone={tone} pulse={status !== "live"} />
      <span>{STATUS_LABEL[status]}</span>
      {version && <span className="font-mono text-[11px] text-faint">v{version}</span>}
    </div>
  );
}
