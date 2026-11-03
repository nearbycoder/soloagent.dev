import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Ellipsis, Pencil, Play, Plus, Repeat, Trash } from "lucide-react";
import type { Automation, AutomationInput, AutomationPreset, AutomationPreview, Connector, ConnectorKind, Thread } from "@soloagent/client";
import { client } from "../api/client.ts";
import { useAgentMap, useApp, useIsAdmin, useStream } from "../api/store.ts";
import { AgentAvatar, ConnectorTile, KIND_STYLE, SourceIcon } from "../components/brand.tsx";
import { Drawer, MenuItem, MenuSeparator, Popover } from "../components/overlay.tsx";
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Page, PageHeader, Segmented, Select, Skeleton, Spinner, Switch, Textarea } from "../components/ui.tsx";
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
  const isAdmin = useIsAdmin();

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

// ---------------------------------------------------------------------------
// Page

export function Automations({ editId }: { editId?: string }) {
  const { list, upsert, remove } = useAutomations();
  const editing = editId && editId !== "new" ? list?.find((a) => a.id === editId) : undefined;
  const close = () => navigate("/automations");

  return (
    <Page>
      <PageHeader
        title="Automations"
        description="Prompts that run on a schedule: a standup summary every weekday at 9, a weekly deploy digest, an hourly status check. They are durable, so they keep their schedule across restarts."
        actions={
          isAdmin && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/automations/new")}>
              New automation
            </Button>
          )
        }
      />

      {!list ? (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card className="border-dashed bg-transparent shadow-none">
          <EmptyState
            icon={<Repeat />}
            title="No automations yet"
            description="Create one here, or ask an agent with the Schedule skill: “every weekday at 9 post the open incidents here”."
            action={
              isAdmin && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/automations/new")}>
                  New automation
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((automation) => (
            <AutomationRow key={automation.id} automation={automation} onChange={upsert} onDeleted={remove} />
          ))}
        </div>
      )}

      {editId === "new" && <AutomationEditor key="new" onClose={close} onSaved={upsert} />}
      {editing && <AutomationEditor key={editing.id} automation={editing} onClose={close} onSaved={upsert} onDeleted={remove} />}
      {editId && editId !== "new" && list && !editing && <Gone />}
    </Page>
  );
}

function Gone() {
  useEffect(() => navigate("/automations", { replace: true }), []);
  return null;
}

