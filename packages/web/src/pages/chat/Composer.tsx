import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, Square } from "lucide-react";
import type { Agent } from "@soloagent/client";
import { useApp } from "../../api/store.ts";
import { AgentAvatar } from "../../components/brand.tsx";
import { MenuLabel, Popover } from "../../components/overlay.tsx";
import { Kbd } from "../../components/ui.tsx";
import { cn } from "../../lib/cn.ts";

const drafts = new Map<string, string>();

export function Composer({
  draftKey,
  agent,
  busy,
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
  queued?: number;
  disabled?: boolean;
  onSend: (text: string, mode: "steer" | "followUp") => Promise<boolean>;
  onStop?: () => void;
  onSwitchAgent?: (agentId: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
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
    if (!value || sending || disabled) return;
    setSending(true);
    update("");
    const ok = await onSend(value, mode);
    setSending(false);
    if (!ok) update(value);
    area.current?.focus();
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

  const canSend = text.trim().length > 0 && !sending && !disabled;

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-6 sm:pb-5">
      <div
        className={cn(
          "rounded-2xl border bg-surface shadow-md transition-[border-color,box-shadow] duration-150 focus-within:shadow-lg",
          busy ? "border-accent/35 focus-within:border-accent/60" : "border-border-strong focus-within:border-accent/50",
        )}
      >
        <textarea
          ref={area}
          value={text}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={disabled}
          aria-label="Message"
          placeholder={placeholder ?? (busy ? `Steer ${agent?.name ?? "the agent"} while it works…` : `Message ${agent?.name ?? "agent"}…`)}
          className="block max-h-[280px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14.5px] leading-relaxed text-fg outline-none"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
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
                canSend ? "bg-accent text-white shadow-[0_2px_10px_-2px_var(--accent)] hover:bg-accent-hover" : "bg-surface-3 text-faint",
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
            <span className="text-accent-text">Working</span> · <Kbd className="h-4 text-[10px]">↵</Kbd> steers the run ·
            <Kbd className="h-4 text-[10px]">⌥↵</Kbd> queues a follow-up
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
