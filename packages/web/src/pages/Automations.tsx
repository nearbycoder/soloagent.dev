import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, CalendarClock, Check, Clock, Ellipsis, LoaderCircle, Pause, Pencil, Play, Plus, Repeat, Trash, X } from "lucide-react";
import type { Automation, AutomationInput, AutomationPreset, AutomationPreview, Connector, ConnectorKind, Thread } from "@soloagent/client";
import { client } from "../api/client.ts";
import { useAgentMap, useApp, useIsAdmin, useStream } from "../api/store.ts";
import { AgentAvatar, KIND_STYLE, SourceIcon } from "../components/brand.tsx";
import { Drawer, MenuItem, MenuSeparator, Popover } from "../components/overlay.tsx";
import { Badge, Button, Card, Field, IconButton, Input, Page, PageHeader, Segmented, Select, Skeleton, Spinner, Switch, Textarea } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { fullDate, relativeTime } from "../lib/format.ts";
import { linkHandler, navigate } from "../lib/router.ts";
import { confirm, toast } from "../lib/toast.ts";

// ---------------------------------------------------------------------------
// Data

function useAutomations() {
  const [list, setList] = useState<Automation[] | null>(null);
  const stream = useStream();
  const status = useApp((s) => s.status);

  const load = useCallback(async () => {
    try {
      setList(await client.automations());
    } catch (error) {
      toast.error(error, "Could not load automations");
      setList((l) => l ?? []);
    }
  }, []);

  // Reload on (re)connect so nothing missed while offline lingers.
  useEffect(() => {
    if (status === "live") void load();
  }, [load, status]);

  useEffect(() => {
    if (!stream) return;
    return stream.on((event) => {
      if (event.type === "automation.updated")
        setList((l) => {
          if (!l) return l;
          const i = l.findIndex((a) => a.id === event.automation.id);
          if (i === -1) return [...l, event.automation];
          const copy = [...l];
          copy[i] = event.automation;
          return copy;
        });
      if (event.type === "automation.deleted") setList((l) => l?.filter((a) => a.id !== event.automationId) ?? null);
    });
  }, [stream]);

  const upsert = (automation: Automation) =>
    setList((l) => (l ? (l.some((a) => a.id === automation.id) ? l.map((a) => (a.id === automation.id ? automation : a)) : [...l, automation]) : [automation]));
  const remove = (id: string) => setList((l) => l?.filter((a) => a.id !== id) ?? null);
  return { list, upsert, remove };
}

/** Re-render every `ms` so relative times ("in 3 minutes") stay current. */
function useTick(ms = 30_000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// ---------------------------------------------------------------------------
// Templates: a running start for the editor

type Template = { name: string; prompt: string; preset: AutomationPreset; blurb: string };

const TEMPLATES: Template[] = [
  {
    name: "Morning standup",
    blurb: "Every weekday at 9:00",
    prompt: "Summarize yesterday's merged PRs and today's open incidents for the team, in five bullets or fewer.",
    preset: { kind: "weekdays", time: "09:00" },
  },
  {
    name: "Weekly deploy digest",
    blurb: "Fridays at 16:00",
    prompt: "Write a digest of this week's deploys: what shipped, what rolled back, and what is still pending.",
    preset: { kind: "weekly", day: 5, time: "16:00" },
  },
  {
    name: "Hourly health check",
    blurb: "Every hour",
    prompt: "Check the API status page and reply only if something looks degraded.",
    preset: { kind: "hours", every: 1 },
  },
];

// ---------------------------------------------------------------------------
// Page

export function Automations({ editId }: { editId?: string }) {
  const isAdmin = useIsAdmin();
  const { list, upsert, remove } = useAutomations();
  const [template, setTemplate] = useState<Template | null>(null);
  const editing = editId && editId !== "new" ? list?.find((a) => a.id === editId) : undefined;
  const close = () => {
    setTemplate(null);
    navigate("/automations");
  };
  const startFrom = (t: Template) => {
    setTemplate(t);
    navigate("/automations/new");
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Fleet"
        title="Automations"
        description="Prompts that run on a schedule: a standup summary every weekday at 9, a weekly deploy digest, an hourly status check. They're durable, so they keep their schedule across restarts."
        actions={
          isAdmin && (
            <Button variant="primary" icon={<Plus />} onClick={() => navigate("/automations/new")}>
              New automation
            </Button>
          )
        }
      />

      {!list ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[84px] rounded-xl" />
          <Skeleton className="h-[260px] rounded-xl" />
        </div>
      ) : list.length === 0 ? (
        <EmptyAutomations isAdmin={isAdmin} onTemplate={startFrom} />
      ) : (
        <>
          <NextUp list={list} />
          <Card className="overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,1fr)_200px_150px_auto] items-center gap-6 border-b border-border px-5 py-2.5 lg:grid">
              <span className="label-mono text-faint">Automation</span>
              <span className="label-mono text-faint">Schedule</span>
              <span className="label-mono text-faint">Next run</span>
              <span className="w-[176px]" aria-hidden />
            </div>
            <ul className="divide-y divide-border">
              {list.map((automation) => (
                <AutomationRow key={automation.id} automation={automation} onChange={upsert} onDeleted={remove} />
              ))}
            </ul>
          </Card>
          {isAdmin && <Templates onPick={startFrom} />}
        </>
      )}

      {editId === "new" && <AutomationEditor key={`new-${template?.name ?? ""}`} template={template ?? undefined} onClose={close} onSaved={upsert} />}
      {editing && <AutomationEditor key={editing.id} automation={editing} onClose={close} onSaved={upsert} onDeleted={remove} />}
      {editId && editId !== "new" && list && !editing && <Gone />}
    </Page>
  );
}

