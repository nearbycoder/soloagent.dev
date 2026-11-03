import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, FileText, Paperclip, Square, X } from "lucide-react";
import type { Agent } from "@soloagent/client";
import { useApp } from "../../api/store.ts";
import { AgentAvatar } from "../../components/brand.tsx";
import { MenuLabel, Popover } from "../../components/overlay.tsx";
import { Kbd } from "../../components/ui.tsx";
import { cn } from "../../lib/cn.ts";
import { fileSize, MAX_FILE_BYTES, MAX_FILES, PREVIEWABLE } from "../../lib/files.ts";
import { toast } from "../../lib/toast.ts";
import { ALT, shortcut } from "../../lib/keys.ts";

type Pending = { id: number; file: File; preview?: string };
let pendingId = 0;

const drafts = new Map<string, string>();

export function Composer({
  draftKey,
  agent,
  busy,
  waiting,
  queued,
  disabled,
  onSend,
  onStop,
  onSwitchAgent,
  autoFocus,
  placeholder,
}: {
  draftKey: string;
  agent: Agent | undefined;
  busy: boolean;
  /** The run is paused on an approval. */
  waiting?: boolean;
  queued?: number;
  disabled?: boolean;
  onSend: (text: string, mode: "steer" | "followUp", files: File[]) => Promise<boolean>;
  onStop?: () => void;
  onSwitchAgent?: (agentId: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const addFiles = (list: Iterable<File>) => {
    const incoming = [...list];
    if (incoming.length === 0) return;
    const tooBig = incoming.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length) toast.error(new Error(`${tooBig.map((f) => f.name).join(", ")}: files can be up to ${fileSize(MAX_FILE_BYTES)}.`), "File too large");
    setFiles((current) => {
      const room = MAX_FILES - current.length;
      const accepted = incoming.filter((f) => f.size <= MAX_FILE_BYTES);
      if (accepted.length > room) toast.info(`Up to ${MAX_FILES} files per message`);
      return [...current, ...accepted.slice(0, Math.max(0, room)).map((file) => ({ id: ++pendingId, file, preview: PREVIEWABLE.has(file.type) ? URL.createObjectURL(file) : undefined }))];
    });
  };
  const removeFile = (id: number) =>
    setFiles((current) => {
      const gone = current.find((f) => f.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return current.filter((f) => f.id !== id);
    });
  const clearFiles = () =>
    setFiles((current) => {
      for (const f of current) if (f.preview) URL.revokeObjectURL(f.preview);
      return [];
    });

  useEffect(() => {
    clearFiles();
    setText(drafts.get(draftKey) ?? "");
    if (autoFocus && window.matchMedia("(pointer: fine)").matches) area.current?.focus();
  }, [draftKey, autoFocus]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const update = (value: string) => {
    setText(value);
    if (value) drafts.set(draftKey, value);
    else drafts.delete(draftKey);
  };

  const submit = async (mode: "steer" | "followUp") => {
    const value = text.trim();
    if ((!value && files.length === 0) || sending || disabled) return;
    setSending(true);
    update("");
    const ok = await onSend(value, mode, files.map((f) => f.file));
    setSending(false);
    if (ok) clearFiles();
    else update(value);
    area.current?.focus();
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...event.clipboardData.files];
    if (pasted.length === 0) return;
    // A screenshot or copied file: attach it. Text that came along still pastes as text.
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    addFiles(pasted);
  };

  const dragProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes("Files") || disabled) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!event.dataTransfer.files.length || disabled) return;
      event.preventDefault();
      setDragging(false);
      addFiles(event.dataTransfer.files);
      area.current?.focus();
    },
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit(busy && event.altKey ? "followUp" : "steer");
    }
    if (event.key === "Escape" && busy && onStop) {
      event.preventDefault();
      onStop();
    }
  };

  const canSend = (text.trim().length > 0 || files.length > 0) && !sending && !disabled;

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-6 sm:pb-5">
      <div
        {...dragProps}
        className={cn(
          "relative rounded-2xl border bg-surface shadow-md transition-[border-color,box-shadow] duration-150 focus-within:shadow-lg",
          busy ? "border-accent-line/35 focus-within:border-accent-line/60" : "border-border-strong focus-within:border-accent-line/50",
          dragging && "border-accent-line/70",
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-accent-line/70 bg-surface/90 text-[13px] font-medium text-fg">
            Drop files to attach
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attachments">
            {files.map((f) => (
              <div key={f.id} className="group/chip relative">
                {f.preview ? (
                  <img src={f.preview} alt={f.file.name} title={`${f.file.name} · ${fileSize(f.file.size)}`} className="size-16 rounded-lg border border-border object-cover" />
                ) : (
                  <div className="flex h-16 max-w-[220px] items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5" title={f.file.name}>
                    <FileText className="size-5 shrink-0 text-subtle" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium text-fg">{f.file.name}</span>
                      <span className="block text-[11px] text-faint">{fileSize(f.file.size)}</span>
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeFile(f.id)}
                  aria-label={`Remove ${f.file.name}`}
                  className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-border-strong bg-surface text-muted shadow-sm hover:text-fg"
                >
                  <X className="size-3" strokeWidth={2.4} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          value={text}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          disabled={disabled}
          aria-label="Message"
          placeholder={placeholder ?? (busy ? `Steer ${agent?.name ?? "the agent"} while it works…` : `Message ${agent?.name ?? "agent"}…`)}
          className="block max-h-[280px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14.5px] leading-relaxed text-fg outline-none"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files ?? []);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={disabled}
            aria-label="Attach files"
            title="Attach files (or paste, or drop them here)"
            className="grid size-8 shrink-0 place-items-center rounded-full text-subtle transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          >
            <Paperclip className="size-4" />
          </button>
          {onSwitchAgent ? <AgentSwitcher agent={agent} onSelect={onSwitchAgent} /> : <div />}
          <div className="ml-auto flex items-center gap-1.5">
            {busy && onStop && (
              <button
                type="button"
                onClick={onStop}
                title="Stop (Esc)"
                className="flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface-2 pl-2.5 pr-3 text-[12.5px] font-medium text-fg transition-colors hover:border-danger/40 hover:text-danger"
              >
                <Square className="size-3 fill-current" />
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={() => void submit("steer")}
              disabled={!canSend}
              aria-label={busy ? "Send as steer" : "Send"}
              title={busy ? "Steer the current run (Enter)" : "Send (Enter)"}
              className={cn(
                "grid size-8 place-items-center rounded-full transition-all duration-150",
                canSend ? "bg-accent text-accent-fg hover:bg-accent-hover" : "bg-surface-3 text-faint",
              )}
            >
              <ArrowUp className="size-4" strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
      <div className="mt-2 flex h-4 items-center justify-center gap-3 text-[11.5px] text-faint">
        {busy ? (
          <span className="flex items-center gap-1.5">
            {waiting ? <span className="text-warning">Waiting for approval</span> : <span className="text-accent-text">Working</span>}
            {/* Keyboard hints only where there is a keyboard. */}
            <span className="hidden items-center gap-1.5 sm:flex">
              · <Kbd className="h-4 text-[10px]">↵</Kbd> steers the run · <Kbd className="h-4 text-[10px]">{shortcut("↵", ALT)}</Kbd> queues a follow-up
            </span>
            {queued ? <span className="text-muted">· {queued} queued</span> : null}
          </span>
        ) : (
          <span className="hidden sm:inline">
            <Kbd className="h-4 text-[10px]">↵</Kbd> send · <Kbd className="h-4 text-[10px]">⇧↵</Kbd> new line
          </span>
        )}
      </div>
    </div>
  );
}

function AgentSwitcher({ agent, onSelect }: { agent: Agent | undefined; onSelect: (id: string) => void }) {
  const agents = useApp((s) => s.agents) ?? [];
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch agent for this thread"
        aria-label={`Answering: ${agent?.name ?? "no agent"}. Switch agent`}
        className="flex h-8 min-w-0 items-center gap-2 rounded-full border border-transparent pl-1 pr-2.5 text-[12.5px] font-medium text-muted transition-colors hover:border-border hover:bg-surface-2 hover:text-fg"
      >
        <AgentAvatar agent={agent} size="sm" className="rounded-full" />
        <span className="max-w-[140px] truncate">{agent?.name ?? "Choose agent"}</span>
        <ChevronDown className="size-3.5 text-faint" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="w-72">
        <MenuLabel>Answer with</MenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                setOpen(false);
                if (a.id !== agent?.id) onSelect(a.id);
              }}
              className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2", a.id === agent?.id && "bg-surface-2/60")}
            >
              <AgentAvatar agent={a} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">{a.name}</span>
                <span className="block truncate font-mono text-[11px] text-subtle">
                  @{a.handle} · {a.model?.modelId ?? "no model"}
                </span>
              </span>
              {a.id === agent?.id && <Check className="size-4 text-accent-text" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
