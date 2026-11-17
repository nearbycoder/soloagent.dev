import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, Check, ChevronsUpDown, Eye, Search, TriangleAlert } from "lucide-react";
import type { ModelRef, ProviderInfo, ProviderModel } from "@soloagent/client";
import { loadProviders, useApp } from "../api/store.ts";
import { cn } from "../lib/cn.ts";
import { contextWindow, num, perMillion } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { ProviderMark } from "./brand.tsx";
import { Popover } from "./overlay.tsx";
import { Kbd, Spinner } from "./ui.tsx";

const MAX_ROWS = 160;

function rankProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return [...providers].sort((a, b) => {
    const ca = a.configured ? (a.configured.source === "built-in" ? 1 : 0) : 2;
    const cb = b.configured ? (b.configured.source === "built-in" ? 1 : 0) : 2;
    return ca - cb || Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name);
  });
}

export function findModel(providers: ProviderInfo[] | null, ref: ModelRef | null): { provider: ProviderInfo; model: ProviderModel } | undefined {
  if (!providers || !ref) return undefined;
  const provider = providers.find((p) => p.id === ref.provider);
  const model = provider?.models.find((m) => m.id === ref.modelId);
  return provider && model ? { provider, model } : undefined;
}

function providerState(provider: ProviderInfo): { label: string; tone: "success" | "neutral" } {
  if (!provider.configured) return { label: "not connected", tone: "neutral" };
  if (provider.configured.source === "built-in") return { label: "built-in", tone: "success" };
  return { label: provider.configured.type === "oauth" ? "subscription" : "api key", tone: "success" };
}

/** Small capability marks: extended thinking and image input. */
function Capabilities({ model, className }: { model: ProviderModel; className?: string }) {
  if (!model.reasoning && !model.vision) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      {model.reasoning && (
        <span title="Extended thinking" aria-label="Reasoning" className="grid size-[18px] place-items-center rounded-[5px] border border-border bg-surface-2 text-subtle">
          <Brain className="size-3" />
        </span>
      )}
      {model.vision && (
        <span title="Reads images" aria-label="Vision" className="grid size-[18px] place-items-center rounded-[5px] border border-border bg-surface-2 text-subtle">
          <Eye className="size-3" />
        </span>
      )}
    </span>
  );
}

