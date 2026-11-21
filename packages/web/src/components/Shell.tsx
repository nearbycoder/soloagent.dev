import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  ChartNoAxesColumn,
  ChevronsUpDown,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Repeat,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Sun,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { useAgentActivity, useApp, useIsAdmin, type ConnectionStatus } from "../api/store.ts";
import { cn } from "../lib/cn.ts";
import { initials } from "../lib/format.ts";
import { linkHandler, navigate, parseRoute, usePath, type Route } from "../lib/router.ts";
import { toggleTheme, useTheme } from "../lib/theme.ts";
import { AgentAvatar, Logo } from "./brand.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { MenuItem, MenuSeparator, Popover } from "./overlay.tsx";
import { Dot, Kbd, Spinner } from "./ui.tsx";
import { UpdateNotice } from "./UpdateNotice.tsx";
import { Overview } from "../pages/Overview.tsx";
import { shortcut } from "../lib/keys.ts";

const Chat = lazy(() => import("../pages/chat/Chat.tsx").then((m) => ({ default: m.Chat })));
const Agents = lazy(() => import("../pages/Agents.tsx").then((m) => ({ default: m.Agents })));
const Providers = lazy(() => import("../pages/Providers.tsx").then((m) => ({ default: m.Providers })));
const Connections = lazy(() => import("../pages/Connections.tsx").then((m) => ({ default: m.Connections })));
const Tools = lazy(() => import("../pages/Tools.tsx").then((m) => ({ default: m.Tools })));
const ActivityPage = lazy(() => import("../pages/Activity.tsx").then((m) => ({ default: m.ActivityPage })));
const ApprovalsPage = lazy(() => import("../pages/Approvals.tsx").then((m) => ({ default: m.ApprovalsPage })));
const Automations = lazy(() => import("../pages/Automations.tsx").then((m) => ({ default: m.Automations })));
const Usage = lazy(() => import("../pages/Usage.tsx").then((m) => ({ default: m.Usage })));
const SettingsPage = lazy(() => import("../pages/Settings.tsx").then((m) => ({ default: m.SettingsPage })));
const Team = lazy(() => import("../pages/Team.tsx").then((m) => ({ default: m.Team })));

type NavItem = { page: Route["page"]; path: string; label: string; icon: ReactNode; adminOnly?: boolean; group: "work" | "configure" };

