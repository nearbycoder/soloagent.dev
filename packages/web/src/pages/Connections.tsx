import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, Check, Ellipsis, Eye, EyeOff, Pencil, Plus, RefreshCw, ShieldCheck, Trash, TriangleAlert } from "lucide-react";
import type { Connector, ConnectorAccess, ConnectorKind, ConnectorKindInfo } from "@soloagent/client";
import { client } from "../api/client.ts";
import { loadKinds, local, useAgentMap, useApp, useIsAdmin } from "../api/store.ts";
import { AgentAvatar, ConnectorTile, KIND_STYLE } from "../components/brand.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Drawer, MenuItem, MenuSeparator, Popover } from "../components/overlay.tsx";
import { Badge, Button, Card, CopyField, Dot, Field, IconButton, Input, Page, PageHeader, SectionHeader, Select, Skeleton, Switch, TagInput } from "../components/ui.tsx";
import { AdminsOnly } from "./Team.tsx";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { confirm, toast } from "../lib/toast.ts";

const SECRET_MASK = "••••••••";

/** How each platform reaches soloagent. All but webhooks dial out, so none needs a public URL. */
const TRANSPORT: Record<ConnectorKind, string> = {
  slack: "Socket Mode · no public URL",
  discord: "Gateway · no public URL",
  telegram: "Long polling · no public URL",
  webhook: "HTTP POST · sync or callback",
};

export function Connections({ editId }: { editId?: string }) {
  const kinds = useApp((s) => s.kinds);
  const connectors = useApp((s) => s.connectors);
  const [createKind, setCreateKind] = useState<ConnectorKind | null>(null);
  const isAdmin = useIsAdmin();

  useEffect(() => {
    void loadKinds();
  }, []);

  useEffect(() => {
    if (editId === "new" && !createKind) setCreateKind("slack");
  }, [editId, createKind]);

  const editing = editId && editId !== "new" ? connectors?.find((c) => c.id === editId) : undefined;
  const closeEditor = () => {
    setCreateKind(null);
    navigate("/connections");
  };

  if (!isAdmin) return <AdminsOnly what="connections" />;

  const startCreate = (kind: ConnectorKind) => {
    setCreateKind(kind);
    navigate("/connections/new");
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Configure"
        title="Connections"
        description="Bring your agents to the places your team already talks. Each connection answers as one agent, and anyone can @mention the others."
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => navigate("/connections/new")}>
            Add connection
          </Button>
        }
      />

      {(connectors === null || connectors.length > 0) && (
        <section className="mb-12">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Your connections</h2>
            {connectors && <Summary connectors={connectors} />}
          </div>
          {!connectors ? (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-[196px] rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {connectors.map((connector) => (
                <ConnectorCard key={connector.id} connector={connector} />
              ))}
            </div>
          )}
        </section>
      )}

      <section>
        <SectionHeader
          title={connectors?.length ? "Add another" : "Connect a platform"}
          description={
            connectors?.length
              ? "About two minutes each. Only webhooks need a public URL."
              : "Your agents already answer here and in the terminal. Connect a platform to reach them from chat too — about two minutes, no public URL needed."
          }
        />
        {!kinds ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[188px] rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {kinds.map((kind) => (
              <KindCard key={kind.kind} info={kind} count={connectors?.filter((c) => c.kind === kind.kind).length ?? 0} onPick={() => startCreate(kind.kind)} />
            ))}
          </div>
        )}
      </section>

      {editId === "new" && createKind && kinds && (
        <ConnectorEditor key={`new-${createKind}`} kinds={kinds} kind={createKind} onKindChange={setCreateKind} onClose={closeEditor} />
      )}
      {editing && kinds && <ConnectorEditor key={editing.id} kinds={kinds} kind={editing.kind} connector={editing} onClose={closeEditor} />}
      {editId && editId !== "new" && connectors && !editing && <Gone />}
    </Page>
  );
}