export function ModelPicker({ value, onChange, id }: { value: ModelRef | null; onChange: (value: ModelRef) => void; id?: string }) {
  const providers = useApp((s) => s.providers);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({ reasoning: false, vision: false });
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadProviders();
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setFilters({ reasoning: false, vision: false });
      requestAnimationFrame(() => search.current?.focus());
    }
  }, [open]);

  const current = findModel(providers, value);

  const rows = useMemo(() => {
    if (!providers) return [];
    const q = query.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const out: { provider: ProviderInfo; model: ProviderModel }[] = [];
    for (const provider of rankProviders(providers)) {
      // Without a query, keep the list focused: everything from configured and featured providers.
      if (!q && !provider.configured && !provider.featured) continue;
      for (const model of provider.models) {
        if (filters.reasoning && !model.reasoning) continue;
        if (filters.vision && !model.vision) continue;
        if (terms.length) {
          const hay = `${provider.name} ${provider.id} ${model.name} ${model.id}`.toLowerCase();
          if (!terms.every((t) => hay.includes(t))) continue;
        }
        out.push({ provider, model });
        if (out.length >= MAX_ROWS) return out;
      }
    }
    return out;
  }, [providers, query, filters]);

  useEffect(() => setActive(0), [query, filters]);
  useEffect(() => {
    list.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (row: { provider: ProviderInfo; model: ProviderModel } | undefined) => {
    if (!row) return;
    onChange({ provider: row.provider.id, modelId: row.model.id });
    setOpen(false);
  };

  const toggleFilter = (key: keyof typeof filters) => {
    setFilters((f) => ({ ...f, [key]: !f[key] }));
    search.current?.focus();
  };

  let lastProvider = "";
  return (
    <>
      <button
        ref={anchor}
        id={id}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "group flex h-12 w-full items-center gap-3 rounded-lg border bg-field px-2.5 text-left shadow-xs transition-[border-color,box-shadow] hover:border-border-strong focus-visible:border-accent-line/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus disabled:cursor-default disabled:opacity-60",
          open ? "border-accent-line/60 ring-[3px] ring-focus" : "border-border",
        )}
      >
        {current ? (
          <>
            <ProviderMark id={current.provider.id} name={current.provider.name} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13.5px] font-medium text-fg">{current.model.name}</span>
                <Capabilities model={current.model} />
              </span>
              <span className="block truncate font-mono text-[11px] text-faint">
                {current.provider.id}/{current.model.id}
              </span>
            </span>
            <span className="hidden shrink-0 text-right font-mono text-[10.5px] leading-tight text-faint sm:block">
              <span className="block text-subtle">{contextWindow(current.model.contextWindow)} ctx</span>
              <span className="block">
                {perMillion(current.model.cost.input)} / {perMillion(current.model.cost.output)}
              </span>
            </span>
            {!current.provider.configured && <TriangleAlert className="size-4 shrink-0 text-warning" aria-label="Provider not connected" />}
          </>
        ) : value ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted">
            {value.provider}/{value.modelId}
          </span>
        ) : (
          <span className="flex-1 text-[13.5px] text-faint">Choose a model…</span>
        )}
        <ChevronsUpDown className="size-4 shrink-0 text-subtle transition-colors group-hover:text-fg" />
      </button>
      {current && !current.provider.configured && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-warning">
          <TriangleAlert className="size-3.5" />
          {current.provider.name} isn't connected.
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => navigate("/providers")}>
            Connect it
          </button>
        </p>
      )}

      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} matchWidth className="flex flex-col !p-0">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-faint" />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(rows.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(rows[active]);
              }
            }}
            placeholder="Search 40+ providers and their models…"
            aria-label="Search models"
            className="h-11 min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-faint"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
          <span className="label-mono mr-1 text-faint">Only</span>
          {(
            [
              ["reasoning", "Thinking", Brain],
              ["vision", "Vision", Eye],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filters[key]}
              onClick={() => toggleFilter(key)}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors",
                filters[key] ? "border-border-strong bg-surface-3 text-fg" : "border-border text-subtle hover:border-border-strong hover:text-fg",
              )}
            >
              <Icon className="size-3" />
              {label}
            </button>
          ))}
          <span className="ml-auto font-mono text-[10.5px] text-faint">{rows.length >= MAX_ROWS ? `${MAX_ROWS}+` : num(rows.length)} models</span>
        </div>
        <div ref={list} role="listbox" aria-label="Models" className="max-h-[min(400px,52vh)] min-h-0 overflow-y-auto p-1">
          {!providers ? (
            <div className="grid place-items-center py-8">
              <Spinner />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-subtle">{query ? `No models match “${query}”.` : "No models match these filters."}</p>
          ) : (
            rows.map((row, i) => {
              const header = row.provider.id !== lastProvider;
              lastProvider = row.provider.id;
              const selected = value?.provider === row.provider.id && value.modelId === row.model.id;
              const state = providerState(row.provider);
              return (
                <div key={`${row.provider.id}/${row.model.id}`}>
                  {header && (
                    <div className="sticky top-0 z-[1] -mx-1 flex items-center gap-2 border-b border-border/60 bg-overlay/95 px-3 pb-1.5 pt-2.5 backdrop-blur-md">
                      <ProviderMark id={row.provider.id} name={row.provider.name} size="sm" />
                      <span className="truncate text-[12.5px] font-semibold text-fg">{row.provider.name}</span>
                      <span className={cn("ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]", state.tone === "success" ? "text-success" : "text-faint")}>
                        <span className={cn("size-1.5 rounded-full", state.tone === "success" ? "bg-success" : "bg-faint/60")} />
                        {state.label}
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-row={i}
                    onMouseMove={() => active !== i && setActive(i)}
                    onClick={() => choose(row)}
                    className={cn("mt-px flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors", i === active && "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]")}
                  >
                    <span className="grid w-5 shrink-0 place-items-center">{selected && <Check className="size-3.5 text-fg" strokeWidth={2.5} />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("truncate text-[13px] text-fg", selected && "font-semibold")}>{row.model.name}</span>
                        <Capabilities model={row.model} />
                      </span>
                      <span className="block truncate font-mono text-[11px] text-faint">{row.model.id}</span>
                    </span>
                    <span className="hidden shrink-0 text-right font-mono text-[10.5px] leading-tight sm:block">
                      <span className="block text-subtle">{contextWindow(row.model.contextWindow)} ctx</span>
                      <span className="block text-faint">
                        {perMillion(row.model.cost.input)} / {perMillion(row.model.cost.output)}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })
          )}
          {rows.length >= MAX_ROWS && <p className="px-3 py-2 text-center text-[11.5px] text-faint">Showing the first {MAX_ROWS}. Type to narrow down.</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-border bg-surface/40 px-3 py-2 text-[11px] text-faint">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> choose
          </span>
          <span className="ml-auto truncate">{query ? "Searching every provider" : "Type to search every provider"} · $ per M tokens, in / out</span>
        </div>
      </Popover>
    </>
  );
}
