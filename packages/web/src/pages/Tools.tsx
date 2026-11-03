import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Ellipsis, Eye, EyeOff, FlaskConical, Globe, Pencil, Plus, ShieldAlert, Terminal, Trash, Wrench, X } from "lucide-react";
import type { McpServer, McpServerInput, McpToolInfo, McpTransportKind } from "@soloagent/client";
import { client } from "../api/client.ts";
import { mcpLocal, useMcpServers } from "../api/mcp.ts";
import { useApp, useIsAdmin } from "../api/store.ts";
import { AgentAvatar } from "../components/brand.tsx";
import { Drawer, MenuItem, MenuSeparator, Popover } from "../components/overlay.tsx";
import { Badge, Button, Card, Dot, EmptyState, Field, IconButton, Input, Page, PageHeader, Segmented, Skeleton, Switch, Textarea } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { pluralize, relativeTime } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { confirm, toast } from "../lib/toast.ts";
import { AdminsOnly } from "./Team.tsx";

const SECRET_MASK = "••••••••";

type Preset = { label: string; hint: string; input: McpServerInput & { name: string; id: string; transport: McpTransportKind } };

const PRESETS: Preset[] = [
  {
    label: "GitHub",
    hint: "GitHub's official server, run with Docker",
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
    input: { name: "GitHub", id: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer " } },
  },
  {
    label: "Filesystem",
    hint: "Read and write files in one folder, via npx",
    input: { name: "Files", id: "files", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"] },
  },
];

export function Tools({ editId }: { editId?: string }) {
  const isAdmin = useIsAdmin();
  return isAdmin ? <ToolsPage editId={editId} /> : <AdminsOnly what="MCP servers" />;
}

function ToolsPage({ editId }: { editId?: string }) {
  const servers = useMcpServers();
  const editing = editId && editId !== "new" ? servers?.find((s) => s.id === editId) : undefined;
  const close = () => navigate("/tools");

  return (
    <Page>
      <PageHeader
        title="Tools"
        description="Connect Model Context Protocol (MCP) servers, like GitHub, Linear, Postgres, or Sentry, then choose which agents get their tools in each agent's settings."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/tools/new")}>
            Add MCP server
          </Button>
        }
      />

      {!servers ? (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Wrench />}
            title="No MCP servers yet"
            description="An MCP server gives agents new tools: open issues on GitHub, query a database, read error reports. Add one, then turn it on for an agent."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/tools/new")}>
                Add MCP server
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {servers.map((server) => (
            <ServerRow key={server.id} server={server} />
          ))}
        </div>
      )}

      {editId === "new" && <ServerEditor key="new" onClose={close} />}
      {editing && <ServerEditor key={editing.id} server={editing} onClose={close} />}
      {editId && editId !== "new" && servers && !editing && <Gone />}
    </Page>
  );
}

