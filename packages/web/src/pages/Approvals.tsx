import { useEffect, useState } from "react";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import type { Approval, ApprovalSettings } from "@soloagent/client";
import { client } from "../api/client.ts";
import { useAgentMap, useApp } from "../api/store.ts";
import { ApprovalActions, approvalArgs, approvalStatusText } from "../components/ApprovalActions.tsx";
import { AgentAvatar, SourceBadge } from "../components/brand.tsx";
import { Badge, Button, Card, EmptyState, Field, Input, Page, PageHeader, SectionHeader, Skeleton } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { fullDate, relativeTime } from "../lib/format.ts";
import { linkHandler } from "../lib/router.ts";
import { toast } from "../lib/toast.ts";

export function ApprovalsPage() {
  const pending = useApp((s) => s.approvals);
  const version = useApp((s) => s.approvalsVersion);
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
        title="Approvals"
        description="Tool calls that wait for a person before they run. Approve or deny here, in the thread, or with the buttons in Slack, Discord, and Telegram."
      />
      <section>
        <SectionHeader title={`Waiting${pending?.length ? ` · ${pending.length}` : ""}`} />
        {pending === null ? (
          <Skeleton className="h-32 rounded-xl" />
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
            {pending.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
          </div>
        )}
      </section>
      <section className="mt-10">
        <SectionHeader title="Recently decided" />
        {recent === null ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : recent.length === 0 ? (
          <p className="text-[13px] text-subtle">No decisions yet.</p>
        ) : (
          <Card className="divide-y divide-border">
            {recent.map((approval) => (
              <DecidedRow key={approval.id} approval={approval} />
            ))}
          </Card>
        )}
      </section>
      <SettingsSection />
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
    <section className="mt-10">
      <SectionHeader title="Settings" description="Apply to every agent. Each agent's policy (off, risky tools, every tool) is set in its editor." />
      <Card className="p-5">
        {!settings ? (
          <Skeleton className="h-24" />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
              <Field label="Timeout (hours)" htmlFor="approval-timeout" hint="Unanswered requests are denied after this.">
                <Input id="approval-timeout" type="number" min={0.01} step="any" value={hours} onChange={(e) => setHours(e.target.value)} />
              </Field>
              <Field label="More risky tools" htmlFor="approval-tools" hint="Besides bash, write, and edit. Tool names, comma-separated, e.g. forget, schedule_reminder.">
                <Input id="approval-tools" value={tools} placeholder="forget, ask_agent" onChange={(e) => setTools(e.target.value)} className="font-mono" />
              </Field>
            </div>
            <div>
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

function useThreadTitle(threadId: string | null) {
  return useApp((s) => (threadId ? s.threads?.find((t) => t.id === threadId) : undefined));
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const agents = useAgentMap();
  const agent = approval.agentId ? agents.get(approval.agentId) : undefined;
  const thread = useThreadTitle(approval.threadId);
  return (
    <Card className="overflow-hidden border-warning/30">
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <AgentAvatar agent={agent} size="md" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] text-fg">
            <span className="font-semibold">{agent?.name ?? "An agent"}</span> wants to run <code className="font-mono text-[13px] font-semibold">{approval.tool}</code>
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-subtle">
            <span title={fullDate(approval.createdAt)}>{relativeTime(approval.createdAt)}</span>
            {thread && (
              <>
                <span className="text-faint">·</span>
                {thread.source !== "web" && <SourceBadge source={thread.source} className="h-4 text-[10px]" />}
                <a href={`/chat/${thread.id}`} onClick={linkHandler(`/chat/${thread.id}`)} className="inline-flex min-w-0 items-center gap-0.5 truncate text-muted hover:text-fg">
                  {thread.title}
                  <ArrowUpRight className="size-3" />
                </a>
              </>
            )}
          </p>
        </div>
      </div>
      <pre className="mx-4 mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-muted">
        {approvalArgs(approval)}
      </pre>
      <ApprovalActions approval={approval} className="px-4 pb-3.5 pt-3" />
    </Card>
  );
}

function DecidedRow({ approval }: { approval: Approval }) {
  const agents = useAgentMap();
  const agent = approval.agentId ? agents.get(approval.agentId) : undefined;
  const thread = useThreadTitle(approval.threadId);
  const tone = approval.status === "approved" ? "success" : approval.status === "cancelled" ? "neutral" : "danger";
  const summary = approvalArgs(approval).replace(/\s+/g, " ");
  const body = (
    <>
      <AgentAvatar agent={agent} size="xs" className="mt-0.5 size-[18px] text-[10px]" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-[13px]">
          <code className="shrink-0 font-mono font-medium text-fg">{approval.tool}</code>
          <span className="min-w-0 truncate font-mono text-[12px] text-subtle">{summary}</span>
        </p>
        <p className="mt-0.5 truncate text-[12px] text-subtle">
          {approvalStatusText(approval)}
          {approval.decidedVia && approval.decidedVia !== "dashboard" && approval.decidedVia !== "timeout" && approval.decidedVia !== "system" ? ` in ${approval.decidedVia}` : ""}
          {thread ? ` · ${thread.title}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge tone={tone}>{approval.status}</Badge>
        <span className="text-[11px] text-faint" title={fullDate(approval.decidedAt ?? approval.createdAt)}>
          {relativeTime(approval.decidedAt ?? approval.createdAt)}
        </span>
      </div>
    </>
  );
  const className = cn("flex items-start gap-3 px-4 py-2.5", thread && "transition-colors hover:bg-surface-2/60");
  return thread ? (
    <a href={`/chat/${thread.id}`} onClick={linkHandler(`/chat/${thread.id}`)} className={className}>
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}
