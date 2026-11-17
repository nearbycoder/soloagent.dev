import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowUpCircle,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  Info,
  Keyboard,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Palette,
  RotateCw,
  SquareTerminal,
  Sun,
  TriangleAlert,
} from "lucide-react";
import { client } from "../api/client.ts";
import { useApp, useIsAdmin } from "../api/store.ts";
import { confirm, toast } from "../lib/toast.ts";
import { Badge, Button, Card, CopyButton, CopyField, Kbd, Page, PageHeader, Segmented, Switch } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { duration, fullDate, initials } from "../lib/format.ts";
import { setTheme, useTheme, type ThemePref } from "../lib/theme.ts";
import { ALT, MOD, shortcut } from "../lib/keys.ts";

type SectionId = "terminal" | "token" | "updates" | "backups" | "appearance" | "keyboard" | "session" | "about";

export function SettingsPage({ onSignOut }: { onSignOut: () => void }) {
  const isAdmin = useIsAdmin();
  const updateAvailable = useApp((s) => !!s.overview?.update?.updateAvailable);

  const sections: { id: SectionId; label: string; icon: ReactNode; badge?: ReactNode }[] = [
    ...(isAdmin
      ? [
          { id: "terminal" as const, label: "Terminal", icon: <SquareTerminal /> },
          { id: "token" as const, label: "Admin token", icon: <KeyRound /> },
        ]
      : []),
    {
      id: "updates",
      label: isAdmin ? "Updates" : "Version",
      icon: <ArrowUpCircle />,
      badge: updateAvailable ? <span className="size-1.5 rounded-full bg-accent-line shadow-[0_0_6px_var(--accent-glow)]" aria-label="Update available" /> : undefined,
    },
    ...(isAdmin ? [{ id: "backups" as const, label: "Backups", icon: <Archive /> }] : []),
    { id: "appearance", label: "Appearance", icon: <Palette /> },
    { id: "keyboard", label: "Keyboard", icon: <Keyboard /> },
    { id: "session", label: "Session", icon: <LogOut /> },
    { id: "about", label: "About", icon: <Info /> },
  ];
  const [active, setActive] = useActiveSection(sections.map((s) => s.id));

  return (
    <Page>
      <PageHeader
        eyebrow="Configure"
        title="Settings"
        description={isAdmin ? "Terminal access, your admin token, upgrades, backups, and how the dashboard looks." : "Appearance, keyboard shortcuts, and your session."}
      />

      <div className="xl:grid xl:grid-cols-[176px_minmax(0,1fr)] xl:gap-12">
        <nav aria-label="Settings sections" className="hidden self-start xl:sticky xl:top-6 xl:block">
          <ul className="flex flex-col gap-px">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                    setActive(section.id);
                  }}
                  aria-current={active === section.id ? "true" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0",
                    active === section.id ? "bg-surface-2 font-medium text-fg shadow-[inset_0_0_0_1px_var(--border)]" : "text-subtle hover:bg-surface-2/60 hover:text-fg",
                  )}
                >
                  <span className={active === section.id ? "text-fg" : "text-faint"}>{section.icon}</span>
                  <span className="flex-1 truncate">{section.label}</span>
                  {section.badge}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 max-w-[760px] flex-col gap-12">
          {isAdmin && <TerminalSection />}
          {isAdmin && <AdminTokenSection />}
          <UpdatesSection admin={isAdmin} />
          {isAdmin && <BackupSection />}
          <AppearanceSection />
          <KeyboardSection />
          <SessionSection onSignOut={onSignOut} />
          <AboutSection />
        </div>
      </div>
    </Page>
  );
}

/** Which section is in view, for the side nav. Clicking a link sets it right away. */
function useActiveSection(ids: SectionId[]) {
  const [active, setActive] = useState<SectionId | undefined>(ids[0]);
  const key = ids.join(",");
  useEffect(() => {
    const elements = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (elements.length === 0) return;
    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) ratios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
        const first = ids.find((id) => (ratios.get(id) ?? 0) > 0);
        if (first) setActive(first);
      },
      { rootMargin: "-8% 0px -62% 0px", threshold: [0, 0.01, 0.5] },
    );
    for (const el of elements) observer.observe(el);
    // The last sections may never reach the band near the top: at the bottom of the page, the last one wins.
    const scroller = elements[0]!.closest<HTMLElement>(".overflow-y-auto");
    const onScroll = () => {
      if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) setActive(ids[ids.length - 1]);
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [key]);
  return [active, setActive] as const;
}

// ---------------------------------------------------------------------------
// Layout