function Gone() {
  useEffect(() => navigate("/tools", { replace: true }), []);
  return null;
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
        <Badge tone="warning">
          <Dot tone="warning" pulse className="size-1.5 [&>span]:size-1.5" /> Connecting
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

function TransportTile({ transport, className }: { transport: McpTransportKind; className?: string }) {
  return (
    <div className={cn("grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 text-muted [&_svg]:size-[18px]", className)}>
      {transport === "http" ? <Globe /> : <Terminal />}
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
    <Card className={cn("p-4", server.enabled && server.status === "error" && "border-danger/30")}>
      <div className="flex items-start gap-3.5">
        <TransportTile transport={server.transport} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => navigate(`/tools/${server.id}`)} className="truncate text-[14px] font-semibold text-fg hover:underline">
              {server.name}
            </button>
            <McpStatus server={server} />
            <Badge>{server.transport === "http" ? "HTTP" : "stdio"}</Badge>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-x-2 text-[12.5px] text-subtle">
            <span className="shrink-0 font-mono text-[12px] text-muted">{server.id}</span>
            <span className="text-faint">·</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={commandLine(server)}>
              {commandLine(server)}
            </span>
          </div>
          {server.enabled && server.status === "error" && server.statusDetail && (
            <p className="mt-2 break-words rounded-md bg-danger-soft px-2.5 py-1.5 font-mono text-[11.5px] text-danger">{server.statusDetail}</p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-subtle">
            {server.tools.length > 0 ? (
              <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1 font-medium text-muted hover:text-fg">
                <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
                {pluralize(server.tools.length, "tool")}
              </button>
            ) : (
              <span className="text-faint">No tools listed yet</span>
            )}
            {server.deferred && <span title="Agents load these on demand with tool_search">loaded on demand</span>}
            <span className="flex items-center gap-1.5">
              {users.length === 0 ? (
                <span className="text-faint">Not used by any agent</span>
              ) : (
                <>
                  <span className="flex -space-x-1">
                    {users.slice(0, 5).map((a) => (
                      <AgentAvatar key={a.id} agent={a} size="xs" className="ring-2 ring-surface" />
                    ))}
                  </span>
                  used by {users.length === 1 ? users[0]!.name : `${users.length} agents`}
                </>
              )}
            </span>
          </div>
          {open && <ToolList tools={server.tools} className="mt-3" />}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
    </Card>
  );
}

function ToolList({ tools, className }: { tools: McpToolInfo[]; className?: string }) {
  return (
    <ul className={cn("divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-2/30", className)}>
      {tools.map((tool) => (
        <li key={tool.toolName} className="px-3 py-2">
          <div className="flex items-baseline gap-2">
            <code className="font-mono text-[12px] font-medium text-fg">{tool.name}</code>
            {tool.title && tool.title !== tool.name && <span className="truncate text-[12px] text-subtle">{tool.title}</span>}
          </div>
          {tool.description && <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-subtle">{tool.description}</p>}
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

function ServerEditor({ server, onClose }: { server?: McpServer; onClose: () => void }) {
  const servers = useMcpServers() ?? [];
  const users = useUsers(server?.id ?? "");
  const [name, setName] = useState(server?.name ?? "");
  const [id, setId] = useState(server?.id ?? "");
  const [idTouched, setIdTouched] = useState(!!server);
  const [transport, setTransport] = useState<McpTransportKind>(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState((server?.args ?? []).join("\n"));
  const [env, setEnv] = useState<Pair[]>(toPairs(server?.env));
  const [url, setUrl] = useState(server?.url ?? "");
  const [headers, setHeaders] = useState<Pair[]>(toPairs(server?.headers));
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

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

  const applyPreset = (preset: Preset) => {
    const taken = servers.some((s) => s.id === preset.input.id);
    setName(preset.input.name);
    setId(taken ? `${preset.input.id}-2` : preset.input.id);
    setIdTouched(true);
    setTransport(preset.input.transport);
    setCommand(preset.input.command ?? "");
    setArgs((preset.input.args ?? []).join("\n"));
    setEnv(toPairs(preset.input.env));
    setUrl(preset.input.url ?? "");
    setHeaders(toPairs(preset.input.headers));
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
              icon={<Trash className="size-4" />}
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
          className="flex flex-col gap-5 px-5 py-6"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!server && (
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-fg">Start from</span>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    title={preset.hint}
                    onClick={() => applyPreset(preset)}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-fg"
                  >
                    {preset.input.transport === "http" ? <Globe className="size-3.5" /> : <Terminal className="size-3.5" />}
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

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
              hint={server ? "Can't be changed." : <>Tools are named <span className="font-mono">mcp__{id || "id"}__…</span></>}
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

          <Field label="Transport">
            <Segmented
              value={transport}
              onChange={setTransport}
              className="w-full max-w-sm"
              options={[
                { value: "stdio", label: <><Terminal className="size-3.5" /> Command (stdio)</> },
                { value: "http", label: <><Globe className="size-3.5" /> Remote (HTTP)</> },
              ]}
            />
          </Field>

          {transport === "stdio" ? (
            <>
              <Field label="Command" htmlFor="mcp-command" error={command ? null : undefined} hint="The program to run, e.g. npx, uvx, docker, or a path. Paste a whole command line to split it.">
                <Input
                  id="mcp-command"
                  value={command}
                  spellCheck={false}
                  placeholder="npx"
                  className="font-mono text-[12.5px]"
                  onChange={(e) => setCommand(e.target.value)}
                  onBlur={() => {
                    if (!/\s/.test(command.trim()) || args.trim()) return;
                    const [first, ...rest] = splitCommand(command.trim());
                    setCommand(first ?? "");
                    setArgs(rest.join("\n"));
                  }}
                />
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

          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
            <div>
              <span className="text-[13.5px] font-medium text-fg">Enabled</span>
              <p className="text-[12.5px] text-subtle">Turn off to disconnect without losing settings.</p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
          </label>
          <button type="submit" hidden />
        </form>

        <aside className="flex flex-col gap-5 border-t border-border bg-surface-2/30 px-5 py-6 lg:border-l lg:border-t-0">
          {server ? (
            <>
              <div className={cn("rounded-xl border p-3.5", server.enabled && server.status === "error" ? "border-danger/30 bg-danger-soft" : "border-border bg-surface")}>
                <div className="flex items-center gap-2">
                  <McpStatus server={server} />
                  {server.serverInfo && <span className="min-w-0 truncate font-mono text-[12px] text-muted">{server.serverInfo}</span>}
                  <Button size="xs" variant="secondary" className="ml-auto" loading={testing} icon={<FlaskConical className="size-3" />} onClick={test}>
                    Test
                  </Button>
                </div>
                {server.statusDetail && (
                  <p className={cn("mt-2 break-words text-[12px]", server.status === "error" ? "font-mono text-danger" : "text-subtle")}>{server.statusDetail}</p>
                )}
                {server.status === "connected" && server.connectedAt && <p className="mt-2 text-[12px] text-subtle">Connected {relativeTime(server.connectedAt)}.</p>}
              </div>

              <div>
                <h3 className="mb-2 flex items-baseline justify-between text-[11.5px] font-semibold uppercase tracking-wider text-subtle">
                  Tools
                  <span className="font-normal normal-case tracking-normal text-faint">{pluralize(server.tools.length, "tool")}</span>
                </h3>
                {server.deferred && (
                  <p className="mb-2 text-[12px] text-subtle">
                    More than 15 tools: agents get a <span className="font-mono">tool_search</span> tool and load the ones they need.
                  </p>
                )}
                {server.tools.length ? (
                  <ToolList tools={server.tools} />
                ) : (
                  <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12.5px] text-subtle">Tools appear here once the server connects. Press Test to list them now.</p>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-subtle">Agents</h3>
                {users.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {users.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => navigate(`/agents/${a.id}`)}
                        className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[12.5px] text-fg hover:border-border-strong"
                      >
                        <AgentAvatar agent={a} size="xs" />
                        {a.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12.5px] text-subtle">No agent uses this server yet. Turn it on under "Tools from MCP servers" in an agent's settings.</p>
                )}
              </div>
            </>
          ) : (
            <div className="text-[12.5px] leading-relaxed text-subtle">
              <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-subtle">How it works</h3>
              <p>soloagent connects to the server, lists its tools, and keeps the connection open, reconnecting if it drops. Agents you give it to can call its tools by name.</p>
              <p className="mt-2">Servers with more than 15 tools are loaded on demand, so they don't crowd the model's context.</p>
            </div>
          )}

          {transport === "stdio" && (
            <div className="flex gap-2.5 rounded-xl border border-warning/25 bg-warning-soft p-3.5 text-[12.5px] leading-relaxed text-warning">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <p>
                A stdio server runs on this machine as the same user as soloagent. It gets PATH, HOME, locale, and proxy settings plus the variables above, never soloagent's own secrets. Only add servers you trust.
              </p>
            </div>
          )}
        </aside>
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
        <Button size="sm" variant="ghost" className="self-start" icon={<Plus className="size-3.5" />} onClick={() => onChange([...pairs, { key: "", value: "" }])}>
          {addLabel}
        </Button>
      </div>
    </Field>
  );
}