/** "1 live · 2 off · 1 error", in mono, next to the section title. */
function Summary({ connectors }: { connectors: Connector[] }) {
  const live = connectors.filter((c) => c.enabled && c.status === "connected").length;
  const errors = connectors.filter((c) => c.enabled && c.status === "error").length;
  const starting = connectors.filter((c) => c.enabled && c.status === "starting").length;
  const off = connectors.filter((c) => !c.enabled).length;
  const parts: { n: number; label: string; tone: string; dot: string }[] = [
    { n: live, label: "live", tone: "text-muted", dot: "bg-success" },
    { n: starting, label: "connecting", tone: "text-accent-text", dot: "bg-accent-line" },
    { n: errors, label: errors === 1 ? "error" : "errors", tone: "text-danger", dot: "bg-danger" },
    { n: off, label: "off", tone: "text-subtle", dot: "bg-faint" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11.5px]">
      {parts
        .filter((p) => p.n > 0)
        .map((p) => (
          <span key={p.label} className={cn("flex items-center gap-1.5 tabular-nums", p.tone)}>
            <span className={cn("size-1.5 rounded-full", p.dot)} />
            {p.n} {p.label}
          </span>
        ))}
    </div>
  );
}

/** A platform to connect: tile, pitch, and how it reaches soloagent. */
function KindCard({ info, count, onPick }: { info: ConnectorKindInfo; count: number; onPick: () => void }) {
  const color = KIND_STYLE[info.kind].bg;
  return (
    <button
      type="button"
      onClick={onPick}
      className="group relative flex flex-col items-start overflow-hidden rounded-xl border border-border bg-surface p-4 text-left shadow-card transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-border-strong hover:shadow-md"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-36 rounded-full opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `color-mix(in srgb, ${color} 32%, transparent)` }}
      />
      <div className="relative flex w-full items-start justify-between gap-2">
        <ConnectorTile kind={info.kind} size="lg" />
        {count > 0 && <Badge>{count} added</Badge>}
      </div>
      <h3 className="relative mt-4 text-[14.5px] font-semibold tracking-[-0.01em] text-fg">{info.name}</h3>
      <p className="relative mt-1 text-[12.5px] leading-relaxed text-subtle">{info.tagline}</p>
      <p className="relative mt-3 font-mono text-[11px] text-faint">{TRANSPORT[info.kind]}</p>
      <span className="relative mt-auto inline-flex items-center gap-1 pt-4 text-[12.5px] font-medium text-muted transition-colors group-hover:text-fg">
        Connect {info.name}
        <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

/** "2 users · 1 channel · 1 agent · 20/h", or nothing when the connection is open to everyone. */
function accessSummary(connector: Connector): string {
  const { users, channels, agents } = connector.access;
  const n = (count: number, one: string) => (count ? `${count} ${one}${count === 1 ? "" : "s"}` : "");
  const parts = connector.kind === "webhook" ? [n(agents.length, "agent")] : [n(users.length, "user"), n(channels.length, "channel"), n(agents.length, "agent")];
  if (connector.limits.perUserPerHour !== null) parts.push(`${connector.limits.perUserPerHour}/h per person`);
  return parts.filter(Boolean).join(" · ");
}

/** The webhook driver reports its identity with an "<id>" placeholder; show the real path. */
function identityOf(connector: Connector): string | undefined {
  return connector.identity?.replaceAll("<id>", connector.id);
}

function Gone() {
  useEffect(() => navigate("/connections", { replace: true }), []);
  return null;
}

type StatusTone = "success" | "accent" | "danger" | "neutral";

function statusOf(connector: Connector): { tone: StatusTone; label: string; pulse?: boolean } {
  if (!connector.enabled) return { tone: "neutral", label: "Disabled" };
  switch (connector.status) {
    case "connected":
      return { tone: "success", label: "Connected" };
    case "starting":
      return { tone: "accent", label: "Connecting", pulse: true };
    case "error":
      return { tone: "danger", label: "Error" };
    default:
      return { tone: "neutral", label: "Stopped" };
  }
}

export function StatusPill({ connector }: { connector: Connector }) {
  const status = statusOf(connector);
  return (
    <Badge tone={status.tone}>
      <Dot tone={status.tone} pulse={status.pulse} className="size-1.5 [&>span]:size-1.5" /> {status.label}
    </Badge>
  );
}

