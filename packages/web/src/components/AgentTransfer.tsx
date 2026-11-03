import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
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
      <Button icon={<Download className="size-4" />} loading={exporting} onClick={exportAll} title="Download every agent as JSON">
        Export
      </Button>
      <Button icon={<Upload className="size-4" />} onClick={() => input.current?.click()} title="Add or update agents from an export">
        Import
      </Button>
      <input ref={input} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />

      <Modal
        open={!!file}
        onClose={close}
        title="Import agents"
        description={file ? `${file.name} · ${file.agents.length === 1 ? "1 agent" : `${file.agents.length} agents`}, matched by handle` : undefined}
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
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[12.5px] text-subtle">{mode === "merge" ? "Existing agents take the file's values; fields it leaves out are kept." : "Agents that already exist are left alone."}</p>
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
            <p className="text-[13px] text-subtle">Checking what would change…</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {preview.items.map((item) => (
                <li key={item.handle} className="flex items-start gap-3 px-3 py-2.5 text-[13px]">
                  <Badge tone={ACTION_TONE[item.action]} className="mt-px w-[72px] justify-center">
                    {ACTION_LABEL[item.action]}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-fg">
                      {item.name} <span className="font-mono text-[12px] text-subtle">@{item.handle}</span>
                    </p>
                    {item.fields.length > 0 && <p className="mt-0.5 text-[12px] text-subtle">Changes {item.fields.join(", ")}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-faint">Importing never changes which agent is the default. Models that aren't set up on this server need a provider before those agents can answer.</p>
        </div>
      </Modal>
    </>
  );
}
