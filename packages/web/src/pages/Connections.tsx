import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Ellipsis, Eye, EyeOff, Pencil, Plug, Plus, RefreshCw, ShieldCheck, Trash, TriangleAlert } from "lucide-react";
import type { Connector, ConnectorAccess, ConnectorKind, ConnectorKindInfo } from "@soloagent/client";
import { client } from "../api/client.ts";
import { loadKinds, local, useAgentMap, useApp, useIsAdmin } from "../api/store.ts";
import { AgentAvatar, ConnectorTile, KIND_STYLE } from "../components/brand.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Drawer, MenuItem, MenuSeparator, Popover } from "../components/overlay.tsx";
import { Badge, Button, Card, CopyField, Dot, EmptyState, Field, IconButton, Input, Page, PageHeader, SectionHeader, Select, Skeleton, Switch, TagInput } from "../components/ui.tsx";
import { AdminsOnly } from "./Team.tsx";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { confirm, toast } from "../lib/toast.ts";

const SECRET_MASK = "••••••••";

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

  return (
    <Page>
      <PageHeader
        title="Connections"
        description="Bring your agents to the places your team already talks. Each connection can answer as a specific agent, and anyone can @mention the others."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/connections/new")}>
            Add connection
          </Button>
        }
      />

      {(connectors === null || connectors.length > 0) && (
        <section className="mb-10">
          <SectionHeader title="Your connections" />
          {!connectors ? (
            <div className="flex flex-col gap-3">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-[84px] rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {connectors.map((connector) => (
                <ConnectorRow key={connector.id} connector={connector} />
              ))}
            </div>
          )}
        </section>
      )}

      <section>
        <SectionHeader title={connectors?.length ? "Add another" : "Connect a platform"} description="Setup takes about two minutes. No public URL needed for Slack, Discord, or Telegram." />
        {!kinds ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[120px] rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {kinds.map((kind) => {
              const count = connectors?.filter((c) => c.kind === kind.kind).length ?? 0;
              return (
                <Card key={kind.kind} interactive className="flex items-start gap-4 p-4">
                  <ConnectorTile kind={kind.kind} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[14px] font-semibold text-fg">{kind.name}</h3>
                      {count > 0 && <Badge>{count} added</Badge>}
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-subtle">{kind.tagline}</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-3"
                      onClick={() => {
                        setCreateKind(kind.kind);
                        navigate("/connections/new");
                      }}
                    >
                      Connect {kind.name}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {connectors?.length === 0 && kinds && (
        <Card className="mt-10 border-dashed bg-transparent shadow-none">
          <EmptyState icon={<Plug />} title="Nothing connected yet" description="Your agents already work in this web app and the terminal. Add a connection to reach them from chat platforms too." />
        </Card>
      )}

      {editId === "new" && createKind && kinds && (
        <ConnectorEditor key={`new-${createKind}`} kinds={kinds} kind={createKind} onKindChange={setCreateKind} onClose={closeEditor} />
      )}
      {editing && kinds && <ConnectorEditor key={editing.id} kinds={kinds} kind={editing.kind} connector={editing} onClose={closeEditor} />}
      {editId && editId !== "new" && connectors && !editing && <Gone />}
    </Page>
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

export function StatusPill({ connector }: { connector: Connector }) {
  if (!connector.enabled) return <Badge>Disabled</Badge>;
  switch (connector.status) {
    case "connected":
      return (
        <Badge tone="success">
          <Dot tone="success" className="size-1.5 [&>span]:size-1.5" /> Connected
        </Badge>
      );
    case "starting":
      return (
        <Badge tone="warning">
          <Dot tone="warning" pulse className="size-1.5 [&>span]:size-1.5" /> Starting
        </Badge>
      );
    case "error":
      return (
        <Badge tone="danger">
          <Dot tone="danger" className="size-1.5 [&>span]:size-1.5" /> Error
        </Badge>
      );
    default:
      return <Badge>Stopped</Badge>;
  }
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const agentMap = useAgentMap();
  const agents = useApp((s) => s.agents);
  const agent = connector.agentId ? agentMap.get(connector.agentId) : agents?.find((a) => a.isDefault);
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [toggling, setToggling] = useState(false);

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
    <Card className={cn("p-4 transition-colors", connector.enabled && connector.status === "error" && "border-danger/30")}>
      <div className="flex items-start gap-3.5">
        <ConnectorTile kind={connector.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => navigate(`/connections/${connector.id}`)} className="truncate text-[14px] font-semibold text-fg hover:underline">
              {connector.name}
            </button>
            <StatusPill connector={connector} />
            {accessSummary(connector) && (
              <Badge tone="info">
                <ShieldCheck className="size-3" />
                {accessSummary(connector)}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-subtle">
            <span>{KIND_STYLE[connector.kind].label}</span>
            {connector.identity && (
              <>
                <span className="text-faint">·</span>
                <span className="min-w-0 truncate text-muted">{identityOf(connector)}</span>
              </>
            )}
            <span className="text-faint">·</span>
            <span className="flex items-center gap-1.5">
              answers as <AgentAvatar agent={agent} size="xs" /> <span className="text-muted">{agent?.name ?? "default agent"}</span>
              {!connector.agentId && <span className="text-faint">(default)</span>}
            </span>
          </div>
          {connector.enabled && connector.status === "error" && connector.statusDetail && (
            <p className="mt-2 break-words rounded-md bg-danger-soft px-2.5 py-1.5 font-mono text-[11.5px] text-danger">{connector.statusDetail}</p>
          )}
          {connector.status !== "error" && connector.statusDetail && <p className="mt-1.5 text-[12px] text-faint">{connector.statusDetail}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
            <>
              <Button
                variant="ghost"
                className="text-danger hover:bg-danger-soft hover:text-danger"
                icon={<Trash className="size-4" />}
                onClick={async () => {
                  if (await remove(connector)) onClose();
                }}
              >
                Delete
              </Button>
              <Button variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => restart(connector)} className="hidden sm:inline-flex">
                Restart
              </Button>
            </>
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
      <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <form
          className="flex flex-col gap-5 px-5 py-6"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!connector && onKindChange && (
            <div className="grid grid-cols-4 gap-2">
              {kinds.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => onKindChange(k.kind)}
                  aria-pressed={k.kind === kind}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-xl border px-2 py-3 text-[12px] font-medium transition-all",
                    k.kind === kind ? "border-accent-line/60 bg-accent-soft text-fg ring-3 ring-accent-line/10" : "border-border text-subtle hover:border-border-strong hover:text-fg",
                  )}
                >
                  <ConnectorTile kind={k.kind} size="sm" />
                  {k.name}
                </button>
              ))}
            </div>
          )}

          {connector && (
            <div className={cn("rounded-xl border p-3.5", connector.enabled && connector.status === "error" ? "border-danger/30 bg-danger-soft" : "border-border bg-surface-2/40")}>
              <div className="flex items-center gap-2">
                <StatusPill connector={connector} />
                {connector.identity && <span className="min-w-0 truncate text-[12.5px] text-muted">{identityOf(connector)}</span>}
                <Button size="xs" variant="ghost" className="ml-auto" icon={<RefreshCw className="size-3" />} onClick={() => restart(connector)}>
                  Restart
                </Button>
              </div>
              {connector.statusDetail && <p className={cn("mt-2 break-words text-[12px]", connector.status === "error" ? "font-mono text-danger" : "text-subtle")}>{connector.statusDetail}</p>}
            </div>
          )}

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
              <Input id="conn-approvers" value={approvers} placeholder={kind === "slack" ? "U012ABCDEF, ann" : kind === "discord" ? "123456789012345678, ann" : "123456789, Ann Lee"} onChange={(e) => setApprovers(e.target.value)} />
            </Field>
          )}
          <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
            <div>
              <h4 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                <ShieldCheck className="size-4 text-accent-text" /> Access
              </h4>
              <p className="mt-1 text-[12.5px] leading-relaxed text-subtle">
                {isChat
                  ? "Leave a list empty to allow everyone, everywhere, or every agent. People who aren't allowed get one short reply and an entry in Activity."
                  : "Webhooks are authenticated by their secret, so only the agent list applies."}
              </p>
            </div>
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
                suggestions={agents.map((a) => ({ value: a.handle, label: <span className="flex items-center gap-2"><AgentAvatar agent={a} size="xs" /> {a.name} <span className="font-mono text-faint">@{a.handle}</span></span> }))}
              />
            </Field>
            {blockedWorkspace.length > 0 && (
              <p className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {blockedWorkspace.map((a) => `@${a.handle}`).join(", ")} {blockedWorkspace.length === 1 ? "has" : "have"} the workspace skill and can't be reached from chat apps. Turn on chat
                  access in the agent's settings to allow it.
                </span>
              </p>
            )}
            <Field label="Messages per person per hour" htmlFor="conn-rate" hint="Over the limit, people get a short reply instead of an answer. Empty: no limit.">
              <Input id="conn-rate" type="number" min={0} step={1} value={perHour} placeholder="No limit" className="w-40" onChange={(e) => setPerHour(e.target.value)} />
            </Field>
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
            <div>
              <span className="text-[13.5px] font-medium text-fg">Enabled</span>
              <p className="text-[12.5px] text-subtle">Turn off to disconnect without losing settings.</p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
          </label>

          {kind === "webhook" && (
            <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface-2/40 p-4">
              <h4 className="text-[13px] font-semibold text-fg">Your endpoint</h4>
              {connector ? (
                <>
                  <CopyField value={hookUrl!} />
                  <CopyField value={curl!} multiline />
                  <p className="text-[12px] text-subtle">
                    Replace <span className="font-mono">YOUR_SECRET</span> with the shared secret above.
                  </p>
                </>
              ) : (
                <p className="text-[12.5px] text-subtle">Save to get a ready-to-use URL and curl command.</p>
              )}
            </div>
          )}
          <button type="submit" hidden />
        </form>

        <aside className="border-t border-border bg-surface-2/30 px-5 py-6 lg:border-l lg:border-t-0">
          <h3 className="mb-3 flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-wider text-subtle">
            <BookOpen className="size-3.5" /> Setup guide
          </h3>
          <Markdown text={guide} small />
          {kind === "slack" && <AgentMentionTip />}
        </aside>
      </div>
    </Drawer>
  );
}

function AgentMentionTip() {
  const agents = useApp((s) => s.agents) ?? [];
  if (agents.length < 2) return null;
  return (
    <div className="mt-5 rounded-lg border border-border bg-surface p-3 text-[12.5px] text-subtle">
      <p className="font-medium text-fg">Talk to any agent</p>
      <p className="mt-1">
        In Slack, start a message with an agent's handle to route it:{" "}
        {agents.slice(0, 3).map((a, i) => (
          <span key={a.id}>
            {i > 0 && ", "}
            <code className="rounded bg-surface-3 px-1 font-mono text-[11.5px]">@{a.handle}</code>
          </span>
        ))}
        .
      </p>
    </div>
  );
}
