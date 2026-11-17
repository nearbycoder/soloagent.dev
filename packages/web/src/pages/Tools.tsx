import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Check, ChevronDown, Container, Ellipsis, Eye, EyeOff, FlaskConical, GitPullRequest, Globe, HardDrive, Pencil, Plus, ShieldAlert, Terminal, Trash, Wrench, X } from "lucide-react";
import type { McpServer, McpServerInput, McpToolInfo, McpTransportKind } from "@soloagent/client";
import { client } from "../api/client.ts";
import { mcpLocal, useMcpServers } from "../api/mcp.ts";
import { useApp, useIsAdmin } from "../api/store.ts";
import { AgentAvatar } from "../components/brand.tsx";
import { Drawer, MenuItem, MenuSeparator, Popover } from "../components/overlay.tsx";
import { Badge, Button, Card, Dot, EmptyState, Field, IconButton, Input, Page, PageHeader, Segmented, Skeleton, Switch, Textarea } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { num, pluralize, relativeTime } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { confirm, toast } from "../lib/toast.ts";
import { AdminsOnly } from "./Team.tsx";

const SECRET_MASK = "••••••••";

type Preset = { label: string; hint: string; icon: React.ReactNode; input: McpServerInput & { name: string; id: string; transport: McpTransportKind } };

const PRESETS: Preset[] = [
  {
    label: "GitHub",
    hint: "Official server, run with Docker",
    icon: <Container />,
    input: {
      name: "GitHub",
      id: "github",
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    },
  },
  {
    label: "GitHub (remote)",
    hint: "GitHub's hosted server over HTTP",
    icon: <GitPullRequest />,
    input: { name: "GitHub", id: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer " } },
  },
  {
    label: "Filesystem",
    hint: "Read and write one folder, via npx",
    icon: <HardDrive />,
    input: { name: "Files", id: "files", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"] },
  },
];

export function Tools({ editId }: { editId?: string }) {
  const isAdmin = useIsAdmin();
  return isAdmin ? <ToolsPage editId={editId} /> : <AdminsOnly what="MCP servers" />;
}

function ToolsPage({ editId }: { editId?: string }) {
  const servers = useMcpServers();
  const [preset, setPreset] = useState<Preset | null>(null);
  const editing = editId && editId !== "new" ? servers?.find((s) => s.id === editId) : undefined;
  const close = () => {
    setPreset(null);
    navigate("/tools");
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Configure"
        title="Tools"
        description="Connect Model Context Protocol (MCP) servers, like GitHub, Linear, Postgres, or Sentry, then choose which agents get their tools in each agent's settings."
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => navigate("/tools/new")}>
            Add MCP server
          </Button>
        }
      />

      {!servers ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[74px] rounded-xl" />
          <Skeleton className="h-[260px] rounded-xl" />
        </div>
      ) : servers.length === 0 ? (
        <Card className="overflow-hidden">
          <EmptyState
            icon={<Wrench />}
            title="No MCP servers yet"
            description="An MCP server gives agents new tools: open issues on GitHub, query a database, read error reports. Add one, then turn it on for an agent."
            action={
              <Button variant="primary" icon={<Plus />} onClick={() => navigate("/tools/new")}>
                Add MCP server
              </Button>
            }
          />
          <div className="grid border-t border-border sm:grid-cols-3 sm:divide-x sm:divide-border">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setPreset(p);
                  navigate("/tools/new");
                }}
                className="group flex items-center gap-3 border-t border-border px-5 py-4 text-left transition-colors first:border-t-0 hover:bg-surface-2/50 sm:border-t-0"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-muted transition-colors group-hover:text-fg [&_svg]:size-4">
                  {p.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-fg">{p.label}</span>
                  <span className="block truncate text-[12px] text-subtle">{p.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </Card>
      ) : (
        <>
          <Overview servers={servers} />
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {servers.map((server) => (
                <ServerRow key={server.id} server={server} />
              ))}
            </ul>
          </Card>
        </>
      )}

      {editId === "new" && <ServerEditor key={`new-${preset?.label ?? ""}`} preset={preset ?? undefined} onClose={close} />}
      {editing && <ServerEditor key={editing.id} server={editing} onClose={close} />}
      {editId && editId !== "new" && servers && !editing && <Gone />}
    </Page>
  );
}

