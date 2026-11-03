import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, Check, ChevronsUpDown, Eye, Search, TriangleAlert } from "lucide-react";
import type { ModelRef, ProviderInfo, ProviderModel } from "@soloagent/client";
import { loadProviders, useApp } from "../api/store.ts";
import { cn } from "../lib/cn.ts";
import { contextWindow, perMillion } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { ProviderMark } from "./brand.tsx";
import { Popover } from "./overlay.tsx";
import { Spinner } from "./ui.tsx";

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

export function ModelPicker({ value, onChange, id }: { value: ModelRef | null; onChange: (value: ModelRef) => void; id?: string }) {
  const providers = useApp((s) => s.providers);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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
        if (terms.length) {
          const hay = `${provider.name} ${provider.id} ${model.name} ${model.id}`.toLowerCase();
          if (!terms.every((t) => hay.includes(t))) continue;
        }
        out.push({ provider, model });
        if (out.length >= MAX_ROWS) return out;
      }
    }
    return out;
  }, [providers, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (row: { provider: ProviderInfo; model: ProviderModel } | undefined) => {
    if (!row) return;
    onChange({ provider: row.provider.id, modelId: row.model.id });
    setOpen(false);
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
        className="flex h-11 w-full items-center gap-3 rounded-lg border border-border bg-surface-2/60 px-2.5 text-left transition-[border-color,box-shadow] hover:border-border-strong focus-visible:border-accent-line/70 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-line/15"
      >
        {current ? (
          <>
            <ProviderMark id={current.provider.id} name={current.provider.name} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-fg">{current.model.name}</span>
              <span className="block truncate font-mono text-[11px] text-subtle">
                {current.provider.id}/{current.model.id}
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
        <ChevronsUpDown className="size-4 shrink-0 text-subtle" />
      </button>
      {current && !current.provider.configured && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-warning">
          {current.provider.name} isn't connected.
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => navigate("/providers")}>
            Connect it
          </button>
        </p>
      )}

      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} matchWidth className="!p-0">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 text-faint" />
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
            placeholder="Search 40+ providers and thousands of models…"
            className="h-10 min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none"
          />
        </div>
        <div ref={list} role="listbox" className="max-h-[min(420px,55vh)] overflow-y-auto p-1">
          {!providers ? (
            <div className="grid place-items-center py-8">
              <Spinner />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-subtle">No models match “{query}”.</p>
          ) : (
            rows.map((row, i) => {
              const header = row.provider.id !== lastProvider;
              lastProvider = row.provider.id;
              const selected = value?.provider === row.provider.id && value.modelId === row.model.id;
              return (
                <div key={`${row.provider.id}/${row.model.id}`}>
                  {header && (
                    <div className="sticky top-0 z-[1] flex items-center gap-2 bg-overlay/95 px-2 pb-1 pt-2.5 backdrop-blur">
                      <ProviderMark id={row.provider.id} name={row.provider.name} size="sm" />
                      <span className="text-[12px] font-semibold text-fg">{row.provider.name}</span>
                      {row.provider.configured ? (
                        <span className="text-[11px] text-success">{row.provider.configured.type === "oauth" ? "subscription" : row.provider.configured.source === "built-in" ? "built-in" : "connected"}</span>
                      ) : (
                        <span className="text-[11px] text-faint">not connected</span>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-row={i}
                    onMouseMove={() => active !== i && setActive(i)}
                    onClick={() => choose(row)}
                    className={cn("flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left", i === active && "bg-surface-2")}
                  >
                    <span className="grid w-6 shrink-0 place-items-center">{selected && <Check className="size-3.5 text-accent-text" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] text-fg">{row.model.name}</span>
                        {row.model.reasoning && <Brain className="size-3 shrink-0 text-accent-text" aria-label="Reasoning" />}
                        {row.model.vision && <Eye className="size-3 shrink-0 text-info" aria-label="Vision" />}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-faint">{row.model.id}</span>
                    </span>
                    <span className="hidden shrink-0 text-right font-mono text-[11px] leading-tight text-subtle sm:block">
                      <span className="block">{contextWindow(row.model.contextWindow)} ctx</span>
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
          {!query && providers && <p className="px-3 py-2 text-center text-[11.5px] text-faint">Type to search every provider. Prices are $ per million tokens (in / out).</p>}
        </div>
      </Popover>
    </>
  );
}