function StatusBadge({ automation }: { automation: Automation }) {
  if (!automation.enabled) return <Badge>Disabled</Badge>;
  switch (automation.lastStatus) {
    case "running":
      return (
        <Badge tone="accent" dot>
          Running
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

function TargetLabel({ automation }: { automation: Automation }) {
  const threads = useApp((s) => s.threads);
  const connectors = useApp((s) => s.connectors);
  if (automation.target.kind === "thread") {
    const threadId = automation.target.threadId;
    const thread = threads?.find((t) => t.id === threadId);
    return (
      <a href={`/chat/${threadId}`} onClick={linkHandler(`/chat/${threadId}`)} className="inline-flex min-w-0 items-center gap-1 text-muted hover:text-fg hover:underline">
        {thread && <SourceIcon source={thread.source} className="size-3" />}
        <span className="max-w-[220px] truncate">{thread?.title ?? "thread"}</span>
      </a>
    );
  }
  const target = automation.target;
  const connector = connectors?.find((c) => c.id === target.connectorId);
  const label = target.location || Object.values(target.target)[0] || "channel";
  const inner = (
    <>
      {connector && <ConnectorTile kind={connector.kind} size="sm" className="size-4 rounded-[4px] [&_svg]:size-2.5" />}
      <span className="max-w-[220px] truncate">{label}</span>
      {connector && <span className="text-faint">on {connector.name}</span>}
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
  const agent = useAgentMap().get(automation.agentId);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<"toggle" | "run" | null>(null);
  const isAdmin = useIsAdmin();
  const anchor = useRef<HTMLButtonElement>(null);

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
    <Card className={cn("p-4 transition-colors", automation.enabled && automation.lastStatus === "failed" && "border-danger/30")}>
      <div className="flex items-start gap-3.5">
        <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg", automation.enabled ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-subtle")}>
          <Repeat className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => navigate(`/automations/${automation.id}`)} className="truncate text-[14px] font-semibold text-fg hover:underline">
              {automation.name}
            </button>
            <StatusBadge automation={automation} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-subtle">
            <span className="text-muted">
              {automation.scheduleText} <span className="text-faint">({automation.timezone})</span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <AgentAvatar agent={agent} size="xs" /> <span className="text-muted">{agent?.name ?? "deleted agent"}</span>
              <span className="text-faint">→</span>
              <TargetLabel automation={automation} />
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-subtle">
            {automation.enabled && automation.nextRunAt ? (
              <span title={fullDate(automation.nextRunAt)}>
                Next run <span className="text-muted">{relativeTime(automation.nextRunAt)}</span>
              </span>
            ) : (
              <span>Not scheduled</span>
            )}
            {automation.lastRunAt && <span title={fullDate(automation.lastRunAt)}>Last run {relativeTime(automation.lastRunAt)}</span>}
          </div>
          {automation.lastStatus === "failed" && automation.lastError && (
            <p className="mt-2 break-words rounded-md bg-danger-soft px-2.5 py-1.5 font-mono text-[11.5px] text-danger">{automation.lastError}</p>
          )}
        </div>
        {isAdmin && (
        <div className="flex shrink-0 items-center gap-1">
          <Switch checked={automation.enabled} onChange={toggle} disabled={busy === "toggle"} label={automation.enabled ? "Disable automation" : "Enable automation"} size="sm" />
          <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} loading={busy === "run"} onClick={runNow} aria-label="Run now" className="ml-1">
            <span className="hidden sm:inline">Run now</span>
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
        )}
      </div>
    </Card>
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
  weekdays: "Weekdays (Mon–Fri)",
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

// ---------------------------------------------------------------------------
// Editor

type TargetMode = "thread" | "channel";

function AutomationEditor({
  automation,
  onClose,
  onSaved,
  onDeleted,
}: {
  automation?: Automation;
  onClose: () => void;
  onSaved: (a: Automation) => void;
  onDeleted?: (id: string) => void;
}) {
  const agents = useApp((s) => s.agents);
  const threads = useApp((s) => s.threads);
  const connectors = useApp((s) => s.connectors);

  const initialPreset = automation ? cronPreset(automation.cron) : defaultPreset("weekdays");
  const [name, setName] = useState(automation?.name ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
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

  return (
    <Drawer
      open
      onClose={onClose}
      title={automation ? "Edit automation" : "New automation"}
      description={automation ? automation.name : "A prompt that runs on a schedule"}
      icon={
        <div className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent-text">
          <Repeat className="size-4" />
        </div>
      }
      footer={
        <>
          {automation && (
            <Button
              variant="ghost"
              className="text-danger hover:bg-danger-soft hover:text-danger"
              icon={<Trash className="size-4" />}
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
            {automation ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-6 px-5 py-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Name" htmlFor="aut-name">
          <Input id="aut-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Standup summary" autoFocus={!automation} />
        </Field>

        <Field label="Prompt" htmlFor="aut-prompt" hint="What the agent is asked on every run. Write it as you would in chat.">
          <Textarea id="aut-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize yesterday's merged PRs and today's open incidents for the team." />
        </Field>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-medium text-fg">Schedule</h3>
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
          </div>
          {mode === "preset" ? (
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <Select aria-label="Repeat" value={preset.kind} onChange={(e) => setPreset(defaultPreset(e.target.value as PresetKind, "time" in preset ? preset.time : "09:00"))}>
                {(Object.keys(PRESET_LABEL) as PresetKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {PRESET_LABEL[kind]}
                  </option>
                ))}
              </Select>
              {preset.kind === "minutes" || preset.kind === "hours" ? (
                <Input
                  aria-label={preset.kind === "minutes" ? "Minutes" : "Hours"}
                  type="number"
                  min={1}
                  max={preset.kind === "minutes" ? 59 : 23}
                  value={preset.every}
                  onChange={(e) => setPreset({ ...preset, every: Math.max(1, Math.min(preset.kind === "minutes" ? 59 : 23, Number(e.target.value) || 1)) })}
                  className="w-24"
                />
              ) : (
                <>
                  {preset.kind === "weekly" ? (
                    <Select aria-label="Day" value={String(preset.day)} onChange={(e) => setPreset({ ...preset, day: Number(e.target.value) })}>
                      {DAYS.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="hidden sm:block" />
                  )}
                  <Input aria-label="Time" type="time" value={preset.time} onChange={(e) => e.target.value && setPreset({ ...preset, time: e.target.value })} className="w-32" />
                </>
              )}
            </div>
          ) : (
            <Field label="Cron expression" htmlFor="aut-cron" hint="minute hour day-of-month month day-of-week, e.g. 0 9 * * 1-5. Names like mon-fri and jan work too.">
              <Input id="aut-cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" className="font-mono" spellCheck={false} />
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
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-medium text-fg">Where it runs</h3>
            <Segmented
              size="sm"
              value={targetMode}
              onChange={setTargetMode}
              options={[
                { value: "thread", label: "Thread" },
                { value: "channel", label: "Channel" },
              ]}
            />
          </div>
          {targetMode === "thread" ? (
            threadOptions.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-3 text-[12.5px] text-subtle">No threads yet. Start a chat first, or post into a chat channel instead.</p>
            ) : (
              <Field label="Thread" htmlFor="aut-thread" hint="Runs land in this thread as messages from the automation, answered by the thread's agent. Chat threads get the answer in Slack, Discord, or Telegram.">
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
              <div className="grid gap-3 sm:grid-cols-2">
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
              <p className="text-[12px] leading-relaxed text-subtle">
                Each run posts a new top-level message in the channel (on Slack, replies start a thread there). The automation keeps one conversation of its own, so the
                agent remembers earlier runs.
              </p>
            </>
          )}
        </section>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2/40 px-3 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-fg">Enabled</p>
            <p className="text-[12px] text-subtle">Disabled automations keep their settings and can still be run by hand.</p>
          </div>
          <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
        </div>

        {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{error}</p>}
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
      return new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }
  }, [timezone]);
  return (
    <div className="rounded-lg border border-border bg-surface-2/40 px-3 py-2.5" aria-live="polite">
      <div className="flex items-center gap-2 text-[12.5px]">
        <CalendarClock className="size-3.5 text-accent-text" />
        {preview.status === "ok" ? (
          <span className="font-medium text-fg">
            {preview.preview.text} <span className="font-normal text-subtle">({preview.preview.timezone.replaceAll("_", " ")})</span>
          </span>
        ) : preview.status === "error" ? (
          <span className="text-danger">{preview.message}</span>
        ) : (
          <span className="flex items-center gap-2 text-subtle">
            <Spinner className="size-3.5" /> Checking…
          </span>
        )}
      </div>
      {preview.status === "ok" && (
        <ol className="mt-2 flex flex-col gap-1 pl-[22px]">
          {preview.preview.next.map((at, i) => (
            <li key={at} className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className={cn("tabular-nums", i === 0 ? "text-fg" : "text-muted")}>{format.format(at)}</span>
              {at - Date.now() < 30 * 86_400_000 && <span className="shrink-0 text-[11.5px] text-faint">{relativeTime(at)}</span>}
            </li>
          ))}
          {preview.preview.next.length === 0 && <li className="text-[12.5px] text-subtle">Never fires.</li>}
        </ol>
      )}
    </div>
  );
}