function Gone() {
  useEffect(() => navigate("/tools", { replace: true }), []);
  return null;
}

/** What agents can reach right now: live tools, connected servers, and agents that use any of them. */
function Overview({ servers }: { servers: McpServer[] }) {
  const agents = useApp((s) => s.agents);
  const live = servers.filter((s) => s.enabled && s.status === "connected");
  const tools = live.reduce((n, s) => n + s.tools.length, 0);
  const users = (agents ?? []).filter((a) => a.mcpServers?.some((id) => servers.some((s) => s.id === id))).length;
  const failing = servers.filter((s) => s.enabled && s.status === "error").length;
  const stats = [
    { label: "Tools available", value: num(tools), sub: live.length ? `from ${pluralize(live.length, "connected server")}` : "no server connected", accent: tools > 0 },
    { label: "Servers", value: `${live.length}/${servers.length}`, sub: failing ? `${failing} failing` : "connected", danger: failing > 0 },
    { label: "Agents with tools", value: num(users), sub: users ? "use at least one server" : "turn a server on in an agent" },
  ];
  return (
    <div className="mb-4 grid grid-cols-1 overflow-hidden rounded-xl border border-border bg-surface shadow-card sm:grid-cols-3 sm:divide-x sm:divide-border">
      {stats.map((s, i) => (
        <div key={s.label} className={cn("flex items-baseline justify-between gap-3 px-5 py-3.5 sm:block", i > 0 && "border-t border-border sm:border-t-0")}>
          <p className="label-mono text-faint">{s.label}</p>
          <p className="flex items-baseline gap-2 sm:mt-1.5">
            <span className="font-mono text-[20px] font-medium tabular-nums tracking-tight text-fg">{s.value}</span>
            {s.accent && <span className="size-1.5 rounded-full bg-accent-line shadow-[0_0_8px_var(--accent-glow)]" aria-hidden />}
            <span className={cn("text-[12px]", s.danger ? "text-danger" : "text-subtle")}>{s.sub}</span>
          </p>
        </div>
      ))}
    </div>
  );
}

export function McpStatus({ server }: { server: McpServer }) {
  if (!server.enabled) return <Badge>Disabled</Badge>;
  switch (server.status) {
    case "connected":
      return (
        <Badge tone="success">
          <Dot tone="success" className="size-1.5 [&>span]:size-1.5" /> Connected
        </Badge>
      );
    case "connecting":
      return (
        <Badge tone="accent">
          <Dot tone="accent" pulse className="size-1.5 [&>span]:size-1.5" /> Connecting
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

/** The transport's glyph on a tile; a live server gets a small status dot in the corner. */
function TransportTile({ transport, status, className }: { transport: McpTransportKind; status?: "live" | "error" | "off"; className?: string }) {
  return (
    <div className={cn("relative grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-gradient-to-b from-surface-2 to-surface text-muted shadow-xs [&_svg]:size-[18px]", className)}>
      {transport === "http" ? <Globe /> : <Terminal />}
      {status && status !== "off" && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[var(--surface)]",
            status === "live" ? "bg-success" : "bg-danger",
          )}
        />
      )}
    </div>
  );
}

function commandLine(server: Pick<McpServer, "transport" | "command" | "args" | "url">): string {
  if (server.transport === "http") return server.url;
  return [server.command, ...server.args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))].join(" ");
}

function useUsers(serverId: string) {
  const agents = useApp((s) => s.agents);
  return useMemo(() => (agents ?? []).filter((a) => a.mcpServers?.includes(serverId)), [agents, serverId]);
}

