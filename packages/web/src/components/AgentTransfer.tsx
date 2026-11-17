import { useRef, useState } from "react";
import { Download, FileJson, Upload } from "lucide-react";
import type { AgentImportMode, AgentImportResult } from "@soloagent/client";
import { client, errorMessage } from "../api/client.ts";
import { Modal } from "./overlay.tsx";
import { Badge, Button, Segmented } from "./ui.tsx";
import { toast } from "../lib/toast.ts";

const ACTION_TONE = { create: "success", update: "warning", skip: "neutral", unchanged: "neutral" } as const;
const ACTION_LABEL = { create: "New", update: "Update", skip: "Skip", unchanged: "No change" } as const;

/** Export downloads every agent as JSON; Import previews what a file would change, then applies it. */
export function AgentTransfer() {
  const input = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [file, setFile] = useState<{ name: string; agents: unknown[] } | null>(null);
  const [mode, setMode] = useState<AgentImportMode>("merge");
  const [preview, setPreview] = useState<AgentImportResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exportAll = async () => {
    setExporting(true);
    try {
      const data = await client.exportAgents();
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `soloagent-agents-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(data.agents.length === 1 ? "Exported 1 agent" : `Exported ${data.agents.length} agents`);
    } catch (error) {
      toast.error(error, "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const loadPreview = async (agents: unknown[], nextMode: AgentImportMode) => {
    setPreviewError(null);
    setPreview(null);
    try {
      setPreview(await client.importAgents({ agents, mode: nextMode }, { dryRun: true }));
    } catch (error) {
      setPreviewError(errorMessage(error));
    }
  };

  const pick = async (picked: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!picked) return;
    let agents: unknown;
    try {
      const parsed = JSON.parse(await picked.text()) as unknown;
      agents = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown })?.agents;
    } catch {
      toast.error(new Error(`${picked.name} is not valid JSON`), "Can't import that file");
      return;
    }
    if (!Array.isArray(agents)) {
      toast.error(new Error("Expected the file from Export, with an agents list"), "Can't import that file");
      return;
    }
    setFile({ name: picked.name, agents });
    void loadPreview(agents, mode);
  };

  const close = () => {
    setFile(null);
    setPreview(null);
    setPreviewError(null);
  };

  const apply = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await client.importAgents({ agents: file.agents, mode });
      const created = result.items.filter((i) => i.action === "create").length;
      const updated = result.items.filter((i) => i.action === "update").length;
      toast.success("Agents imported", `${created} created, ${updated} updated`);
      close();
    } catch (error) {
      toast.error(error, "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const changes = preview?.items.filter((i) => i.action === "create" || i.action === "update").length ?? 0;

  return (
    <>
      <Button icon={<Download />} loading={exporting} onClick={exportAll} title="Download every agent as JSON">
        Export
      </Button>
      <Button icon={<Upload />} onClick={() => input.current?.click()} title="Add or update agents from an export">
        Import
      </Button>
      <input ref={input} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />

      <Modal
        open={!!file}
        onClose={close}
        title="Import agents"
        description={file ? `${file.agents.length === 1 ? "1 agent" : `${file.agents.length} agents`} in the file, matched to yours by @handle.` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!preview || changes === 0} onClick={apply}>
              {changes === 0 ? "Nothing to import" : `Import ${changes === 1 ? "1 change" : `${changes} changes`}`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 px-5 pb-5 pt-1">
          {file && (
            <div className="flex items-center gap-2.5 rounded-lg border border-border bg-code px-3 py-2">
              <FileJson className="size-4 shrink-0 text-subtle" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{file.name}</span>
              {preview && (
                <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-faint">
                  {(["create", "update", "skip", "unchanged"] as const).map((action) => {
                    const n = preview.items.filter((i) => i.action === action).length;
                    return n ? (
                      <span key={action} className={action === "create" ? "text-success" : action === "update" ? "text-warning" : undefined}>
                        {n} {ACTION_LABEL[action].toLowerCase()}
                      </span>
                    ) : null;
                  })}
                </span>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-[46ch] text-[12.5px] leading-relaxed text-subtle">{mode === "merge" ? "Existing agents take the file's values; fields it leaves out are kept." : "Agents that already exist are left alone."}</p>
            <Segmented<AgentImportMode>
              size="sm"
              value={mode}
              onChange={(next) => {
                setMode(next);
                if (file) void loadPreview(file.agents, next);
              }}
              options={[
                { value: "merge", label: <span className="whitespace-nowrap">Merge</span> },
                { value: "skip-existing", label: <span className="whitespace-nowrap">Skip existing</span> },
              ]}
            />
          </div>
          {previewError ? (
            <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">{previewError}</p>
          ) : !preview ? (
            <p className="flex items-center gap-2 text-[13px] text-subtle">
              <span className="size-1.5 animate-pulse-soft rounded-full bg-faint" />
              Checking what would change…
            </p>
          ) : (
            <ul className="max-h-[46vh] divide-y divide-border overflow-y-auto rounded-xl border border-border bg-surface/40">
              {preview.items.map((item) => (
                <li key={item.handle} className="flex items-start gap-3 px-3.5 py-3 text-[13px]">
                  <Badge tone={ACTION_TONE[item.action]} className="mt-px w-[76px] justify-center">
                    {ACTION_LABEL[item.action]}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-fg">
                      <span className="font-medium">{item.name}</span> <span className="font-mono text-[12px] text-subtle">@{item.handle}</span>
                    </p>
                    {item.fields.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {item.fields.map((field) => (
                          <span key={field} className="rounded-md border border-border bg-surface-2 px-1.5 py-px font-mono text-[10.5px] text-muted">
                            {field}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] leading-relaxed text-faint">Importing never changes which agent is the default. Models that aren't set up on this server need a provider before those agents can answer.</p>
        </div>
      </Modal>
    </>
  );
}