function Gone() {
  useEffect(() => navigate("/automations", { replace: true }), []);
  return null;
}

function EmptyAutomations({ isAdmin, onTemplate }: { isAdmin: boolean; onTemplate: (t: Template) => void }) {
  return (
    <Card className="relative overflow-hidden">
      <div aria-hidden className="bg-dots mask-radial pointer-events-none absolute inset-x-0 top-0 h-64" />
      <div className="relative flex flex-col items-center px-6 pb-8 pt-12 text-center">
        <div className="relative mb-5 grid size-12 place-items-center rounded-2xl border border-border-strong bg-surface-2 text-muted shadow-md">
          <div aria-hidden className="absolute inset-0 -z-10 rounded-2xl bg-accent/20 blur-xl" />
          <Repeat className="size-5" />
        </div>
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">No automations yet</h3>
        <p className="mt-1.5 max-w-md text-balance text-[13px] leading-relaxed text-subtle">
          {isAdmin
            ? "Put an agent on a schedule. Pick a template, start from scratch, or ask an agent with the Schedule skill: “every weekday at 9 post the open incidents here”."
            : "Ask an agent with the Schedule skill, for example “every weekday at 9 post the open incidents here”, or ask an admin to set one up."}
        </p>
        {isAdmin && (
          <Button variant="primary" icon={<Plus />} className="mt-5" onClick={() => navigate("/automations/new")}>
            New automation
          </Button>
        )}
      </div>
      <div className="relative grid border-t border-border sm:grid-cols-3 sm:divide-x sm:divide-border">
        {TEMPLATES.map((t) => (
          <TemplateCard key={t.name} template={t} onPick={isAdmin ? () => onTemplate(t) : undefined} />
        ))}
      </div>
    </Card>
  );
}

function Templates({ onPick }: { onPick: (t: Template) => void }) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Start from a template</h2>
        <span className="hidden text-[12.5px] text-subtle sm:block">Opens the editor, ready to tweak.</span>
      </div>
      <div className="grid overflow-hidden rounded-xl border border-border bg-surface shadow-card sm:grid-cols-3 sm:divide-x sm:divide-border">
        {TEMPLATES.map((t) => (
          <TemplateCard key={t.name} template={t} onPick={() => onPick(t)} />
        ))}
      </div>
    </section>
  );
}

function TemplateCard({ template, onPick }: { template: Template; onPick?: () => void }) {
  const body = (
    <>
      <span className="flex items-center gap-2 font-mono text-[11px] text-faint">
        <Clock className="size-3" />
        {template.blurb}
      </span>
      <span className="mt-2 block text-[13px] font-medium text-fg">{template.name}</span>
      <span className="mt-1 line-clamp-2 block text-[12.5px] leading-relaxed text-subtle">“{template.prompt}”</span>
      {onPick && (
        <span className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors group-hover:text-fg">
          Use template <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      )}
    </>
  );
  return onPick ? (
    <button type="button" onClick={onPick} className="group border-t border-border px-5 py-4 text-left transition-colors first:border-t-0 hover:bg-surface-2/50 sm:border-t-0">
      {body}
    </button>
  ) : (
    <div className="border-t border-border px-5 py-4 first:border-t-0 sm:border-t-0">{body}</div>
  );
}