function ServerRow({ server }: { server: McpServer }) {
  const users = useUsers(server.id);
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const failing = server.enabled && server.status === "error";

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      mcpLocal.server(await client.updateMcpServer(server.id, { enabled }));
    } catch (error) {
      toast.error(error, "Could not update the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="group relative py-4 transition-colors hover:bg-surface-2/40">
      <div className="flex items-start gap-4 px-4 sm:px-5">
        <TransportTile transport={server.transport} status={!server.enabled ? "off" : server.status === "connected" ? "live" : failing ? "error" : undefined} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* The name opens the editor; its overlay makes the whole row a target. */}
            <button
              type="button"
              onClick={() => navigate(`/tools/${server.id}`)}
              className="truncate text-left text-[14.5px] font-semibold tracking-[-0.01em] text-fg outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-[var(--ring)]"
            >
              {server.name}
            </button>
            <McpStatus server={server} />
            <span className="rounded-md border border-border px-1.5 font-mono text-[10.5px] uppercase leading-[18px] tracking-wider text-faint">{server.transport}</span>
          </div>
          <p className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[12px]">
            <span className="shrink-0 text-muted">{server.id}</span>
            <span className="shrink-0 text-faint">{server.transport === "http" ? "→" : "$"}</span>
            <span className="min-w-0 truncate text-subtle" title={commandLine(server)}>
              {commandLine(server)}
            </span>
          </p>
          {failing && server.statusDetail && (
            <p className="mt-2.5 break-words rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 font-mono text-[11.5px] leading-relaxed text-danger">{server.statusDetail}</p>
          )}
          <div className="relative z-10 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-subtle">
            {server.tools.length > 0 ? (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-lg border px-2.5 font-medium transition-colors",
                  open ? "border-border-strong bg-surface-2 text-fg" : "border-border bg-surface text-muted hover:border-border-strong hover:text-fg",
                )}
              >
                <Wrench className="size-3.5 text-faint" aria-hidden />
                {pluralize(server.tools.length, "tool")}
                <ChevronDown className={cn("size-3.5 text-faint transition-transform", open && "rotate-180")} aria-hidden />
              </button>
            ) : (
              <span className="text-faint">No tools listed yet</span>
            )}
            {server.deferred && (
              <span className="font-mono text-[11.5px] text-faint" title="Agents load these on demand with tool_search">
                loaded on demand
              </span>
            )}
            <span className="flex items-center gap-1.5">
              {users.length === 0 ? (
                <span className="text-faint">Not used by any agent</span>
              ) : (
                <>
                  <span className="flex -space-x-1">
                    {users.slice(0, 5).map((a) => (
                      <AgentAvatar key={a.id} agent={a} size="xs" className="ring-2 ring-[var(--surface)]" />
                    ))}
                  </span>
                  <span>
                    used by <span className="text-muted">{users.length === 1 ? users[0]!.name : `${users.length} agents`}</span>
                  </span>
                </>
              )}
            </span>
          </div>
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          <Switch checked={server.enabled} onChange={toggle} disabled={busy} label={server.enabled ? "Disable server" : "Enable server"} size="sm" />
          <IconButton ref={anchor} label="Server actions" onClick={() => setMenu((m) => !m)} active={menu}>
            <Ellipsis className="size-4" />
          </IconButton>
          <Popover open={menu} onClose={() => setMenu(false)} anchor={anchor} align="end" className="w-48">
            <MenuItem
              icon={<Pencil />}
              onClick={() => {
                setMenu(false);
                navigate(`/tools/${server.id}`);
              }}
            >
              Edit
            </MenuItem>
            <MenuItem
              icon={<FlaskConical />}
              onClick={async () => {
                setMenu(false);
                await testServer(server);
                setOpen(true);
              }}
            >
              Test
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash />}
              onClick={async () => {
                setMenu(false);
                await removeServer(server);
              }}
            >
              Delete
            </MenuItem>
          </Popover>
        </div>
      </div>
      {open && <ToolList tools={server.tools} className="relative z-10 mt-3 px-4 sm:grid-cols-2 sm:pl-[76px] sm:pr-5" />}
    </li>
  );
}

