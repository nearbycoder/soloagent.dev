import { useEffect, useState } from "react";
import { ArrowUpRight, Ban, Check, Clock, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { Approval, ApprovalSettings } from "@soloagent/client";
import { client } from "../api/client.ts";
import { useAgentMap, useApp, useIsAdmin } from "../api/store.ts";
import { ApprovalActions, approvalArgs, approvalStatusText } from "../components/ApprovalActions.tsx";
import { AgentAvatar, SourceBadge } from "../components/brand.tsx";
import { Badge, Button, Card, CopyButton, EmptyState, Field, Input, Page, PageHeader, SectionHeader, Skeleton } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { fullDate, relativeTime, shortTime } from "../lib/format.ts";
import { linkHandler } from "../lib/router.ts";
import { toast } from "../lib/toast.ts";

export function ApprovalsPage() {
  const pending = useApp((s) => s.approvals);
  const version = useApp((s) => s.approvalsVersion);
  const isAdmin = useIsAdmin();
  const [recent, setRecent] = useState<Approval[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .approvals({ status: "decided", limit: 30 })
      .then((list) => !cancelled && setRecent(list))
      .catch(() => !cancelled && setRecent([]));
    return () => {
      cancelled = true;
    };
  }, [version]);

  return (
    <Page narrow>
      <PageHeader
        eyebrow="Human in the loop"
        title="Approvals"
        description="Tool calls that wait for a person before they run. Approve or deny here, in the thread, or with the buttons in Slack, Discord, and Telegram."
      />

      <section>
        <div className="mb-3 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Waiting</h2>
              {pending && pending.length > 0 && (
                <Badge tone="warning" dot>
                  {pending.length}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-[13px] text-subtle">Paused runs pick up the moment you decide. The wait survives restarts.</p>
          </div>
        </div>
        {pending === null ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : pending.length === 0 ? (
          <Card>
            <EmptyState
              icon={<ShieldCheck />}
              title="Nothing is waiting"
              description="Agents with approvals on pause here before risky tools such as bash, write, and edit. Set the policy per agent in Agents."
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {pending.map((approval, i) => (
              <ApprovalCard key={approval.id} approval={approval} index={i} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-12">
        <SectionHeader title="Recently decided" description="The last 30 decisions, newest first." />
        {recent === null ? (
          <Skeleton className="h-28 rounded-xl" />
        ) : recent.length === 0 ? (
          <Card className="px-5 py-6">
            <p className="text-[13px] text-subtle">No decisions yet. Approved, denied, and expired requests show up here.</p>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {recent.map((approval) => (
                <DecidedRow key={approval.id} approval={approval} />
              ))}
            </ul>
          </Card>
        )}
      </section>

      {isAdmin && <SettingsSection />}
    </Page>
  );
}

function SettingsSection() {
  const [settings, setSettings] = useState<ApprovalSettings | null>(null);
  const [hours, setHours] = useState("");
  const [tools, setTools] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    client
      .approvalSettings()
      .then((s) => {
        setSettings(s);
        setHours(String(+(s.timeoutMs / 3_600_000).toFixed(2)));
        setTools(s.riskyTools.join(", "));
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0) return toast.error("Enter a timeout in hours, greater than 0");
    setSaving(true);
    try {
      const next = await client.updateApprovalSettings({
        timeoutMs: Math.round(value * 3_600_000),
        riskyTools: tools
          .split(/[,\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setSettings(next);
      setTools(next.riskyTools.join(", "));
      toast.success("Approval settings saved");
    } catch (error) {
      toast.error(error, "Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-12">
      <SectionHeader title="Settings" description="Apply to every agent. Each agent's policy (off, risky tools, every tool) is set in its editor." />
      <Card className="overflow-hidden">
        {!settings ? (
          <div className="p-5">
            <Skeleton className="h-24" />
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-5 p-5 sm:grid-cols-[170px_minmax(0,1fr)]">
              <Field label="Timeout (hours)" htmlFor="approval-timeout" hint="Unanswered requests are denied after this.">
                <Input id="approval-timeout" type="number" min={0.01} step="any" value={hours} onChange={(e) => setHours(e.target.value)} className="font-mono" />
              </Field>
              <Field label="More risky tools" htmlFor="approval-tools" hint="Tool names, comma-separated; end with * for a prefix, e.g. forget, mcp__github__*.">
                <Input id="approval-tools" value={tools} placeholder="forget, mcp__github__*" onChange={(e) => setTools(e.target.value)} className="font-mono" />
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2/40 px-5 py-3">
              <p className="flex items-center gap-1.5 text-[12px] text-subtle">
                <ShieldAlert className="size-3.5 text-faint" />
                <span>
                  <code className="font-mono text-muted">bash</code>, <code className="font-mono text-muted">write</code>, and <code className="font-mono text-muted">edit</code> always count as risky.
                </span>
              </p>
              <Button type="submit" variant="primary" loading={saving}>
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>
    </section>
  );
}

function useThread(threadId: string | null) {
  return useApp((s) => (threadId ? s.threads?.find((t) => t.id === threadId) : undefined));
}

function ApprovalCard({ approval, index }: { approval: Approval; index: number }) {
  const agents = useAgentMap();
  const agent = approval.agentId ? agents.get(approval.agentId) : undefined;
  const thread = useThread(approval.threadId);
  const args = approvalArgs(approval);
  const isCommand = approval.tool === "bash" && typeof (approval.args as { command?: unknown } | null)?.command === "string";
  return (
    <Card
      className="relative animate-rise overflow-hidden border-warning/35 shadow-[var(--card-shadow),0_16px_40px_-24px_rgb(244_184_74/0.35)]"
      style={{ animationDelay: `${Math.min(index, 6) * 50}ms` }}
    >
      <div aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-warning" />
      <div aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-warning/70 to-transparent" />
      <div className="flex items-start gap-3 pl-5 pr-4 pt-4">
        <AgentAvatar agent={agent} size="md" presence="approval" className="[--presence-ring:var(--surface)]" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] leading-snug text-fg">
            <span className="font-semibold">{agent?.name ?? "An agent"}</span> <span className="text-subtle">wants to run</span>{" "}
            <code className="rounded-md border border-warning/30 bg-warning-soft px-1.5 py-px font-mono text-[12.5px] font-semibold text-warning">{approval.tool}</code>
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-subtle">
            <span className="font-mono text-[11px] text-faint" title={fullDate(approval.createdAt)}>
              {relativeTime(approval.createdAt)}
            </span>
            {thread && (
              <>
                <span className="text-faint">·</span>
                {thread.source !== "web" && <SourceBadge source={thread.source} className="h-[18px] text-[10.5px]" />}
                <a
                  href={`/chat/${thread.id}`}
                  onClick={linkHandler(`/chat/${thread.id}`)}
                  className="inline-flex min-w-0 max-w-full items-center gap-0.5 truncate text-muted transition-colors hover:text-fg"
                >
                  <span className="truncate">{thread.title}</span>
                  <ArrowUpRight className="size-3 shrink-0" />
                </a>
              </>
            )}
          </p>
        </div>
        <span className="hidden h-6 shrink-0 items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-2.5 font-mono text-[10.5px] font-medium text-warning sm:inline-flex">
          <span className="size-1.5 animate-pulse-soft rounded-full bg-warning" />
          paused
        </span>
      </div>
      <div className="ml-5 mr-4 mt-3.5 overflow-hidden rounded-lg border border-border bg-code">
        <div className="flex items-center justify-between border-b border-border py-1 pl-3 pr-1">
          <span className="label-mono text-faint">{isCommand ? "Command" : approval.tool === "write" ? "File" : "Arguments"}</span>
          <CopyButton text={args} label="Copy arguments" size="xs" />
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-fg">
          {isCommand && <span className="select-none text-faint">$ </span>}
          {args}
        </pre>
      </div>
      <ApprovalActions approval={approval} className="pb-4 pl-5 pr-4 pt-3.5" />
    </Card>
  );
}

/** Where a decision came from, as shown after "Approved by Josh". The dashboard, timeouts, and the system say nothing. */
const VIA: Record<string, string> = { slack: "in Slack", discord: "in Discord", telegram: "in Telegram", tui: "in the terminal", api: "via the API" };

const DECIDED_STYLE: Record<Approval["status"], { icon: React.ReactNode; className: string; tone: "success" | "danger" | "neutral" | "warning" }> = {
  approved: { icon: <Check strokeWidth={2.5} />, className: "border-success/25 bg-success-soft text-success", tone: "success" },
  denied: { icon: <X strokeWidth={2.5} />, className: "border-danger/25 bg-danger-soft text-danger", tone: "danger" },
  expired: { icon: <Clock />, className: "border-danger/25 bg-danger-soft text-danger", tone: "danger" },
  cancelled: { icon: <Ban />, className: "border-border-strong bg-surface-2 text-subtle", tone: "neutral" },
  pending: { icon: <ShieldAlert />, className: "border-warning/25 bg-warning-soft text-warning", tone: "warning" },
};

function DecidedRow({ approval }: { approval: Approval }) {
  const agents = useAgentMap();
  const agent = approval.agentId ? agents.get(approval.agentId) : undefined;
  const thread = useThread(approval.threadId);
  const style = DECIDED_STYLE[approval.status];
  const summary = approvalArgs(approval).replace(/\s+/g, " ");
  const at = approval.decidedAt ?? approval.createdAt;
  const body = (
    <>
      <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border [&_svg]:size-3.5", style.className)}>{style.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-[13px]">
          <code className="shrink-0 font-mono font-medium text-fg">{approval.tool}</code>
          <span className="min-w-0 truncate font-mono text-[12px] text-subtle">{summary}</span>
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-subtle">
          {agent && <AgentAvatar agent={agent} size="xs" className="size-3.5 text-[8px]" />}
          <span className="truncate">
            {approvalStatusText(approval)}
            {approval.decidedVia && VIA[approval.decidedVia] ? ` ${VIA[approval.decidedVia]}` : ""}
            {thread ? ` · ${thread.title}` : ""}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge tone={style.tone}>{approval.status}</Badge>
        <span className="font-mono text-[10.5px] text-faint" title={fullDate(at)}>
          {shortTime(at)}
        </span>
      </div>
    </>
  );
  const className = cn("flex items-start gap-3 px-4 py-3", thread && "transition-colors hover:bg-surface-2/60");
  return (
    <li>
      {thread ? (
        <a href={`/chat/${thread.id}`} onClick={linkHandler(`/chat/${thread.id}`)} className={className}>
          {body}
        </a>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
}