/** `adminOnly` items are hidden from members (the server enforces it too). */
export const NAV: NavItem[] = [
  { page: "overview", path: "/", label: "Overview", icon: <LayoutDashboard />, group: "work" },
  { page: "chat", path: "/chat", label: "Chat", icon: <MessagesSquare />, group: "work" },
  { page: "approvals", path: "/approvals", label: "Approvals", icon: <ShieldCheck />, group: "work" },
  { page: "agents", path: "/agents", label: "Agents", icon: <Bot />, group: "work" },
  { page: "automations", path: "/automations", label: "Automations", icon: <Repeat />, group: "work" },
  { page: "activity", path: "/activity", label: "Activity", icon: <Activity />, group: "work" },
  { page: "usage", path: "/usage", label: "Usage", icon: <ChartNoAxesColumn />, group: "work" },
  { page: "providers", path: "/providers", label: "Providers", icon: <KeyRound />, adminOnly: true, group: "configure" },
  { page: "connections", path: "/connections", label: "Connections", icon: <Plug />, adminOnly: true, group: "configure" },
  { page: "tools", path: "/tools", label: "Tools", icon: <Wrench />, adminOnly: true, group: "configure" },
  { page: "team", path: "/team", label: "Team", icon: <Users />, adminOnly: true, group: "configure" },
  { page: "settings", path: "/settings", label: "Settings", icon: <Settings />, group: "configure" },
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

  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

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

  const threadTitle = useApp((s) => (route.page === "chat" && route.threadId ? s.threads?.find((t) => t.id === route.threadId)?.title : undefined));
  useEffect(() => {
    const label = threadTitle || NAV.find((n) => n.page === route.page)?.label;
    document.title = label && route.page !== "overview" ? `${label} · soloagent` : "soloagent";
  }, [route.page, threadTitle]);

  return (
    <div className="flex h-full bg-bg">
      {/* Desktop sidebar */}
      <aside className={cn("hidden shrink-0 transition-[width] duration-200 ease-out md:flex", collapsed ? "w-[64px]" : "w-[248px]")}>
        <SidebarContent
          route={route}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          onSearch={() => setPalette(true)}
          onSignOut={onSignOut}
        />
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)] backdrop-blur-[2px]" onClick={() => setDrawer(false)} />
          <aside role="dialog" aria-modal="true" aria-label="Menu" className="relative flex h-full w-[284px] max-w-[85vw] animate-slide-in-left border-r border-border bg-bg shadow-lg">
            <SidebarContent
              route={route}
              collapsed={false}
              onClose={() => setDrawer(false)}
              onSearch={() => {
                setDrawer(false);
                setPalette(true);
              }}
              onSignOut={onSignOut}
            />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        {/* Mobile top bar */}
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-bg px-2 md:hidden">
          <button type="button" aria-label="Open menu" onClick={() => setDrawer(true)} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
            <Menu className="size-5" />
          </button>
          <a href="/" onClick={linkHandler("/")} className="ml-1 flex-1">
            <Logo />
          </a>
          <StatusPill compact />
          <button type="button" aria-label="Search" onClick={() => setPalette(true)} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
            <Search className="size-[18px]" />
          </button>
        </header>

        {/* The page: an inset panel floating on the app background. */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-panel md:rounded-xl md:border md:border-border md:shadow-card">
          <OfflineBanner />
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
    case "tools":
      return <Tools editId={route.serverId} />;
    case "activity":
      return <ActivityPage />;
    case "approvals":
      return <ApprovalsPage />;
    case "automations":
      return <Automations editId={route.automationId} />;
    case "usage":
      return <Usage />;
    case "team":
      return <Team />;
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
  onSignOut,
}: {
  route: Route;
  collapsed: boolean;
  onToggleCollapse?: () => void;
  onClose?: () => void;
  onSearch: () => void;
  onSignOut: () => void;
}) {
  const agents = useApp((s) => s.agents);
  const busy = useApp((s) => {
    let n = 0;
    for (const t of s.threads ?? []) if (t.busy) n++;
    return n;
  });
  const connectorErrors = useApp((s) => {
    let n = 0;
    for (const c of s.connectors ?? []) if (c.enabled && c.status === "error") n++;
    return n;
  });
  const approvals = useApp((s) => s.approvals?.length ?? 0);
  const isAdmin = useIsAdmin();
  const items = NAV.filter((item) => isAdmin || !item.adminOnly);

  const navLink = (item: NavItem) => {
    const active = route.page === item.page;
    const badge = item.page === "chat" && busy > 0 ? busy : item.page === "connections" && connectorErrors > 0 ? connectorErrors : item.page === "approvals" ? approvals : 0;
    const badgeLabel =
      item.page === "chat"
        ? `${badge} ${badge === 1 ? "thread" : "threads"} working`
        : item.page === "approvals"
          ? `${badge} waiting for approval`
          : `${badge} ${badge === 1 ? "connection has" : "connections have"} an error`;
    const tone = item.page === "chat" ? "accent" : item.page === "approvals" ? "warning" : "danger";
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
          active ? "bg-surface-2 font-medium text-fg shadow-[inset_0_0_0_1px_var(--border)]" : "text-muted hover:bg-surface-2/60 hover:text-fg",
        )}
      >
        {active && <span aria-hidden className="absolute -left-3 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-line shadow-[0_0_10px_var(--accent-glow)]" />}
        <span className={cn("transition-colors", active ? "text-fg" : "text-subtle group-hover:text-muted")}>{item.icon}</span>
        {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
        {badge > 0 &&
          (collapsed ? (
            <span
              title={badgeLabel}
              aria-label={badgeLabel}
              className={cn("absolute right-1.5 top-1.5 size-1.5 rounded-full", tone === "accent" ? "bg-accent-line shadow-[0_0_6px_var(--accent-glow)]" : tone === "warning" ? "bg-warning" : "bg-danger")}
            />
          ) : (
            <span
              title={badgeLabel}
              aria-label={badgeLabel}
              className={cn(
                "flex h-[18px] min-w-[18px] items-center justify-center gap-1 rounded-full px-1.5 font-mono text-[10.5px] font-semibold tabular-nums",
                tone === "accent" ? "bg-accent-soft text-accent-text" : tone === "warning" ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger",
              )}
            >
              {tone === "accent" && <span className="size-1 animate-pulse-soft rounded-full bg-current" />}
              {badge}
            </span>
          ))}
      </a>
    );
  };

  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className={cn("flex h-[60px] shrink-0 items-center", collapsed ? "justify-center px-0" : "justify-between pl-[18px] pr-2.5")}>
        <a href="/" onClick={linkHandler("/", onClose)} className="rounded-lg" aria-label="soloagent home">
          <Logo compact={collapsed} />
        </a>
        {!collapsed &&
          (onClose ? (
            <button type="button" aria-label="Close menu" onClick={onClose} className="grid size-8 place-items-center rounded-lg text-subtle hover:bg-surface-2 hover:text-fg">
              <X className="size-4" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Collapse sidebar"
              title={`Collapse sidebar (${shortcut("\\")})`}
              onClick={onToggleCollapse}
              className="grid size-8 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <PanelLeftClose className="size-4" />
            </button>
          ))}
      </div>

      <div className="flex flex-col gap-1.5 px-3">
        <button
          type="button"
          onClick={() => {
            navigate("/chat/new");
            onClose?.();
          }}
          title={collapsed ? "New chat" : undefined}
          aria-label={collapsed ? "New chat" : undefined}
          className={cn(
            "group flex h-9 items-center gap-2.5 rounded-lg border border-border bg-control text-[13.5px] font-medium text-fg shadow-xs transition-colors hover:border-border-strong hover:bg-control-hover",
            collapsed ? "w-full justify-center" : "pl-1.5 pr-2.5",
          )}
        >
          <span className="grid size-6 place-items-center rounded-md bg-accent text-accent-fg shadow-[0_0_14px_-4px_var(--accent-glow)]">
            <SquarePen className="size-3.5" strokeWidth={2.25} />
          </span>
          {!collapsed && <span className="flex-1 text-left">New chat</span>}
        </button>
        <button
          type="button"
          onClick={onSearch}
          title={collapsed ? `Search (${shortcut("K")})` : undefined}
          aria-label={collapsed ? "Search" : undefined}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-lg text-[13px] text-subtle transition-colors hover:bg-surface-2/60 hover:text-fg",
            collapsed ? "w-full justify-center" : "px-2.5",
          )}
        >
          <Search className="size-4" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Search or ask…</span>
              <Kbd className="[@media(pointer:coarse)]:hidden">{shortcut("K")}</Kbd>
            </>
          )}
        </button>
      </div>

      <div className={cn("mt-3 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3", collapsed ? "px-3" : "px-3")}>
        <nav className="flex flex-col gap-px" aria-label="Main">
          {items.filter((i) => i.group === "work").map(navLink)}
          {collapsed ? <div className="mx-2 my-2.5 h-px bg-border" /> : <SidebarLabel>Configure</SidebarLabel>}
          {items.filter((i) => i.group === "configure").map(navLink)}
        </nav>

        {!collapsed && agents && agents.length > 0 && <AgentRoster onNavigate={onClose} />}
      </div>

      <UpdateNotice collapsed={collapsed} onNavigate={onClose} />

      <SidebarFooter collapsed={collapsed} onToggleCollapse={onToggleCollapse} onSignOut={onSignOut} onNavigate={onClose} />
    </div>
  );
}

function SidebarLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2.5 pb-1.5 pt-5">
      <span className="label-mono text-faint">{children}</span>
      {action}
    </div>
  );
}

/** Every agent with what it's doing right now. Clicking one starts a new chat with it. */
function AgentRoster({ onNavigate }: { onNavigate?: () => void }) {
  const agents = useApp((s) => s.agents) ?? [];
  const activity = useAgentActivity();
  let working = 0;
  for (const a of activity.values()) if (a.presence === "working") working++;
  return (
    <div className="[--presence-ring:var(--bg)]">
      <SidebarLabel
        action={
          working > 0 ? (
            <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-accent-text">
              <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-line" />
              {working} live
            </span>
          ) : (
            <span className="font-mono text-[10.5px] text-faint">{agents.length}</span>
          )
        }
      >
        Agents
      </SidebarLabel>
      <div className="flex flex-col gap-px">
        {agents.slice(0, 12).map((agent) => {
          const state = activity.get(agent.id);
          const where = state?.thread?.location || state?.thread?.title;
          return (
            <a
              key={agent.id}
              href={`/chat/new/${agent.id}`}
              onClick={linkHandler(`/chat/new/${agent.id}`, onNavigate)}
              className="group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-muted transition-colors hover:bg-surface-2/60 hover:text-fg"
              title={state?.presence === "working" && where ? `${agent.name} is working in ${where}` : `New chat with ${agent.name}`}
            >
              <AgentAvatar agent={agent} size="xs" presence={state?.presence} className="size-[18px] text-[10px]" />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {state?.presence === "working" ? (
                <span className="font-mono text-[10.5px] text-accent-text">working</span>
              ) : state?.presence === "approval" ? (
                <span className="font-mono text-[10.5px] text-warning">needs you</span>
              ) : (
                <SquarePen className="size-3.5 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}

function SidebarFooter({
  collapsed,
  onToggleCollapse,
  onSignOut,
  onNavigate,
}: {
  collapsed: boolean;
  onToggleCollapse?: () => void;
  onSignOut: () => void;
  onNavigate?: () => void;
}) {
  const me = useApp((s) => s.me);
  const { resolved } = useTheme();
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const name = me?.actor.name ?? "You";
  const role = me?.actor.role ?? "member";

  const accountMenu = (
    <Popover open={menu} onClose={() => setMenu(false)} anchor={anchor} align="start" className="w-56">
      <div className="px-2.5 pb-2 pt-1.5">
        <p className="truncate text-[13px] font-medium text-fg">{name}</p>
        <p className="font-mono text-[11px] text-faint">{role === "admin" ? "Admin" : "Member"}{me?.actor.kind === "token" ? " · admin token" : ""}</p>
      </div>
      <MenuSeparator />
      <MenuItem
        icon={<Settings />}
        onClick={() => {
          setMenu(false);
          navigate("/settings");
          onNavigate?.();
        }}
      >
        Settings
      </MenuItem>
      <MenuItem
        icon={resolved === "dark" ? <Sun /> : <Moon />}
        onClick={() => {
          toggleTheme();
          setMenu(false);
        }}
      >
        {resolved === "dark" ? "Light theme" : "Dark theme"}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<LogOut />}
        onClick={() => {
          setMenu(false);
          onSignOut();
        }}
      >
        Sign out
      </MenuItem>
    </Popover>
  );

  if (collapsed) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border px-2 py-2.5">
        <StatusPill collapsed />
        <button
          ref={anchor}
          type="button"
          onClick={() => setMenu((m) => !m)}
          aria-label="Account"
          title={name}
          className="grid size-8 place-items-center rounded-lg hover:bg-surface-2"
        >
          <UserBadge name={name} />
        </button>
        {onToggleCollapse && (
          <button
            type="button"
            aria-label="Expand sidebar"
            title={`Expand sidebar (${shortcut("\\")})`}
            onClick={onToggleCollapse}
            className="grid size-8 place-items-center rounded-lg text-subtle hover:bg-surface-2 hover:text-fg"
          >
            <PanelLeftOpen className="size-4" />
          </button>
        )}
        {accountMenu}
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-border px-3 pb-3 pt-2.5">
      <div className="flex items-center gap-1">
        <button
          ref={anchor}
          type="button"
          onClick={() => setMenu((m) => !m)}
          aria-label="Account"
          className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-surface-2/70"
        >
          <UserBadge name={name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-tight text-fg">{name}</span>
            <span className="block font-mono text-[10.5px] leading-tight text-faint">{role}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={resolved === "dark" ? "Light theme" : "Dark theme"}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-surface-2 hover:text-fg"
        >
          {resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>
      <StatusPill />
      {accountMenu}
    </div>
  );
}

function UserBadge({ name }: { name: string }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-b from-surface-3 to-surface-2 font-mono text-[10.5px] font-semibold text-muted ring-1 ring-border-strong">
      {initials(name)}
    </span>
  );
}

/**
 * A clear, full-width notice when the live connection has been down for a few seconds. Brief blips (a deploy, a
 * laptop waking up) reconnect before it shows.
 */
function OfflineBanner() {
  const status = useApp((s) => s.status);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (status !== "reconnecting") return setShow(false);
    const timer = setTimeout(() => setShow(true), 3000);
    return () => clearTimeout(timer);
  }, [status]);
  if (!show) return null;
  return (
    <div role="status" className="flex shrink-0 items-center justify-center gap-2 border-b border-warning/25 bg-warning-soft px-4 py-2 text-center text-[12.5px] text-warning">
      <Spinner className="size-3.5 text-warning" />
      <span>
        <span className="font-medium">Can't reach the server.</span> Reconnecting — what you type is kept, but nothing sends until it's back.
      </span>
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
      <span title={title} className="grid size-8 place-items-center" role="status" aria-label={title}>
        <Dot tone={tone} pulse={status !== "live"} />
      </span>
    );
  }
  return (
    <div role="status" aria-label={title} title={title} className="mt-1.5 flex items-center gap-2 px-1.5 font-mono text-[10.5px] text-faint">
      <Dot tone={tone} pulse={status !== "live"} className="size-1.5 [&>span]:size-1.5" />
      <span className={cn(status === "live" ? "text-subtle" : "text-warning")}>{STATUS_LABEL[status].toLowerCase()}</span>
      <span className="ml-auto">{version ? `v${version}` : ""}</span>
    </div>
  );
}