/** Each tool: its name on the server, what it does, and the name agents call it by. */
function ToolList({ tools, className }: { tools: McpToolInfo[]; className?: string }) {
  return (
    <ul className={cn("grid gap-2", className)}>
      {tools.map((tool) => (
        <li key={tool.toolName} className="min-w-0 rounded-lg border border-border bg-surface-2/40 px-3 py-2.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <code className="shrink-0 font-mono text-[12.5px] font-medium text-fg">{tool.name}</code>
            {tool.title && tool.title !== tool.name && <span className="truncate text-[12px] text-subtle">{tool.title}</span>}
          </div>
          {tool.description && <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-subtle">{tool.description}</p>}
          <p className="mt-1.5 truncate font-mono text-[10.5px] text-faint" title="The name agents call it by">
            {tool.toolName}
          </p>
        </li>
      ))}
    </ul>
  );
}

async function testServer(server: McpServer) {
  try {
    const result = await client.testMcpServer(server.id);
    mcpLocal.server(result.server);
    if (result.ok) toast.success(`${server.name} works`, `${pluralize(result.tools.length, "tool")} available.`);
    else toast.error(result.error ?? "Could not connect", `${server.name} failed`);
    return result;
  } catch (error) {
    toast.error(error, "Test failed");
    return undefined;
  }
}

async function removeServer(server: McpServer): Promise<boolean> {
  const ok = await confirm({
    title: `Delete ${server.name}?`,
    body: "Agents lose its tools right away. You can add it again later.",
    confirmLabel: "Delete",
    tone: "danger",
  });
  if (!ok) return false;
  try {
    await client.deleteMcpServer(server.id);
    mcpLocal.deleted(server.id);
    toast.success(`${server.name} deleted`);
    return true;
  } catch (error) {
    toast.error(error, "Could not delete");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Editor

type Pair = { key: string; value: string };
const toPairs = (record: Record<string, string> | undefined): Pair[] => Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
const toRecord = (pairs: Pair[]): Record<string, string> => Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));

/** Split a pasted command line into words, honoring simple quotes. */
function splitCommand(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) words.push(match[1]?.replace(/\\(.)/g, "$1") ?? match[2] ?? match[3]!);
  return words;
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const toId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");

/** A titled group of fields, separated from the one above by a rule. */
function FormSection({ label, children, first, aside }: { label: string; children: React.ReactNode; first?: boolean; aside?: React.ReactNode }) {
  return (
    <section className={cn("flex flex-col gap-4", !first && "border-t border-border pt-6")}>
      <div className="flex items-center justify-between gap-3">
        <p className="label-mono text-faint">{label}</p>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ServerEditor({ server, preset: initial, onClose }: { server?: McpServer; preset?: Preset; onClose: () => void }) {
  const servers = useMcpServers() ?? [];
  const users = useUsers(server?.id ?? "");
  // A preset picked on the page fills the form; its id gets a suffix when taken.
  const start = server ?? (initial ? { ...initial.input, id: servers.some((s) => s.id === initial.input.id) ? `${initial.input.id}-2` : initial.input.id } : undefined);
  const [name, setName] = useState(start?.name ?? "");
  const [id, setId] = useState(start?.id ?? "");
  const [idTouched, setIdTouched] = useState(!!start);
  const [transport, setTransport] = useState<McpTransportKind>(start?.transport ?? "stdio");
  const [command, setCommand] = useState(start?.command ?? "");
  const [args, setArgs] = useState((start?.args ?? []).join("\n"));
  const [env, setEnv] = useState<Pair[]>(toPairs(start?.env));
  const [url, setUrl] = useState(start?.url ?? "");
  const [headers, setHeaders] = useState<Pair[]>(toPairs(start?.headers));
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [preset, setPreset] = useState<string | null>(initial?.label ?? null);

  const idError = server
    ? null
    : !id
      ? "Required"
      : !ID_PATTERN.test(id) || id.includes("--")
        ? "Lowercase letters, digits, and single dashes"
        : servers.some((s) => s.id === id)
          ? "Another server already uses this id"
          : null;
  const targetError =
    transport === "stdio" ? (command.trim() ? null : "Required") : /^https?:\/\/\S+$/.test(url.trim()) ? null : "A full http(s) URL, e.g. https://mcp.example.com/mcp";
  const invalid = !!idError || !!targetError;

  const applyPreset = (p: Preset) => {
    const taken = servers.some((s) => s.id === p.input.id);
    setPreset(p.label);
    setName(p.input.name);
    setId(taken ? `${p.input.id}-2` : p.input.id);
    setIdTouched(true);
    setTransport(p.input.transport);
    setCommand(p.input.command ?? "");
    setArgs((p.input.args ?? []).join("\n"));
    setEnv(toPairs(p.input.env));
    setUrl(p.input.url ?? "");
    setHeaders(toPairs(p.input.headers));
  };

  const input = (): McpServerInput => ({
    name: name.trim() || id,
    transport,
    ...(transport === "stdio"
      ? {
          command: command.trim(),
          args: args
            .split("\n")
            .map((a) => a.trim())
            .filter(Boolean),
          env: toRecord(env),
        }
      : { url: url.trim(), headers: toRecord(headers) }),
    enabled,
  });

  const save = async () => {
    if (invalid) return;
    setSaving(true);
    try {
      if (server) {
        mcpLocal.server(await client.updateMcpServer(server.id, input()));
        toast.success("Server saved", enabled ? "Reconnecting with the new settings." : undefined);
        onClose();
      } else {
        const created = await client.createMcpServer({ ...input(), id });
        mcpLocal.server(created);
        toast.success(`${created.name} added`, "Watch it connect, then turn it on for an agent.");
        navigate(`/tools/${created.id}`, { replace: true });
      }
    } catch (error) {
      toast.error(error, "Could not save the server");
      setSaving(false);
    }
  };

  const test = async () => {
    if (!server) return;
    setTesting(true);
    await testServer(server);
    setTesting(false);
  };

  const failing = !!server && server.enabled && server.status === "error";

  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-4xl"
      icon={<TransportTile transport={transport} className="size-8 rounded-lg [&_svg]:size-4" />}
      title={server ? server.name : "Add an MCP server"}
      description={server ? `${server.id} · added ${relativeTime(server.createdAt)}` : "Run a local server over stdio, or connect to a remote one over HTTP."}
      footer={
        <>
          {server && (
            <Button
              variant="ghost"
              className="text-danger hover:bg-danger-soft hover:text-danger"
              icon={<Trash />}
              onClick={async () => {
                if (await removeServer(server)) onClose();
              }}
            >
              Delete
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {server ? "Close" : "Cancel"}
            </Button>
            <Button variant="primary" loading={saving} disabled={invalid} onClick={save}>
              {server ? "Save changes" : "Add server"}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid min-h-full lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <form
          className="flex flex-col gap-6 px-5 py-6 sm:px-6"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!server && (
            <FormSection label="Start from" first>
              <div className="overflow-hidden rounded-xl border border-border">
                {PRESETS.map((p) => {
                  const active = preset === p.label;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => applyPreset(p)}
                      aria-pressed={active}
                      className={cn(
                        "group flex w-full items-center gap-3 border-t border-border px-3 py-2.5 text-left transition-colors first:border-t-0",
                        active ? "bg-surface-2" : "hover:bg-surface-2/50",
                      )}
                    >
                      <span className={cn("grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface [&_svg]:size-3.5", active ? "text-fg" : "text-muted group-hover:text-fg")}>
                        {p.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{p.label}</span>
                      <span className="hidden min-w-0 truncate text-[12px] text-subtle sm:block">{p.hint}</span>
                      {active && <Check className="size-3.5 shrink-0 text-fg" />}
                    </button>
                  );
                })}
              </div>
            </FormSection>
          )}

          <FormSection label="Server" first={!!server}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="mcp-name">
                <Input
                  id="mcp-name"
                  data-autofocus
                  value={name}
                  placeholder="Linear"
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!idTouched) setId(toId(e.target.value));
                  }}
                />
              </Field>
              <Field
                label="ID"
                htmlFor="mcp-id"
                error={server ? null : id ? idError : null}
                hint={
                  server ? (
                    "Can't be changed."
                  ) : (
                    <>
                      Tools are named <span className="font-mono text-muted">mcp__{id || "id"}__…</span>
                    </>
                  )
                }
              >
                <Input
                  id="mcp-id"
                  value={id}
                  disabled={!!server}
                  invalid={!server && !!id && !!idError}
                  placeholder="linear"
                  className="font-mono"
                  onChange={(e) => {
                    setIdTouched(true);
                    setId(e.target.value.toLowerCase().replace(/\s+/g, "-"));
                  }}
                />
              </Field>
            </div>
          </FormSection>

          <FormSection
            label="Connection"
            aside={
              <Segmented
                size="sm"
                value={transport}
                onChange={setTransport}
                className="shrink-0 [&_button]:whitespace-nowrap"
                options={[
                  {
                    value: "stdio",
                    label: (
                      <>
                        <Terminal /> Command (stdio)
                      </>
                    ),
                  },
                  {
                    value: "http",
                    label: (
                      <>
                        <Globe /> Remote (HTTP)
                      </>
                    ),
                  },
                ]}
              />
            }
          >
            {transport === "stdio" ? (
              <>
                <Field label="Command" htmlFor="mcp-command" hint="The program to run, e.g. npx, uvx, docker, or a path. Paste a whole command line to split it.">
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12.5px] text-faint">$</span>
                    <Input
                      id="mcp-command"
                      value={command}
                      spellCheck={false}
                      placeholder="npx"
                      className="pl-7 font-mono text-[12.5px]"
                      onChange={(e) => setCommand(e.target.value)}
                      onBlur={() => {
                        if (!/\s/.test(command.trim()) || args.trim()) return;
                        const [first, ...rest] = splitCommand(command.trim());
                        setCommand(first ?? "");
                        setArgs(rest.join("\n"));
                      }}
                    />
                  </div>
                </Field>
                <Field label="Arguments" htmlFor="mcp-args" hint="One per line.">
                  <Textarea
                    id="mcp-args"
                    value={args}
                    rows={3}
                    spellCheck={false}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/srv/shared"}
                    className="font-mono text-[12.5px]"
                    onChange={(e) => setArgs(e.target.value)}
                  />
                </Field>
                <PairsField
                  label="Environment variables"
                  hint="Encrypted at rest and never shown again. Use them for tokens."
                  pairs={env}
                  onChange={setEnv}
                  keyPlaceholder="GITHUB_PERSONAL_ACCESS_TOKEN"
                  addLabel="Add variable"
                />
              </>
            ) : (
              <>
                <Field label="URL" htmlFor="mcp-url" error={url && targetError ? targetError : null} hint="The server's Streamable HTTP endpoint.">
                  <Input
                    id="mcp-url"
                    value={url}
                    spellCheck={false}
                    placeholder="https://mcp.example.com/mcp"
                    className="font-mono text-[12.5px]"
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </Field>
                <PairsField
                  label="Headers"
                  hint="Encrypted at rest and never shown again. Usually an Authorization header with a token."
                  pairs={headers}
                  onChange={setHeaders}
                  keyPlaceholder="Authorization"
                  valuePlaceholder="Bearer …"
                  addLabel="Add header"
                />
              </>
            )}
          </FormSection>

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/40 px-4 py-3">
            <div>
              <span className="text-[13.5px] font-medium text-fg">Enabled</span>
              <p className="text-[12.5px] text-subtle">Turn off to disconnect without losing settings.</p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
          </label>
          <button type="submit" hidden />
        </form>

        <div className="flex flex-col gap-6 border-t border-border bg-surface/50 px-5 py-6 sm:px-6 lg:border-l lg:border-t-0">
          {server ? (
            <>
              <div className={cn("rounded-xl border px-4 py-3.5", failing ? "border-danger/30 bg-danger-soft" : "border-border bg-surface shadow-card")}>
                <div className="flex items-center gap-2">
                  <McpStatus server={server} />
                  {server.serverInfo && <span className="min-w-0 truncate font-mono text-[11.5px] text-muted">{server.serverInfo}</span>}
                  <Button size="xs" variant="secondary" className="ml-auto" loading={testing} icon={<FlaskConical />} onClick={test}>
                    Test
                  </Button>
                </div>
                {server.statusDetail && (
                  <p className={cn("mt-2.5 break-words text-[12px] leading-relaxed", server.status === "error" ? "font-mono text-danger" : "text-subtle")}>{server.statusDetail}</p>
                )}
                {server.status === "connected" && server.connectedAt && (
                  <p className="mt-2 font-mono text-[11.5px] text-faint">connected {relativeTime(server.connectedAt)}</p>
                )}
              </div>

              <div>
                <h3 className="mb-3 flex items-baseline justify-between gap-3 text-[13px] font-semibold text-fg">
                  Tools
                  <span className="font-mono text-[11.5px] font-normal text-faint">{pluralize(server.tools.length, "tool")}</span>
                </h3>
                {server.deferred && (
                  <p className="mb-3 rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-[12px] leading-relaxed text-subtle">
                    More than 15 tools: agents get a <span className="font-mono text-muted">tool_search</span> tool and load the ones they need.
                  </p>
                )}
                {server.tools.length ? (
                  <ToolList tools={server.tools} />
                ) : (
                  <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-[12.5px] text-subtle">Tools appear here once the server connects. Press Test to list them now.</p>
                )}
              </div>

              <div>
                <h3 className="mb-3 text-[13px] font-semibold text-fg">Agents</h3>
                {users.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {users.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => navigate(`/agents/${a.id}`)}
                        className="flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[12.5px] text-fg shadow-xs transition-colors hover:border-border-strong hover:bg-surface-2"
                      >
                        <AgentAvatar agent={a} size="xs" />
                        {a.name}
                        <span className="font-mono text-[11px] text-faint">@{a.handle}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12.5px] leading-relaxed text-subtle">No agent uses this server yet. Turn it on under "Tools from MCP servers" in an agent's settings.</p>
                )}
              </div>
            </>
          ) : (
            <div>
              <p className="label-mono mb-4 text-faint">How it works</p>
              <ol className="flex flex-col">
                {[
                  { icon: <Terminal />, text: <>soloagent starts the server (stdio) or connects to it (HTTP), and keeps the connection open, reconnecting if it drops.</> },
                  { icon: <Wrench />, text: <>It lists the server's tools. Agents you give the server to call them by name.</> },
                  {
                    icon: <Boxes />,
                    text: (
                      <>
                        Each tool is named <span className="font-mono text-muted">mcp__{id || "id"}__tool</span>. More than 15 tools load on demand, so they don't crowd the model's context.
                      </>
                    ),
                  },
                ].map((step, i, all) => (
                  <li key={i} className="relative flex gap-3 pb-5 last:pb-0">
                    {i < all.length - 1 && <span aria-hidden className="absolute left-[13px] top-8 h-[calc(100%-28px)] w-px bg-border" />}
                    <span className="grid size-[27px] shrink-0 place-items-center rounded-lg border border-border bg-surface text-subtle shadow-xs [&_svg]:size-3.5">{step.icon}</span>
                    <p className="pt-1 text-[12.5px] leading-relaxed text-subtle">{step.text}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {transport === "stdio" && (
            <div className="flex gap-2.5 rounded-xl border border-warning/25 bg-warning-soft p-3.5 text-[12.5px] leading-relaxed text-warning">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <p>
                A stdio server runs on this machine as the same user as soloagent. It gets PATH, HOME, locale, and proxy settings plus the variables above, never soloagent's own secrets. Only add
                servers you trust.
              </p>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

function PairsField({
  label,
  hint,
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder = "value",
  addLabel,
}: {
  label: string;
  hint: string;
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder?: string;
  addLabel: string;
}) {
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const update = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const saved = pairs.some((p) => p.value === SECRET_MASK);
  return (
    <Field label={label} hint={saved ? "Saved values show as dots: leave them to keep them, or type a new value. Encrypted at rest." : hint}>
      <div className="flex flex-col gap-2">
        {pairs.map((pair, i) => {
          const masked = pair.value === SECRET_MASK;
          return (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={`${label} name`}
                value={pair.key}
                spellCheck={false}
                placeholder={keyPlaceholder}
                className="h-8 min-w-0 flex-[1_1_45%] font-mono text-[12px]"
                onChange={(e) => update(i, { key: e.target.value })}
              />
              <div className="relative min-w-0 flex-[1_1_55%]">
                <Input
                  aria-label={`${label} value`}
                  type={reveal[i] && !masked ? "text" : "password"}
                  value={pair.value}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={valuePlaceholder}
                  className="h-8 pr-9 font-mono text-[12px]"
                  onFocus={(e) => masked && e.target.select()}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
                {!masked && pair.value && (
                  <button
                    type="button"
                    onClick={() => setReveal((r) => ({ ...r, [i]: !r[i] }))}
                    aria-label={reveal[i] ? "Hide value" : "Show value"}
                    className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-subtle hover:text-fg"
                  >
                    {reveal[i] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                )}
              </div>
              <IconButton label="Remove" size="sm" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          );
        })}
        <Button size="sm" variant="ghost" className="self-start" icon={<Plus />} onClick={() => onChange([...pairs, { key: "", value: "" }])}>
          {addLabel}
        </Button>
      </div>
    </Field>
  );
}