function ConnectorCard({ connector }: { connector: Connector }) {
  const agentMap = useAgentMap();
  const agents = useApp((s) => s.agents);
  const agent = connector.agentId ? agentMap.get(connector.agentId) : agents?.find((a) => a.isDefault);
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [toggling, setToggling] = useState(false);
  const status = statusOf(connector);
  const access = accessSummary(connector);
  const identity = identityOf(connector);
  const failing = connector.enabled && connector.status === "error";

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      local.connector(await client.updateConnector(connector.id, { enabled }));
    } catch (error) {
      toast.error(error, "Could not update connection");
    } finally {
      setToggling(false);
    }
  };

  return (
    <Card className={cn("group relative flex flex-col transition-[border-color,box-shadow] duration-200 hover:border-border-strong hover:shadow-md", failing && "border-danger/35 hover:border-danger/50")}>
      <div className="flex items-start gap-3.5 p-4 pb-3.5">
        <ConnectorTile kind={connector.kind} />
        <div className="min-w-0 flex-1">
          {/* The name opens the editor; its overlay makes the whole card a target. */}
          <button
            type="button"
            onClick={() => navigate(`/connections/${connector.id}`)}
            className="block max-w-full truncate text-left text-[14.5px] font-semibold tracking-[-0.01em] text-fg outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-[var(--ring)]"
          >
            {connector.name}
          </button>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-subtle">
            <span className="shrink-0">{KIND_STYLE[connector.kind].label}</span>
            {identity && (
              <>
                <span className="text-faint">·</span>
                <span className="min-w-0 truncate font-mono text-[11.5px] text-muted">{identity}</span>
              </>
            )}
          </p>
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          <Switch checked={connector.enabled} onChange={toggle} disabled={toggling} label={connector.enabled ? "Disable connection" : "Enable connection"} size="sm" />
          <IconButton ref={anchor} label="Connection actions" onClick={() => setMenu((m) => !m)} active={menu}>
            <Ellipsis className="size-4" />
          </IconButton>
          <Popover open={menu} onClose={() => setMenu(false)} anchor={anchor} align="end" className="w-48">
            <MenuItem
              icon={<Pencil />}
              onClick={() => {
                setMenu(false);
                navigate(`/connections/${connector.id}`);
              }}
            >
              Edit
            </MenuItem>
            <MenuItem
              icon={<RefreshCw />}
              onClick={async () => {
                setMenu(false);
                await restart(connector);
              }}
            >
              Restart
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash />}
              onClick={async () => {
                setMenu(false);
                await remove(connector);
              }}
            >
              Delete
            </MenuItem>
          </Popover>
        </div>
      </div>

      {/* Live status */}
      <div className="px-4">
        <div
          className={cn(
            "flex items-start gap-2.5 rounded-lg border px-3 py-2",
            status.tone === "danger" ? "border-danger/25 bg-danger-soft" : status.tone === "accent" ? "border-accent-line/20 bg-surface-2/50" : "border-border bg-surface-2/50",
          )}
        >
          <Dot tone={status.tone} pulse={status.pulse} className="mt-[5px]" />
          <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed">
            <span className={cn("font-medium", status.tone === "danger" ? "text-danger" : status.tone === "accent" ? "text-accent-text" : status.tone === "success" ? "text-fg" : "text-muted")}>
              {status.label}
            </span>
            {connector.statusDetail ? (
              <span className={cn("break-words", failing ? "ml-1.5 font-mono text-[11.5px] text-danger/90" : "ml-1.5 text-subtle")}>{connector.statusDetail}</span>
            ) : !connector.enabled ? (
              <span className="ml-1.5 text-subtle">Settings are kept. Turn it on to connect.</span>
            ) : connector.status === "connected" ? (
              <span className="ml-1.5 text-subtle">{connector.kind === "webhook" ? "Listening for requests" : "Listening for mentions and DMs"}</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Routing and policy */}
      <dl className="grid grid-cols-[minmax(84px,auto)_1fr] items-center gap-x-4 gap-y-2.5 px-4 pb-4 pt-3.5 text-[12.5px]">
        <dt className="label-mono text-faint">Answers as</dt>
        <dd className="flex min-w-0 items-center gap-1.5 text-muted">
          <AgentAvatar agent={agent} size="xs" />
          <span className="truncate text-fg">{agent?.name ?? "Default agent"}</span>
          {agent && <span className="font-mono text-[11.5px] text-faint">@{agent.handle}</span>}
          {!connector.agentId && <span className="rounded border border-border px-1 font-mono text-[10px] leading-[16px] text-faint">default</span>}
        </dd>
        <dt className="label-mono text-faint">Access</dt>
        <dd className="flex min-w-0 items-center gap-1.5 text-muted">
          {access ? (
            <>
              <ShieldCheck className="size-3.5 shrink-0 text-info" />
              <span className="truncate">{access}</span>
            </>
          ) : (
            <span className="truncate text-subtle">{connector.kind === "webhook" ? "Anyone with the secret" : "Everyone, everywhere"}</span>
          )}
        </dd>
        {connector.kind !== "webhook" && (
          <>
            <dt className="label-mono text-faint">Approvals</dt>
            <dd className="truncate text-subtle">
              {connector.approvers.length ? (
                <span className="text-muted">
                  In chat · {connector.approvers.length} {connector.approvers.length === 1 ? "approver" : "approvers"}
                </span>
              ) : (
                "Dashboard only"
              )}
            </dd>
          </>
        )}
      </dl>
    </Card>
  );
}