function Section({ id, title, description, children, aside }: { id: SectionId; title: string; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-[15px] font-semibold tracking-[-0.015em] text-fg">
            {title}
          </h2>
          {description && <p className="mt-1 text-[13px] leading-relaxed text-subtle">{description}</p>}
        </div>
        {aside}
      </div>
      <Card className="divide-y divide-border overflow-hidden">{children}</Card>
    </section>
  );
}

/** One setting: what it is on the left, the control on the right (stacked on phones). Extra content spans below. */
function Row({ title, description, control, children, className }: { title: ReactNode; description?: ReactNode; control?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("p-5", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-medium text-fg">{title}</h3>
          {description && <div className="mt-0.5 text-[12.5px] leading-relaxed text-subtle">{description}</div>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded-md border border-border bg-surface-2 px-1 py-px font-mono text-[11.5px] text-muted">{children}</code>;
}

/** A shell command with a prompt and a copy button. `chrome` adds a terminal title bar. */
function Command({ command, chrome, className }: { command: string; chrome?: string; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-code", className)}>
      {chrome && (
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
          <span className="size-2 rounded-full bg-surface-3" />
          <span className="size-2 rounded-full bg-surface-3" />
          <span className="size-2 rounded-full bg-surface-3" />
          <span className="label-mono ml-2 text-faint">{chrome}</span>
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2 py-1.5 pl-3 pr-1.5">
        <span aria-hidden className="select-none font-mono text-[12.5px] text-accent-text">
          $
        </span>
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-0.5 pr-4 font-mono text-[12.5px] text-fg [mask-image:linear-gradient(to_right,#000_calc(100%-20px),transparent)] [scrollbar-width:none]">
          {command}
        </code>
        <CopyButton text={command} label="Copy command" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections

function TerminalSection() {
  const origin = location.origin;
  return (
    <Section id="terminal" title="Terminal" description="Chat with the same agents and threads from your terminal.">
      <Row
        title="Connect the TUI"
        description="Run this anywhere soloagent is installed (Homebrew, the installer, or npm). Replace the token placeholder with your admin token."
      >
        <Command command={`soloagent --url ${origin} --token <token>`} chrome="terminal" className="mt-4" />
        <details className="group mt-3 rounded-lg border border-border bg-surface-2/40 text-[12.5px] leading-relaxed text-subtle open:bg-surface-2/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 text-faint transition-transform group-open:rotate-90" />
            Where's my token?
          </summary>
          <p className="px-3 pb-3 pl-[30px]">
            For security the server never sends it back to the browser. It's either the value of the <InlineCode>SOLOAGENT_TOKEN</InlineCode> environment variable, or — if that isn't
            set — the token printed in the server logs when it starts (look for the <span className="font-mono text-muted">soloagent is up</span> banner). On Railway, find it under
            your service's <span className="font-medium text-muted">Variables</span> or <span className="font-medium text-muted">Deploy logs</span>.
          </p>
        </details>
      </Row>
    </Section>
  );
}

function AdminTokenSection() {
  const tokenFromEnv = useApp((s) => s.me?.tokenFromEnv ?? false);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const rotate = async () => {
    const ok = await confirm({
      title: "Rotate the admin token?",
      body: "The CLI, the TUI, scripts, and browsers signed in with the old token stop working until they use the new one. Team members signed in with a password are not affected.",
      confirmLabel: "Rotate token",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      setFresh((await client.rotateAdminToken()).token);
      toast.success("Admin token rotated", "Copy the new token now. It isn't shown again.");
    } catch (error) {
      toast.error(error, "Could not rotate the token");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="token" title="Admin token" description="The superuser credential for the CLI, the TUI, and the API.">
      <Row
        title="Rotate the admin token"
        description={
          tokenFromEnv ? (
            <>
              This server takes its token from the <InlineCode>SOLOAGENT_TOKEN</InlineCode> environment variable. To rotate it, set a new value there and restart the server.
            </>
          ) : (
            "Replace the token if it leaked or someone who had it left the team. The new token is shown once."
          )
        }
        control={
          tokenFromEnv ? (
            <Badge className="font-mono">from env</Badge>
          ) : (
            <Button variant="secondary" loading={busy} icon={<RotateCw />} onClick={rotate}>
              Rotate token
            </Button>
          )
        }
      >
        {fresh && (
          <div className="mt-4 flex animate-rise flex-col gap-2.5 rounded-lg border border-accent-line/25 bg-accent-soft p-3.5">
            <p className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
              <KeyRound className="size-3.5 text-accent-text" />
              New admin token — copy it now, it isn't shown again
            </p>
            <CopyField value={fresh} />
            <p className="text-[12px] text-subtle">
              Update the CLI with <span className="font-mono text-muted">soloagent connect {location.origin} --token &lt;new token&gt;</span>.
            </p>
          </div>
        )}
      </Row>
    </Section>
  );
}

const RELEASE_TGZ = "https://github.com/nearbycoder/soloagent.dev/releases/latest/download/soloagent.tgz";

const UPGRADE_STEPS: { id: string; label: string; steps: { text: string; command?: string }[] }[] = [
  {
    id: "npm",
    label: "Installer / npm",
    steps: [
      { text: "Run the installer again, or install the release with npm:", command: "curl -fsSL https://soloagent.dev/install.sh | sh" },
      { text: "", command: `npm install -g --allow-remote=root ${RELEASE_TGZ}` },
      { text: "Then restart the server: stop soloagent serve and start it again, or sudo systemctl restart soloagent." },
    ],
  },
  {
    id: "brew",
    label: "Homebrew",
    steps: [
      { text: "", command: "brew upgrade soloagent" },
      { text: "Then restart the server: stop soloagent serve and start it again." },
    ],
  },
  {
    id: "docker",
    label: "Docker",
    steps: [
      { text: "In the folder with docker-compose.yml:", command: "docker compose pull && docker compose up -d" },
      { text: "With plain docker run, pull ghcr.io/nearbycoder/soloagent.dev, remove the container, and run it again with the same volume." },
    ],
  },
  {
    id: "hosted",
    label: "Railway · Render · Fly",
    steps: [
      { text: "These build from the repository. If you deployed a fork, sync it with nearbycoder/soloagent.dev first." },
      { text: "Railway: open the service's Deployments and redeploy the latest commit. Render: Manual Deploy → Deploy latest commit." },
      { text: "Fly.io: from an up-to-date checkout:", command: "git pull && fly deploy" },
    ],
  },
];

function UpdatesSection({ admin }: { admin: boolean }) {
  const version = useApp((s) => s.version);
  const update = useApp((s) => s.overview?.update);
  const [method, setMethod] = useState("npm");
  const current = update?.current ?? version;
  const steps = UPGRADE_STEPS.find((m) => m.id === method)!;
  const available = !!update?.updateAvailable;
  return (
    <Section
      id="updates"
      title={admin ? "Updates" : "Version"}
      description={admin ? "Data and durable work carry over upgrades; migrations run on start. Take a backup first." : "The soloagent release this server runs. Admins handle upgrades."}
    >
      <div className={cn("flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between", available && "bg-accent-soft/50")}>
        <div className="flex min-w-0 items-start gap-3.5">
          <div
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-lg border",
              available ? "border-accent-line/30 bg-accent-soft text-accent-text shadow-[0_0_16px_-6px_var(--accent-glow)]" : "border-success/20 bg-success-soft text-success",
            )}
          >
            {available ? <ArrowUpCircle className="size-[18px]" /> : <CheckCircle2 className="size-[18px]" />}
          </div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">
              {available ? `soloagent v${update!.latest} is available` : update?.latest ? "You're on the latest release" : "soloagent"}
            </h3>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11.5px] text-faint">
              <span>
                running <span className="text-muted">v{current || "—"}</span>
              </span>
              {update?.latest && (
                <span>
                  · latest <span className="text-muted">v{update.latest}</span>
                </span>
              )}
              {update?.checkedAt ? <span title={fullDate(update.checkedAt)}>· checked {new Date(update.checkedAt).toLocaleString()}</span> : null}
              {update && !update.enabled && <span>· update checks off (SOLOAGENT_UPDATE_CHECK=0)</span>}
            </p>
          </div>
        </div>
        {update?.url && (
          <a
            href={update.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 self-start rounded-lg border border-border bg-control px-3 text-[13px] font-medium text-fg shadow-xs transition-colors hover:bg-control-hover sm:self-auto"
          >
            Release notes <ExternalLink className="size-3.5 text-subtle" />
          </a>
        )}
      </div>
      {admin && (
        <div className="p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-[13.5px] font-medium text-fg">How to upgrade</h3>
            <div className="-mx-1 max-w-[calc(100%+0.5rem)] overflow-x-auto px-1 [scrollbar-width:none]">
              <Segmented size="sm" value={method} onChange={setMethod} options={UPGRADE_STEPS.map((m) => ({ value: m.id, label: <span className="whitespace-nowrap">{m.label}</span> }))} />
            </div>
          </div>
          <ol className="mt-4 flex flex-col gap-3 text-[12.5px] leading-relaxed text-subtle">
            {steps.steps.map((step, i) => (
              <li key={`${method}-${i}`} className="animate-fade-in">
                {step.text && <p>{step.text}</p>}
                {step.command && <Command command={step.command} className={step.text ? "mt-1.5" : undefined} />}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Section>
  );
}

function BackupSection() {
  const [includeSecret, setIncludeSecret] = useState(false);
  return (
    <Section id="backups" title="Backups" description="One .tar.gz with both databases, agent workspaces, and files. Safe to take while agents run.">
      <Row
        title="Download a backup"
        description={
          <>
            Restore it with <InlineCode>soloagent restore &lt;file&gt;</InlineCode> while the server is stopped.
          </>
        }
        control={
          <a
            href={`/api/backup${includeSecret ? "?includeSecret=1" : ""}`}
            download
            className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-inverse px-3 text-[13px] font-medium text-inverse-fg shadow-[0_1px_2px_rgb(0_0_0/0.2),inset_0_1px_0_rgb(255_255_255/0.12)] transition-colors hover:bg-inverse-hover"
          >
            <Download className="size-4" />
            Download backup
          </a>
        }
      />
      <Row
        title={
          <span className="flex items-center gap-2">
            Include the credentials secret
            {includeSecret && (
              <Badge tone="warning">
                <TriangleAlert />
                sensitive
              </Badge>
            )}
          </span>
        }
        description={
          includeSecret
            ? "Anyone with this file can read every provider login and bot token. Store it like a password."
            : "Off: logins and bot tokens stay sealed, and a restore needs the same SOLOAGENT_SECRET or .secret file."
        }
        control={<Switch checked={includeSecret} onChange={setIncludeSecret} label="Include the credentials secret" />}
      />
    </Section>
  );
}

function AppearanceSection() {
  const { pref } = useTheme();
  return (
    <Section id="appearance" title="Appearance" description="How the dashboard looks in this browser.">
      <Row title="Theme" description="System follows your operating system's light or dark setting.">
        <ThemePicker value={pref} onChange={setTheme} />
      </Row>
    </Section>
  );
}

const THEMES: { value: ThemePref; label: string; icon: ReactNode }[] = [
  { value: "dark", label: "Dark", icon: <Moon /> },
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "system", label: "System", icon: <Monitor /> },
];

/** Three radio cards with a miniature of the dashboard in each theme. Arrow keys move between them. */
function ThemePicker({ value, onChange }: { value: ThemePref; onChange: (pref: ThemePref) => void }) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, step: number) => {
    const next = (from + step + THEMES.length) % THEMES.length;
    onChange(THEMES[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Theme" className="mt-4 grid grid-cols-3 gap-2.5 sm:gap-3">
      {THEMES.map((theme, index) => {
        const checked = value === theme.value;
        return (
          <button
            key={theme.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-labelledby={`${id}-${theme.value}`}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(theme.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              }
            }}
            className={cn(
              "group flex flex-col gap-2 rounded-xl border p-1.5 text-left transition-[border-color,box-shadow] duration-150",
              checked ? "border-accent-line/60 shadow-[0_0_0_3px_var(--focus-ring)]" : "border-border hover:border-border-strong",
            )}
          >
            <ThemePreview theme={theme.value} />
            <span id={`${id}-${theme.value}`} className={cn("flex items-center gap-1.5 px-1 pb-0.5 text-[12.5px] font-medium [&_svg]:size-3.5", checked ? "text-fg" : "text-subtle group-hover:text-fg")}>
              {theme.icon}
              {theme.label}
              {checked && <span className="ml-auto size-1.5 rounded-full bg-accent-line" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const MINI = {
  dark: { bg: "#08080a", panel: "#111114", line: "#2a2a31", strong: "#3a3a42", accent: "#d2f53c", border: "rgb(255 255 255 / 0.08)" },
  light: { bg: "#ececef", panel: "#ffffff", line: "#e4e4e9", strong: "#cfcfd6", accent: "#7a9a00", border: "rgb(12 12 20 / 0.08)" },
};

function ThemePreview({ theme }: { theme: ThemePref }) {
  if (theme === "system") {
    return (
      <div className="relative h-[68px] overflow-hidden rounded-lg sm:h-[84px]" aria-hidden>
        <MiniDashboard colors={MINI.dark} />
        <div className="absolute inset-0 [clip-path:polygon(58%_0,100%_0,100%_100%,42%_100%)]">
          <MiniDashboard colors={MINI.light} />
        </div>
      </div>
    );
  }
  return (
    <div className="h-[68px] overflow-hidden rounded-lg sm:h-[84px]" aria-hidden>
      <MiniDashboard colors={MINI[theme]} />
    </div>
  );
}

function MiniDashboard({ colors }: { colors: (typeof MINI)["dark"] }) {
  return (
    <div className="flex h-full gap-1.5 p-1.5" style={{ background: colors.bg }}>
      <div className="flex w-[24%] flex-col gap-1 pt-1">
        <span className="h-1.5 w-3/4 rounded-full" style={{ background: colors.strong }} />
        <span className="mt-1 h-1 w-full rounded-full" style={{ background: colors.line }} />
        <span className="h-1 w-5/6 rounded-full" style={{ background: colors.line }} />
        <span className="h-1 w-2/3 rounded-full" style={{ background: colors.line }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 rounded-[5px] p-2" style={{ background: colors.panel, boxShadow: `inset 0 0 0 1px ${colors.border}` }}>
        <span className="h-1.5 w-1/2 rounded-full" style={{ background: colors.strong }} />
        <span className="h-1 w-5/6 rounded-full" style={{ background: colors.line }} />
        <span className="h-1 w-2/3 rounded-full" style={{ background: colors.line }} />
        <span className="mt-auto flex items-center gap-1">
          <span className="size-1.5 rounded-full" style={{ background: colors.accent, boxShadow: `0 0 6px ${colors.accent}` }} />
          <span className="h-1 w-1/3 rounded-full" style={{ background: colors.line }} />
        </span>
      </div>
    </div>
  );
}

function KeyboardSection() {
  const shortcuts: [string, string[]][] = [
    ["Command palette", [MOD, "K"]],
    ["Toggle sidebar", [MOD, "\\"]],
    ["Send message", ["↵"]],
    ["New line", ["⇧", "↵"]],
    ["Queue a follow-up while the agent works", [ALT, "↵"]],
    ["Stop the agent", ["esc"]],
  ];
  return (
    <Section id="keyboard" title="Keyboard" description={`Press ${shortcut("K")} anywhere to search, jump to a page, or ask an agent.`}>
      <div className="grid sm:grid-cols-2">
        {shortcuts.map(([label, keys], i) => (
          <div
            key={label}
            className={cn(
              "flex items-center justify-between gap-4 border-border px-5 py-3 text-[13px]",
              i > 0 && "border-t",
              i === 1 && "sm:border-t-0",
              i % 2 === 1 && "sm:border-l",
            )}
          >
            <span className="text-muted">{label}</span>
            <span className="flex shrink-0 gap-1">
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function SessionSection({ onSignOut }: { onSignOut: () => void }) {
  const actor = useApp((s) => s.me?.actor);
  const name = actor ? (actor.kind === "token" ? "Admin token" : actor.name) : "You";
  return (
    <Section id="session" title="Session" description="This browser's sign-in.">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-b from-surface-3 to-surface-2 font-mono text-[11px] font-semibold text-muted ring-1 ring-border-strong">
            {actor?.kind === "token" ? <KeyRound className="size-4" /> : initials(name)}
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
              <span className="truncate">{name}</span>
              {actor && <Badge tone={actor.role === "admin" ? "warning" : "neutral"}>{actor.role === "admin" ? "Admin" : "Member"}</Badge>}
            </p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-subtle">
              Your agents keep running when you sign out. You'll need your {actor?.kind === "user" ? "password" : "token"} to sign back in.
            </p>
          </div>
        </div>
        <Button variant="danger" icon={<LogOut />} onClick={onSignOut} className="shrink-0 self-start sm:self-auto">
          Sign out
        </Button>
      </div>
    </Section>
  );
}

function AboutSection() {
  const version = useApp((s) => s.version);
  const overview = useApp((s) => s.overview);
  const rows: [string, ReactNode][] = [
    ["Version", <span className="font-mono">{version ? `v${version}` : "—"}</span>],
    ["Server", <span className="font-mono">{location.host}</span>],
    ["Uptime", <span className="font-mono">{overview ? duration(overview.uptimeMs) : "—"}</span>],
    ["Runtime", "Pi Durable"],
    [
      "Website",
      <a href="https://soloagent.dev" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline">
        soloagent.dev <ExternalLink className="size-3" />
      </a>,
    ],
  ];
  return (
    <Section id="about" title="About">
      <dl className="divide-y divide-border text-[13px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 px-5 py-3">
            <dt className="label-mono text-faint">{label}</dt>
            <dd className="min-w-0 truncate text-right text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
