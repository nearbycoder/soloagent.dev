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
      <p className={cn("text-[12.5px] text-subtle", className)}>
        Waiting for an admin to decide. Auto-denied {relativeTime(approval.expiresAt)} if nobody does.
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
        <Button type="submit" variant="danger" size="md" loading={busy === "deny"} icon={<X className="size-3.5" />}>
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
      <Button variant="primary" size="md" loading={busy === "approve"} disabled={busy !== null} icon={<Check className="size-3.5" />} onClick={() => void decide(true)}>
        Approve
      </Button>
      <Button variant="danger" size="md" disabled={busy !== null} icon={<X className="size-3.5" />} onClick={() => setDenying(true)}>
        Deny…
      </Button>
      <span className="text-[11.5px] text-faint" title={new Date(approval.expiresAt).toLocaleString()}>
        Auto-denied {relativeTime(approval.expiresAt)}
      </span>
    </div>
  );
}

/** The banner a tool card shows while its call waits. */
export function ApprovalWaiting({ approval }: { approval: Approval }) {
  return (
    <div className="border-t border-warning/25 bg-warning-soft/60 px-3 py-2.5">
      <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-warning">
        <ShieldAlert className="size-3.5" />
        Waiting for approval to run <code className="font-mono">{approval.tool}</code>
      </p>
      <ApprovalActions approval={approval} />
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