async function restart(connector: Connector) {
  try {
    local.connector(await client.restartConnector(connector.id));
    toast.info(`Restarting ${connector.name}`);
  } catch (error) {
    toast.error(error, "Could not restart");
  }
}

async function remove(connector: Connector): Promise<boolean> {
  const ok = await confirm({
    title: `Delete ${connector.name}?`,
    body: "The bot disconnects right away. Threads from this connection stay in your history.",
    confirmLabel: "Delete",
    tone: "danger",
  });
  if (!ok) return false;
  try {
    await client.deleteConnector(connector.id);
    local.connectorDeleted(connector.id);
    toast.success(`${connector.name} deleted`);
    return true;
  } catch (error) {
    toast.error(error, "Could not delete");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Editor

/** A titled group of fields in the editor, separated from the one above by a rule. */
function FormSection({ label, icon, description, aside, children, first }: { label: string; icon?: ReactNode; description?: ReactNode; aside?: ReactNode; children: ReactNode; first?: boolean }) {
  return (
    <section className={cn("flex flex-col gap-4", !first && "border-t border-border pt-6")}>
      <div>
        <div className="flex items-center justify-between gap-3">
          <h3 className="label-mono flex items-center gap-1.5 text-faint [&_svg]:size-3.5">
            {icon}
            {label}
          </h3>
          {aside}
        </div>
        {description && <p className="mt-1.5 text-[12.5px] leading-relaxed text-subtle">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function ConnectorEditor({
  kinds,
  kind,
  connector,
  onKindChange,
  onClose,
}: {
  kinds: ConnectorKindInfo[];
  kind: ConnectorKind;
  connector?: Connector;
  onKindChange?: (kind: ConnectorKind) => void;
  onClose: () => void;
}) {
  const info = kinds.find((k) => k.kind === kind)!;
  const agents = useApp((s) => s.agents) ?? [];
  const defaultAgent = agents.find((a) => a.isDefault);
  const [name, setName] = useState(connector?.name ?? info.name);
  const [agentId, setAgentId] = useState<string | null>(connector?.agentId ?? null);
  const [enabled, setEnabled] = useState(connector?.enabled ?? true);
  const [approvers, setApprovers] = useState((connector?.approvers ?? []).join(", "));
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(info.fields.map((f) => [f.key, connector?.config[f.key] ?? ""])));
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [access, setAccess] = useState<ConnectorAccess>(() => connector?.access ?? { users: [], channels: [], agents: [] });
  const [perHour, setPerHour] = useState(connector?.limits.perUserPerHour == null ? "" : String(connector.limits.perUserPerHour));
  const setList = (key: keyof ConnectorAccess) => (values: string[]) => setAccess((a) => ({ ...a, [key]: values }));
  const isChat = kind !== "webhook";
  // Workspace agents this connection would otherwise reach, but can't (chat access is off).
  const blockedWorkspace = isChat
    ? agents.filter(
        (a) =>
          a.skills.includes("workspace") &&
          !a.chatAccess &&
          (access.agents.length === 0 || access.agents.some((x) => x.replace(/^@/, "").toLowerCase() === a.handle || x === a.id)),
      )
    : [];

  const missing = info.fields.filter((f) => !f.optional && !values[f.key]?.trim());
  const origin = location.origin;

  const guide = useMemo(() => {
    let text = info.setup;
    if (kind === "webhook") {
      text = text.replaceAll("https://YOUR-SOLO", origin);
      if (connector) text = text.replaceAll("CONNECTOR_ID", connector.id);
    }
    return text;
  }, [info.setup, kind, origin, connector]);

  const save = async () => {
    if (missing.length) return;
    setSaving(true);
    try {
      const config = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]));
      const approverList = approvers
        .split(/[,\n]/)
        .map((a) => a.trim())
        .filter(Boolean);
      const limit = Number(perHour);
      const limits = { perUserPerHour: perHour.trim() === "" || !Number.isFinite(limit) || limit < 0 ? null : Math.round(limit) };
      if (connector) {
        local.connector(await client.updateConnector(connector.id, { name: name.trim() || info.name, agentId, enabled, config, approvers: approverList, access, limits }));
        toast.success("Connection saved");
        onClose();
      } else {
        const created = await client.createConnector({ kind, name: name.trim() || info.name, agentId, enabled, config, approvers: approverList, access, limits });
        local.connector(created);
        toast.success(`${info.name} added`, "Watch the status below as it connects.");
        // Stay in the editor so the user sees the live status (and the webhook URL).
        navigate(`/connections/${created.id}`, { replace: true });
      }
    } catch (error) {
      toast.error(error, "Could not save connection");
      setSaving(false);
    }
  };

  const hookUrl = connector ? `${origin}/api/hooks/${connector.id}` : null;
  const curl = connector
    ? `curl -X POST ${hookUrl} \\\n  -H 'x-solo-secret: YOUR_SECRET' -H 'content-type: application/json' \\\n  -d '{"text": "Hello from a webhook", "thread": "demo", "user": "ci"}'`
    : null;
  const status = connector ? statusOf(connector) : null;

  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-5xl"
      icon={<ConnectorTile kind={kind} size="sm" />}
      title={connector ? connector.name : `Connect ${info.name}`}
      description={connector ? `${info.name} · added ${relativeTime(connector.createdAt)}` : info.tagline}
      footer={
        <>
          {connector && (
            <Button
              variant="ghost"
              className="text-danger hover:bg-danger-soft hover:text-danger"
              icon={<Trash />}
              onClick={async () => {
                if (await remove(connector)) onClose();
              }}
            >
              Delete
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {connector ? "Close" : "Cancel"}
            </Button>
            <Button variant="primary" loading={saving} disabled={missing.length > 0} onClick={save}>
              {connector ? "Save changes" : `Connect ${info.name}`}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
        <form
          className="flex flex-col gap-6 px-5 py-6 sm:px-6"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!connector && onKindChange && (
            <div role="radiogroup" aria-label="Platform" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {kinds.map((k) => {
                const active = k.kind === kind;
                return (
                  <button
                    key={k.kind}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onKindChange(k.kind)}
                    className={cn(
                      "relative flex flex-col items-center gap-2 rounded-xl border px-2 pb-2.5 pt-3 text-[12.5px] font-medium transition-[border-color,background-color,color,box-shadow] duration-150",
                      active ? "border-border-strong bg-surface-2 text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]" : "border-border text-subtle hover:border-border-strong hover:bg-surface-2/50 hover:text-fg",
                    )}
                  >
                    {active && (
                      <span className="absolute right-1.5 top-1.5 grid size-4 place-items-center rounded-full bg-inverse text-inverse-fg">
                        <Check className="size-2.5" strokeWidth={3} />
                      </span>
                    )}
                    <ConnectorTile kind={k.kind} size="sm" />
                    {k.name}
                  </button>
                );
              })}
            </div>
          )}

          {connector && status && (
            <div
              className={cn(
                "flex items-start gap-3 rounded-xl border px-4 py-3",
                status.tone === "danger" ? "border-danger/30 bg-danger-soft" : status.tone === "accent" ? "border-accent-line/20 bg-surface-2/50" : "border-border bg-surface-2/50",
              )}
            >
              <Dot tone={status.tone} pulse={status.pulse} className="mt-1.5" />
              <div className="min-w-0 flex-1">
                <p className={cn("text-[13px] font-medium", status.tone === "danger" ? "text-danger" : "text-fg")}>{status.label}</p>
                {connector.identity && <p className="mt-0.5 truncate font-mono text-[11.5px] text-muted">{identityOf(connector)}</p>}
                {connector.statusDetail && (
                  <p className={cn("mt-1 break-words text-[12px]", connector.status === "error" ? "font-mono text-danger" : "text-subtle")}>{connector.statusDetail}</p>
                )}
              </div>
              <Button size="xs" variant="secondary" icon={<RefreshCw />} onClick={() => restart(connector)}>
                Restart
              </Button>
            </div>
          )}

          <FormSection label="Credentials" first>
            <Field label="Name" htmlFor="conn-name" hint="Only shown here.">
              <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={info.name} />
            </Field>

            {info.fields.map((field) => {
              const value = values[field.key] ?? "";
              const masked = field.secret && value === SECRET_MASK;
              return (
                <Field
                  key={field.key}
                  label={
                    <span className="flex items-center gap-2">
                      {field.label}
                      {field.optional && <span className="text-[11.5px] font-normal text-faint">optional</span>}
                    </span>
                  }
                  htmlFor={`conn-${field.key}`}
                  hint={masked ? "Saved. Leave as is to keep it, or paste a new value." : field.help}
                >
                  <div className="relative">
                    <Input
                      id={`conn-${field.key}`}
                      type={field.secret && !reveal[field.key] ? "password" : "text"}
                      value={value}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={field.placeholder}
                      className={cn("font-mono text-[12.5px]", field.secret && "pr-10")}
                      onFocus={(e) => masked && e.target.select()}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    />
                    {field.secret && !masked && value && (
                      <button
                        type="button"
                        onClick={() => setReveal((r) => ({ ...r, [field.key]: !r[field.key] }))}
                        aria-label={reveal[field.key] ? "Hide value" : "Show value"}
                        className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-subtle hover:text-fg"
                      >
                        {reveal[field.key] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    )}
                  </div>
                </Field>
              );
            })}
          </FormSection>

          <FormSection label="Routing">
            <Field label="Answers as" htmlFor="conn-agent" hint="Messages that don't @mention a specific agent go to this one.">
              <Select id="conn-agent" value={agentId ?? ""} onChange={(e) => setAgentId(e.target.value || null)}>
                <option value="">Default agent{defaultAgent ? ` (${defaultAgent.name})` : ""}</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.avatar} {a.name} — @{a.handle}
                  </option>
                ))}
              </Select>
            </Field>

            {kind !== "webhook" && (
              <Field
                label="Approvers"
                htmlFor="conn-approvers"
                hint="Who may press Approve or Deny on tool approval requests in this chat: platform user ids or display names, comma-separated. Leave empty to approve only in the dashboard."
              >
                <Input
                  id="conn-approvers"
                  value={approvers}
                  placeholder={kind === "slack" ? "U012ABCDEF, ann" : kind === "discord" ? "123456789012345678, ann" : "123456789, Ann Lee"}
                  onChange={(e) => setApprovers(e.target.value)}
                />
              </Field>
            )}
          </FormSection>

          <FormSection
            label="Access"
            icon={<ShieldCheck />}
            description={
              isChat
                ? "Leave a list empty to allow everyone, everywhere, or every agent. People who aren't allowed get one short reply and an entry in Activity."
                : "Webhooks are authenticated by their secret, so only the agent list applies."
            }
          >
            {isChat && (
              <>
                <Field label="People" htmlFor="conn-users" hint="Platform user ids or display names. Empty: everyone in the workspace or server.">
                  <TagInput id="conn-users" values={access.users} onChange={setList("users")} placeholder="Everyone" />
                </Field>
                <Field label="Channels" htmlFor="conn-channels" hint="Channel ids or names, like #eng. When set, DMs work only for people listed above.">
                  <TagInput id="conn-channels" values={access.channels} onChange={setList("channels")} placeholder="Everywhere" />
                </Field>
              </>
            )}
            <Field label="Agents" htmlFor="conn-agents" hint="Agents people can reach here, by handle. Empty: all agents.">
              <TagInput
                id="conn-agents"
                values={access.agents}
                onChange={setList("agents")}
                placeholder="All agents"
                suggestions={agents.map((a) => ({
                  value: a.handle,
                  label: (
                    <span className="flex items-center gap-2">
                      <AgentAvatar agent={a} size="xs" /> {a.name} <span className="font-mono text-faint">@{a.handle}</span>
                    </span>
                  ),
                }))}
              />
            </Field>
            {blockedWorkspace.length > 0 && (
              <p className="flex gap-2 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {blockedWorkspace.map((a) => `@${a.handle}`).join(", ")} {blockedWorkspace.length === 1 ? "has" : "have"} the workspace skill and can't be reached from chat apps. Turn on chat
                  access in the agent's settings to allow it.
                </span>
              </p>
            )}
            <Field label="Messages per person per hour" htmlFor="conn-rate" hint="Over the limit, people get a short reply instead of an answer. Empty: no limit.">
              <div className="w-40">
                <Input id="conn-rate" type="number" min={0} step={1} value={perHour} placeholder="No limit" className="font-mono" onChange={(e) => setPerHour(e.target.value)} />
              </div>
            </Field>
          </FormSection>

          {kind === "webhook" && (
            <FormSection label="Endpoint">
              {connector ? (
                <div className="flex flex-col gap-2">
                  <CopyField value={hookUrl!} />
                  <CopyField value={curl!} multiline />
                  <p className="text-[12px] text-subtle">
                    Replace <span className="font-mono text-muted">YOUR_SECRET</span> with the shared secret above.
                  </p>
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border px-3 py-3 text-[12.5px] text-subtle">Save to get a ready-to-use URL and curl command.</p>
              )}
            </FormSection>
          )}

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/40 px-4 py-3">
            <div>
              <span className="text-[13.5px] font-medium text-fg">Enabled</span>
              <p className="text-[12.5px] text-subtle">Turn off to disconnect without losing settings.</p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
          </label>
          <button type="submit" hidden />
        </form>

        <section aria-label="Setup guide" className="border-t border-border bg-surface/50 px-5 py-6 sm:px-6 lg:border-l lg:border-t-0">
          <div className="mb-4 flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-md border border-border bg-surface-2 text-muted">
              <BookOpen className="size-3.5" />
            </span>
            <span className="label-mono text-muted">Setup guide</span>
            <span className="ml-auto font-mono text-[11px] text-faint">{TRANSPORT[kind]}</span>
          </div>
          <Markdown text={guide} small />
          {kind === "slack" && <AgentMentionTip />}
        </section>
      </div>
    </Drawer>
  );
}

function AgentMentionTip() {
  const agents = useApp((s) => s.agents) ?? [];
  if (agents.length < 2) return null;
  return (
    <div className="mt-6 rounded-xl border border-border bg-surface p-3.5 text-[12.5px] text-subtle shadow-card">
      <p className="font-medium text-fg">Talk to any agent</p>
      <p className="mt-1 leading-relaxed">
        In Slack, start a message with an agent's handle to route it:{" "}
        {agents.slice(0, 3).map((a, i) => (
          <span key={a.id}>
            {i > 0 && ", "}
            <code className="rounded-md border border-border bg-surface-2 px-1.5 py-px font-mono text-[11.5px] text-fg">@{a.handle}</code>
          </span>
        ))}
        .
      </p>
    </div>
  );
}