/** The next scheduled run across all automations, and how many are active. */
function NextUp({ list }: { list: Automation[] }) {
  useTick();
  const agentMap = useAgentMap();
  const now = Date.now();
  const next = list
    .filter((a) => a.enabled && a.nextRunAt && a.nextRunAt > now - 60_000)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
  const running = list.filter((a) => a.lastStatus === "running").length;
  const active = list.filter((a) => a.enabled).length;
  const failed = list.filter((a) => a.enabled && a.lastStatus === "failed").length;
  const agent = next ? agentMap.get(next.agentId) : undefined;

  return (
    <div className="mb-4 flex flex-col gap-4 rounded-xl border border-border bg-surface px-5 py-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
      {next ? (
        <div className="flex min-w-0 items-center gap-3.5">
          <div className="relative grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 text-accent-text shadow-xs">
            <CalendarClock className="size-[18px]" />
          </div>
          <div className="min-w-0">
            <p className="label-mono text-faint">Next run</p>
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13.5px]">
              <span className="truncate font-medium text-fg">{next.name}</span>
              <span className="font-mono text-[12.5px] text-accent-text" title={fullDate(next.nextRunAt!)}>
                {relativeTime(next.nextRunAt!)}
              </span>
              {agent && (
                <span className="flex items-center gap-1.5 text-[12.5px] text-subtle">
                  <AgentAvatar agent={agent} size="xs" /> {agent.name}
                </span>
              )}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3.5">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 text-subtle">
            <Pause className="size-[18px]" />
          </div>
          <div>
            <p className="label-mono text-faint">Next run</p>
            <p className="mt-0.5 text-[13.5px] text-subtle">Nothing scheduled — every automation is off.</p>
          </div>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-5 font-mono text-[11.5px]">
        {running > 0 && (
          <span className="flex items-center gap-1.5 text-accent-text">
            <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-line shadow-[0_0_8px_var(--accent-glow)]" />
            {running} running
          </span>
        )}
        <span className="flex items-center gap-1.5 text-muted">
          <span className="size-1.5 rounded-full bg-success" />
          {active} active
        </span>
        {list.length - active > 0 && (
          <span className="flex items-center gap-1.5 text-subtle">
            <span className="size-1.5 rounded-full bg-faint" />
            {list.length - active} off
          </span>
        )}
        {failed > 0 && (
          <span className="flex items-center gap-1.5 text-danger">
            <span className="size-1.5 rounded-full bg-danger" />
            {failed} failing
          </span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ automation }: { automation: Automation }) {
  if (!automation.enabled) return <Badge>Off</Badge>;
  switch (automation.lastStatus) {
    case "running":
      return (
        <Badge tone="accent">
          <span className="size-1.5 animate-pulse-soft rounded-full bg-current" /> Running
        </Badge>
      );
    case "ok":
      return <Badge tone="success">Last run ok</Badge>;
    case "failed":
      return <Badge tone="danger">Last run failed</Badge>;
    default:
      return <Badge tone="info">Scheduled</Badge>;
  }
}

/** A tile that says, at a glance, how the last run went (or that one is running now). */
function RunStateTile({ automation }: { automation: Automation }) {
  const state = !automation.enabled ? "off" : (automation.lastStatus ?? "scheduled");
  return (
    <div
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-xl border [&_svg]:size-4",
        state === "running"
          ? "border-accent-line/30 bg-accent-soft text-accent-text shadow-[0_0_18px_-6px_var(--accent-glow)]"
          : state === "ok"
            ? "border-success/20 bg-success-soft text-success"
            : state === "failed"
              ? "border-danger/25 bg-danger-soft text-danger"
              : state === "off"
                ? "border-border bg-surface-2 text-faint"
                : "border-border bg-surface-2 text-info",
      )}
    >
      {state === "running" ? <LoaderCircle className="animate-spin" /> : state === "ok" ? <Check /> : state === "failed" ? <X /> : state === "off" ? <Pause /> : <Clock />}
    </div>
  );
}

function TargetLabel({ automation }: { automation: Automation }) {
  const threads = useApp((s) => s.threads);
  const connectors = useApp((s) => s.connectors);
  if (automation.target.kind === "thread") {
    const threadId = automation.target.threadId;
    const thread = threads?.find((t) => t.id === threadId);
    return (
      <a href={`/chat/${threadId}`} onClick={linkHandler(`/chat/${threadId}`)} className="inline-flex min-w-0 items-center gap-1.5 text-muted hover:text-fg hover:underline">
        {thread && <SourceIcon source={thread.source} className="size-3.5" />}
        <span className="max-w-[240px] truncate">{thread?.title ?? "thread"}</span>
      </a>
    );
  }
  const target = automation.target;
  const connector = connectors?.find((c) => c.id === target.connectorId);
  const label = target.location || Object.values(target.target)[0] || "channel";
  const inner = (
    <>
      {connector && <SourceIcon source={connector.kind} className="size-3.5" />}
      <span className="max-w-[200px] truncate">{label}</span>
      {connector && <span className="truncate text-faint">on {connector.name}</span>}
    </>
  );
  return automation.threadId ? (
    <a
      href={`/chat/${automation.threadId}`}
      onClick={linkHandler(`/chat/${automation.threadId}`)}
      className="inline-flex min-w-0 items-center gap-1.5 text-muted hover:text-fg hover:underline"
      title="Open the automation's thread"
    >
      {inner}
    </a>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">{inner}</span>
  );
}

function AutomationRow({ automation, onChange, onDeleted }: { automation: Automation; onChange: (a: Automation) => void; onDeleted: (id: string) => void }) {
  useTick();
  const agent = useAgentMap().get(automation.agentId);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<"toggle" | "run" | null>(null);
  const isAdmin = useIsAdmin();
  const anchor = useRef<HTMLButtonElement>(null);
  const failed = automation.enabled && automation.lastStatus === "failed";

  const toggle = async (enabled: boolean) => {
    setBusy("toggle");
    try {
      onChange(await client.updateAutomation(automation.id, { enabled }));
    } catch (error) {
      toast.error(error, "Could not update automation");
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    setBusy("run");
    try {
      onChange(await client.runAutomation(automation.id));
      toast.success(`Running “${automation.name}”`);
    } catch (error) {
      toast.error(error, "Could not run automation");
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className={cn("group relative grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 transition-colors hover:bg-surface-2/40 sm:px-5 lg:grid-cols-[minmax(0,1fr)_200px_150px_auto] lg:items-center", !automation.enabled && "[&_.dim]:opacity-60")}>
      <div className="flex min-w-0 items-start gap-3.5">
        <RunStateTile automation={automation} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* Admins: the name opens the editor; its overlay makes the whole row a target. */}
            {isAdmin ? (
              <button
                type="button"
                onClick={() => navigate(`/automations/${automation.id}`)}
                className="truncate text-left text-[14px] font-semibold tracking-[-0.01em] text-fg outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-[var(--ring)]"
              >
                {automation.name}
              </button>
            ) : (
              <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-fg">{automation.name}</span>
            )}
            <StatusBadge automation={automation} />
          </div>
          <p className="dim mt-0.5 line-clamp-1 text-[12.5px] text-subtle" title={automation.prompt}>
            {automation.prompt}
          </p>
          <div className="dim relative z-10 mt-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px]">
            <span className="inline-flex items-center gap-1.5 text-fg">
              <AgentAvatar agent={agent} size="xs" />
              {agent?.name ?? "deleted agent"}
            </span>
            <ArrowRight className="size-3 shrink-0 text-faint" />
            <TargetLabel automation={automation} />
          </div>
          {failed && automation.lastError && (
            <p className="mt-2.5 break-words rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 font-mono text-[11.5px] leading-relaxed text-danger">{automation.lastError}</p>
          )}
        </div>
      </div>

      <div className="dim grid grid-cols-2 gap-x-6 pl-[50px] lg:contents">
        <div className="min-w-0">
          <p className="label-mono text-faint lg:hidden">Schedule</p>
          <p className="truncate text-[13px] text-fg">{automation.scheduleText}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-faint" title={`${automation.cron} · ${automation.timezone}`}>
            {automation.cron} · {automation.timezone.split("/").pop()?.replaceAll("_", " ")}
          </p>
        </div>
        <div className="min-w-0">
          <p className="label-mono text-faint lg:hidden">Next run</p>
          {automation.enabled && automation.nextRunAt ? (
            <p className="font-mono text-[12.5px] text-fg" title={fullDate(automation.nextRunAt)}>
              {relativeTime(automation.nextRunAt)}
            </p>
          ) : (
            <p className="font-mono text-[12.5px] text-faint">—</p>
          )}
          <p className="mt-0.5 truncate font-mono text-[11px] text-faint" title={automation.lastRunAt ? fullDate(automation.lastRunAt) : undefined}>
            {automation.lastRunAt ? `last ${relativeTime(automation.lastRunAt)}` : "never ran"}
          </p>
        </div>
      </div>

      {isAdmin ? (
        <div className="relative z-10 flex items-center gap-1.5 pl-[50px] lg:w-[176px] lg:justify-end lg:pl-0">
          <Switch checked={automation.enabled} onChange={toggle} disabled={busy === "toggle"} label={automation.enabled ? "Disable automation" : "Enable automation"} size="sm" />
          <Button size="sm" variant={automation.enabled ? "accent" : "secondary"} icon={<Play className="fill-current" />} loading={busy === "run"} onClick={runNow} aria-label="Run now" className="ml-1.5">
            Run now
          </Button>
          <IconButton ref={anchor} label="Automation actions" onClick={() => setMenu((m) => !m)} active={menu}>
            <Ellipsis className="size-4" />
          </IconButton>
          <Popover open={menu} onClose={() => setMenu(false)} anchor={anchor} align="end" className="w-44">
            <MenuItem
              icon={<Pencil />}
              onClick={() => {
                setMenu(false);
                navigate(`/automations/${automation.id}`);
              }}
            >
              Edit
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash />}
              onClick={async () => {
                setMenu(false);
                if (await removeAutomation(automation)) onDeleted(automation.id);
              }}
            >
              Delete
            </MenuItem>
          </Popover>
        </div>
      ) : (
        <span className="hidden lg:block lg:w-[176px]" />
      )}
    </li>
  );
}

async function removeAutomation(automation: Automation): Promise<boolean> {
  const ok = await confirm({ title: `Delete “${automation.name}”?`, body: "It stops running. Its thread and past messages stay.", confirmLabel: "Delete", tone: "danger" });
  if (!ok) return false;
  try {
    await client.deleteAutomation(automation.id);
    toast.success("Automation deleted");
    return true;
  } catch (error) {
    toast.error(error, "Could not delete");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Schedules: presets ⇄ cron

type PresetKind = AutomationPreset["kind"];
const PRESET_LABEL: Record<PresetKind, string> = {
  minutes: "Every N minutes",
  hours: "Every N hours",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Once a week",
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");

function presetCron(p: AutomationPreset): string {
  const [h, m] = "time" in p ? p.time.split(":").map(Number) : [0, 0];
  switch (p.kind) {
    case "minutes":
      return p.every === 1 ? "* * * * *" : `*/${p.every} * * * *`;
    case "hours":
      return p.every === 1 ? "0 * * * *" : `0 */${p.every} * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${p.day}`;
  }
}

/** The preset a cron expression stands for, when it is one. */
function cronPreset(cron: string): AutomationPreset | undefined {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return undefined;
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  if (dom !== "*" || mon !== "*") return undefined;
  if (h === "*" && dow === "*") {
    if (m === "*") return { kind: "minutes", every: 1 };
    const step = /^\*\/(\d+)$/.exec(m);
    if (step) return { kind: "minutes", every: Number(step[1]) };
  }
  if (m === "0" && dow === "*") {
    if (h === "*") return { kind: "hours", every: 1 };
    const step = /^\*\/(\d+)$/.exec(h);
    if (step) return { kind: "hours", every: Number(step[1]) };
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
    const time = `${pad(Number(h))}:${pad(Number(m))}`;
    if (dow === "*") return { kind: "daily", time };
    if (dow === "1-5" || dow === "mon-fri") return { kind: "weekdays", time };
    if (/^[0-6]$/.test(dow)) return { kind: "weekly", day: Number(dow), time };
  }
  return undefined;
}

function defaultPreset(kind: PresetKind, time = "09:00"): AutomationPreset {
  switch (kind) {
    case "minutes":
      return { kind, every: 15 };
    case "hours":
      return { kind, every: 1 };
    case "weekly":
      return { kind, day: 1, time };
    default:
      return { kind, time };
  }
}

const BROWSER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const TIME_ZONES: string[] = (() => {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return [...new Set(["UTC", BROWSER_TZ, ...zones])];
  } catch {
    return ["UTC", BROWSER_TZ];
  }
})();

const CHANNEL_HELP: Record<ConnectorKind, { label: string; placeholder: string; hint: string }> = {
  slack: { label: "Channel ID", placeholder: "C0123456789", hint: "In Slack: open the channel → its name → About → Channel ID. Invite the bot to the channel first." },
  discord: { label: "Channel ID", placeholder: "1234567890123456789", hint: "Enable Developer Mode in Discord, then right-click the channel → Copy Channel ID." },
  telegram: { label: "Chat ID", placeholder: "-1001234567890", hint: "The group's chat id; add :topicId to post into a forum topic." },
  webhook: { label: "Callback URL", placeholder: "https://example.com/hooks/solo", hint: "Each answer is POSTed here as { thread, text }." },
};

/** The five cron fields, labeled under the expression. */
const CRON_FIELDS = ["minute", "hour", "day", "month", "weekday"];

// ---------------------------------------------------------------------------
// Editor

type TargetMode = "thread" | "channel";

/** A titled group of fields, separated from the one above by a rule. */
function FormSection({ label, aside, children, first }: { label: string; aside?: ReactNode; children: ReactNode; first?: boolean }) {
  return (
    <section className={cn("flex flex-col gap-4", !first && "border-t border-border pt-6")}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <p className="label-mono text-faint">{label}</p>
        {aside}
      </div>
      {children}
    </section>
  );
}

function AutomationEditor({
  automation,
  template,
  onClose,
  onSaved,
  onDeleted,
}: {
  automation?: Automation;
  template?: Template;
  onClose: () => void;
  onSaved: (a: Automation) => void;
  onDeleted?: (id: string) => void;
}) {
  const agents = useApp((s) => s.agents);
  const threads = useApp((s) => s.threads);
  const connectors = useApp((s) => s.connectors);

  const initialPreset = automation ? cronPreset(automation.cron) : (template?.preset ?? defaultPreset("weekdays"));
  const [name, setName] = useState(automation?.name ?? template?.name ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? template?.prompt ?? "");
  const [mode, setMode] = useState<"preset" | "cron">(initialPreset ? "preset" : "cron");
  const [preset, setPreset] = useState<AutomationPreset>(initialPreset ?? defaultPreset("weekdays"));
  const [cron, setCron] = useState(automation?.cron ?? presetCron(preset));
  const [timezone, setTimezone] = useState(automation?.timezone ?? BROWSER_TZ);
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);

  const initialTarget = automation?.target;
  const [targetMode, setTargetMode] = useState<TargetMode>(initialTarget?.kind ?? "thread");
  const [threadId, setThreadId] = useState(initialTarget?.kind === "thread" ? initialTarget.threadId : "");
  const [connectorId, setConnectorId] = useState(initialTarget?.kind === "channel" ? initialTarget.connectorId : "");
  const [channel, setChannel] = useState(() => {
    if (initialTarget?.kind !== "channel") return "";
    const t = initialTarget.target;
    return t.channel ?? t.channelId ?? (t.chatId ? `${t.chatId}${t.threadId ? `:${t.threadId}` : ""}` : (t.callbackUrl ?? t.thread ?? ""));
  });
  const [location, setLocation] = useState(initialTarget?.kind === "channel" ? (initialTarget.location ?? "") : "");
  const [agentId, setAgentId] = useState(automation?.agentId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defaults once the lists arrive.
  useEffect(() => {
    if (!threadId && threads?.length) setThreadId(threads[0]!.id);
  }, [threads, threadId]);
  useEffect(() => {
    if (!connectorId && connectors?.length) setConnectorId(connectors[0]!.id);
  }, [connectors, connectorId]);

  const expression = mode === "preset" ? presetCron(preset) : cron;
  const preview = usePreview(expression, timezone);
  const connector: Connector | undefined = connectors?.find((c) => c.id === connectorId);
  const help = connector ? CHANNEL_HELP[connector.kind] : undefined;

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Give it a name.");
    if (!prompt.trim()) return setError("Write the prompt the agent gets on each run.");
    if (targetMode === "thread" && !threadId) return setError("Pick a thread.");
    if (targetMode === "channel" && (!connectorId || !channel.trim())) return setError("Pick a connection and enter a channel.");
    const input: AutomationInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      timezone,
      enabled,
      ...(mode === "preset" ? { preset } : { cron: cron.trim() }),
      target: targetMode === "thread" ? { kind: "thread", threadId } : { kind: "channel", connectorId, channel: channel.trim(), location: location.trim() || null },
      ...(targetMode === "channel" && agentId ? { agentId } : {}),
    };
    setSaving(true);
    try {
      const saved = automation ? await client.updateAutomation(automation.id, input) : await client.createAutomation(input);
      onSaved(saved);
      toast.success(automation ? "Automation saved" : "Automation created");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const threadOptions = useMemo(() => (threads ?? []).slice(0, 200), [threads]);
  const defaultAgent = connector?.agentId ? agents?.find((a) => a.id === connector.agentId) : agents?.find((a) => a.isDefault);
  const pickedThread = threadOptions.find((t) => t.id === threadId);
  const threadAgent = pickedThread ? agents?.find((a) => a.id === pickedThread.agentId) : undefined;

  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-2xl"
      title={automation ? "Edit automation" : "New automation"}
      description={automation ? automation.name : template ? `From the “${template.name}” template` : "A prompt that runs on a schedule"}
      icon={
        <div className="grid size-9 place-items-center rounded-xl border border-border bg-surface-2 text-accent-text shadow-xs">
          <Repeat className="size-4" />
        </div>
      }
      footer={
        <>
          {automation && (
            <Button
              variant="ghost"
              className="text-danger hover:bg-danger-soft hover:text-danger"
              icon={<Trash />}
              onClick={async () => {
                if (await removeAutomation(automation)) {
                  onDeleted?.(automation.id);
                  onClose();
                }
              }}
            >
              Delete
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {automation ? "Save" : "Create automation"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-6 px-5 py-6 sm:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {!automation && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-subtle">Start from</span>
            {TEMPLATES.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => {
                  setName(t.name);
                  setPrompt(t.prompt);
                  setMode("preset");
                  setPreset(t.preset);
                }}
                className={cn(
                  "h-7 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
                  name === t.name && prompt === t.prompt ? "border-border-strong bg-surface-2 text-fg" : "border-border text-muted hover:border-border-strong hover:text-fg",
                )}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}

        <FormSection label="Task" first>
          <Field label="Name" htmlFor="aut-name">
            <Input id="aut-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Standup summary" autoFocus={!automation} />
          </Field>
          <Field label="Prompt" htmlFor="aut-prompt" hint="What the agent is asked on every run. Write it as you would in chat.">
            <Textarea id="aut-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize yesterday's merged PRs and today's open incidents for the team." />
          </Field>
        </FormSection>

        <FormSection
          label="Schedule"
          aside={
            <Segmented
              size="sm"
              value={mode}
              onChange={(next) => {
                if (next === "cron") setCron(expression);
                else {
                  const parsed = cronPreset(cron);
                  if (parsed) setPreset(parsed);
                }
                setMode(next);
              }}
              options={[
                { value: "preset", label: "Simple" },
                { value: "cron", label: "Cron" },
              ]}
            />
          }
        >
          {mode === "preset" ? (
            <div className="flex flex-col gap-3">
              <div role="radiogroup" aria-label="Repeat" className="flex flex-wrap gap-1.5">
                {(Object.keys(PRESET_LABEL) as PresetKind[]).map((kind) => {
                  const active = preset.kind === kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => !active && setPreset(defaultPreset(kind, "time" in preset ? preset.time : "09:00"))}
                      className={cn(
                        "h-8 rounded-lg border px-3 text-[12.5px] font-medium transition-[border-color,background-color,color,box-shadow] duration-150",
                        active ? "border-border-strong bg-surface-2 text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]" : "border-border text-muted hover:border-border-strong hover:text-fg",
                      )}
                    >
                      {PRESET_LABEL[kind]}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-2.5 text-[13px] text-subtle">
                {preset.kind === "minutes" || preset.kind === "hours" ? (
                  <>
                    <span>Every</span>
                    <div className="w-20">
                      <Input
                        aria-label={preset.kind === "minutes" ? "Minutes" : "Hours"}
                        type="number"
                        min={1}
                        max={preset.kind === "minutes" ? 59 : 23}
                        value={preset.every}
                        onChange={(e) => setPreset({ ...preset, every: Math.max(1, Math.min(preset.kind === "minutes" ? 59 : 23, Number(e.target.value) || 1)) })}
                        className="font-mono"
                      />
                    </div>
                    <span>{preset.kind === "minutes" ? (preset.every === 1 ? "minute" : "minutes") : preset.every === 1 ? "hour" : "hours"}</span>
                  </>
                ) : (
                  <>
                    {preset.kind === "weekly" && (
                      <>
                        <span>On</span>
                        <Select aria-label="Day" value={String(preset.day)} onChange={(e) => setPreset({ ...preset, day: Number(e.target.value) })} className="w-40">
                          {DAYS.map((d, i) => (
                            <option key={d} value={i}>
                              {d}
                            </option>
                          ))}
                        </Select>
                      </>
                    )}
                    <span>at</span>
                    <div className="w-36">
                      <Input aria-label="Time" type="time" value={preset.time} onChange={(e) => e.target.value && setPreset({ ...preset, time: e.target.value })} className="font-mono" />
                    </div>
                  </>
                )}
                <code className="ml-auto rounded-md border border-border bg-surface-2/60 px-2 py-1 font-mono text-[11.5px] text-subtle" title="The cron expression this stands for">
                  {expression}
                </code>
              </div>
            </div>
          ) : (
            <Field label="Cron expression" htmlFor="aut-cron" hint="Names like mon-fri and jan work too.">
              <div>
                <Input id="aut-cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" className="h-10 font-mono text-[14px] tracking-wide" spellCheck={false} />
                <div className="mt-1.5 grid grid-cols-5 gap-1 px-1" aria-hidden>
                  {CRON_FIELDS.map((f, i) => {
                    const value = cron.trim().split(/\s+/)[i];
                    return (
                      <div key={f} className="min-w-0 border-t border-border pt-1">
                        <p className="truncate font-mono text-[11.5px] text-muted">{value || "·"}</p>
                        <p className="label-mono truncate text-[9.5px] text-faint">{f}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Field>
          )}
          <Field label="Time zone" htmlFor="aut-tz">
            <Select id="aut-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {(TIME_ZONES.includes(timezone) ? TIME_ZONES : [timezone, ...TIME_ZONES]).map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replaceAll("_", " ")}
                  {tz === BROWSER_TZ ? " (yours)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <PreviewBox preview={preview} timezone={timezone} />
        </FormSection>

        <FormSection
          label="Destination"
          aside={
            <Segmented
              size="sm"
              value={targetMode}
              onChange={setTargetMode}
              options={[
                { value: "thread", label: "Thread" },
                { value: "channel", label: "Channel" },
              ]}
            />
          }
        >
          {targetMode === "thread" ? (
            threadOptions.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-3 text-[12.5px] text-subtle">No threads yet. Start a chat first, or post into a chat channel instead.</p>
            ) : (
              <Field
                label="Thread"
                htmlFor="aut-thread"
                hint={
                  <>
                    Runs land in this thread as messages from the automation, answered by the thread's agent
                    {threadAgent ? (
                      <>
                        {" "}
                        (<span className="text-muted">{threadAgent.name}</span>)
                      </>
                    ) : null}
                    . Chat threads get the answer in Slack, Discord, or Telegram.
                  </>
                }
              >
                <Select id="aut-thread" value={threadId} onChange={(e) => setThreadId(e.target.value)}>
                  {threadOptions.map((t: Thread) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                      {t.source !== "web" ? ` · ${t.source}${t.location ? ` ${t.location}` : ""}` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          ) : !connectors?.length ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-3 text-[12.5px] text-subtle">
              No connections yet.{" "}
              <a href="/connections" onClick={linkHandler("/connections")} className="text-accent-text hover:underline">
                Connect Slack, Discord, or Telegram
              </a>{" "}
              first.
            </p>
          ) : (
            <>
              <Field label="Connection" htmlFor="aut-connector">
                <Select id="aut-connector" value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
                  {connectors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({KIND_STYLE[c.kind].label})
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={help?.label ?? "Channel"} htmlFor="aut-channel" hint={help?.hint}>
                  <Input id="aut-channel" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder={help?.placeholder} className="font-mono" spellCheck={false} />
                </Field>
                <Field label="Label" htmlFor="aut-location" hint="Shown in the dashboard, e.g. #eng.">
                  <Input id="aut-location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="#eng" />
                </Field>
              </div>
              <Field label="Agent" htmlFor="aut-agent">
                <Select id="aut-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  <option value="">{defaultAgent ? `${defaultAgent.name} (the connection's agent)` : "The connection's agent"}</option>
                  {agents?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} (@{a.handle})
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="rounded-lg border border-border bg-surface-2/40 px-3 py-2.5 text-[12px] leading-relaxed text-subtle">
                Each run posts a new top-level message in the channel (on Slack, replies start a thread there). The automation keeps one conversation of its own, so the agent remembers
                earlier runs.
              </p>
            </>
          )}
        </FormSection>

        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/40 px-4 py-3">
          <div>
            <p className="text-[13.5px] font-medium text-fg">Enabled</p>
            <p className="text-[12.5px] text-subtle">Disabled automations keep their settings and can still be run by hand.</p>
          </div>
          <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
        </label>

        {error && <p className="rounded-lg border border-danger/20 bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">{error}</p>}
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Live preview of the next runs

type PreviewState = { status: "loading" } | { status: "ok"; preview: AutomationPreview } | { status: "error"; message: string };

function usePreview(cron: string, timezone: string): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  useEffect(() => {
    if (!cron.trim()) {
      setState({ status: "error", message: "Enter a cron expression." });
      return;
    }
    let cancelled = false;
    setState((s) => (s.status === "ok" ? s : { status: "loading" }));
    const timer = setTimeout(() => {
      client
        .previewAutomation(cron, timezone)
        .then((preview) => !cancelled && setState({ status: "ok", preview }))
        .catch((error: unknown) => !cancelled && setState({ status: "error", message: error instanceof Error ? error.message : String(error) }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cron, timezone]);
  return state;
}

function PreviewBox({ preview, timezone }: { preview: PreviewState; timezone: string }) {
  const format = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch {
      return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }
  }, [timezone]);
  return (
    <div className={cn("overflow-hidden rounded-xl border", preview.status === "error" ? "border-danger/25 bg-danger-soft" : "border-border bg-surface-2/40")} aria-live="polite">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-[12.5px]">
        <CalendarClock className={cn("size-3.5 shrink-0", preview.status === "error" ? "text-danger" : "text-accent-text")} />
        {preview.status === "ok" ? (
          <span className="min-w-0 truncate font-medium text-fg">
            {preview.preview.text} <span className="font-normal text-subtle">· {preview.preview.timezone.replaceAll("_", " ")}</span>
          </span>
        ) : preview.status === "error" ? (
          <span className="text-danger">{preview.message}</span>
        ) : (
          <span className="flex items-center gap-2 text-subtle">
            <Spinner className="size-3.5" /> Checking…
          </span>
        )}
        <span className="label-mono ml-auto shrink-0 text-faint">Next runs</span>
      </div>
      {preview.status === "ok" && (
        <ol className="px-3.5 py-2">
          {preview.preview.next.map((at, i) => (
            <li key={at} className="flex items-center gap-3 py-1 text-[12.5px]">
              <span className={cn("size-1.5 shrink-0 rounded-full", i === 0 ? "bg-accent-line shadow-[0_0_8px_var(--accent-glow)]" : "bg-border-strong")} aria-hidden />
              <span className={cn("font-mono tabular-nums", i === 0 ? "text-fg" : "text-muted")}>{format.format(at)}</span>
              {at - Date.now() < 30 * 86_400_000 && <span className="ml-auto shrink-0 font-mono text-[11.5px] text-faint">{relativeTime(at)}</span>}
            </li>
          ))}
          {preview.preview.next.length === 0 && <li className="py-1 text-[12.5px] text-subtle">Never fires.</li>}
        </ol>
      )}
    </div>
  );
}
