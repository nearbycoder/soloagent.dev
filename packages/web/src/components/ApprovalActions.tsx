import { useState } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import type { Approval } from "@soloagent/client";
import { client } from "../api/client.ts";
import { localApproval, useIsAdmin } from "../api/store.ts";
import { cn } from "../lib/cn.ts";
import { relativeTime } from "../lib/format.ts";
import { toast } from "../lib/toast.ts";
import { Button, Input } from "./ui.tsx";

/** Approve / Deny for a waiting tool call. Deny asks for an optional reason the agent will see. */
export function ApprovalActions({ approval, className }: { approval: Approval; className?: string }) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <p className={cn("text-[12.5px] leading-relaxed text-subtle", className)}>
        Waiting for an admin to decide. Auto-denied <span className="font-mono text-[11.5px]">{relativeTime(approval.expiresAt)}</span> if nobody does.
      </p>
    );
  }
  return <AdminApprovalActions approval={approval} className={className} />;
}

function AdminApprovalActions({ approval, className }: { approval: Approval; className?: string }) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "deny");
    try {
      localApproval(approve ? await client.approve(approval.id) : await client.deny(approval.id, { reason: reason.trim() || undefined }));
    } catch (error) {
      toast.error(error, approve ? "Could not approve" : "Could not deny");
    } finally {
      setBusy(null);
    }
  };

  if (denying) {
    return (
      <form
        className={cn("flex flex-wrap items-center gap-2", className)}
        onSubmit={(event) => {
          event.preventDefault();
          void decide(false);
        }}
      >
        <Input
          autoFocus
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (optional, the agent sees it)"
          aria-label="Reason for denying"
          className="h-8 min-w-0 flex-1 basis-56"
          onKeyDown={(event) => event.key === "Escape" && setDenying(false)}
        />
        <Button type="submit" variant="danger" size="md" loading={busy === "deny"} icon={<X />}>
          Deny
        </Button>
        <Button variant="ghost" size="md" onClick={() => setDenying(false)}>
          Cancel
        </Button>
      </form>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Button variant="primary" size="md" loading={busy === "approve"} disabled={busy !== null} icon={<Check />} onClick={() => void decide(true)}>
        Approve
      </Button>
      <Button variant="danger" size="md" disabled={busy !== null} icon={<X />} onClick={() => setDenying(true)}>
        Deny…
      </Button>
      <span className="ml-auto font-mono text-[11px] text-faint" title={new Date(approval.expiresAt).toLocaleString()}>
        auto-denied {relativeTime(approval.expiresAt)}
      </span>
    </div>
  );
}

/** The panel a tool step shows while its call waits: what would run, and the decision. */
export function ApprovalWaiting({ approval, className }: { approval: Approval; className?: string }) {
  const args = approvalArgs(approval);
  return (
    <div className={cn("overflow-hidden rounded-xl border border-warning/35 bg-warning-soft shadow-[0_0_28px_-16px_var(--warning)]", className)}>
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="relative grid size-5 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-warning/25" />
          <ShieldAlert className="relative size-4 text-warning" />
        </span>
        <p className="text-[13px] font-semibold text-fg">Needs your approval</p>
        <code className="ml-auto truncate rounded-md border border-warning/25 bg-warning-soft px-1.5 py-0.5 font-mono text-[11px] text-warning">{approval.tool}</code>
      </div>
      <p className="px-3.5 pt-1 text-[12.5px] leading-relaxed text-muted">The run is paused before this call. Nothing executes until someone decides.</p>
      {args && args !== "{}" && (
        <pre className="mx-3.5 mt-2.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-fg">
          {approval.tool === "bash" && <span className="select-none text-faint">$ </span>}
          {args}
        </pre>
      )}
      <ApprovalActions approval={approval} className="px-3.5 pb-3 pt-3" />
    </div>
  );
}

/** "Approved by ann", "Denied by dashboard: not on prod", … */
export function approvalStatusText(approval: Approval): string {
  switch (approval.status) {
    case "pending":
      return "Waiting for approval";
    case "approved":
      return `Approved by ${approval.decidedBy ?? "someone"}`;
    case "denied":
      return `Denied by ${approval.decidedBy ?? "someone"}${approval.reason ? `: ${approval.reason}` : ""}`;
    case "expired":
      return "Expired, so denied";
    case "cancelled":
      return "Cancelled";
  }
}

/** The arguments as a person reads them: the command for bash, path and content for writes, else JSON. */
export function approvalArgs(approval: Pick<Approval, "tool" | "args">): string {
  const a = (approval.args ?? {}) as Record<string, unknown>;
  if (approval.tool === "bash" && typeof a.command === "string") return a.command;
  if (approval.tool === "write" && typeof a.path === "string") return `${a.path}\n\n${typeof a.content === "string" ? a.content : ""}`;
  try {
    return JSON.stringify(approval.args, null, 2);
  } catch {
    return String(approval.args);
  }
}
