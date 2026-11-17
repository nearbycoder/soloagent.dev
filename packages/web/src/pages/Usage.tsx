import { useEffect, useState, type ReactNode } from "react";
import { ChartNoAxesColumn, RefreshCw } from "lucide-react";
import type { DailyUsage, Usage as UsageNumbers, UsageSummary } from "@soloagent/client";
import { client } from "../api/client.ts";
import { useAgentMap, useApp } from "../api/store.ts";
import { AgentAvatar, ProviderMark } from "../components/brand.tsx";
import { Button, Card, EmptyState, Page, PageHeader, Segmented, SectionHeader, Skeleton } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { cost, num, pluralize, tokens } from "../lib/format.ts";
import { toast } from "../lib/toast.ts";

const totalTokens = (u: UsageNumbers) => u.input + u.output + u.cacheRead + u.cacheWrite;
const promptTokens = (u: UsageNumbers) => u.input + u.cacheRead + u.cacheWrite;
const cacheShare = (u: UsageNumbers) => (promptTokens(u) ? u.cacheRead / promptTokens(u) : 0);
const pct = (x: number) => `${x >= 0.995 || x === 0 ? Math.round(x * 100) : (x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

type Metric = "cost" | "tokens";

export function Usage() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [daily, setDaily] = useState<DailyUsage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState<Metric | null>(null);
  const activityCount = useApp((s) => s.activity.length);

  const load = async () => {
    setLoading(true);
    try {
      const [summary, days] = await Promise.all([client.usage(), client.dailyUsage(14).catch(() => null)]);
      setUsage(summary);
      setDaily(days);
    } catch (error) {
      toast.error(error, "Could not load usage");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Refresh quietly as new replies come in.
  useEffect(() => {
    if (!usage) return;
    const id = setTimeout(() => {
      void client.usage().then(setUsage).catch(() => {});
      void client.dailyUsage(14).then(setDaily).catch(() => {});
    }, 1500);
    return () => clearTimeout(id);
  }, [activityCount]);

  const effective: Metric = metric ?? (usage && usage.total.cost > 0 ? "cost" : "tokens");
  const value = (u: UsageNumbers) => (effective === "cost" ? u.cost : totalTokens(u));
  const format = (n: number) => (effective === "cost" ? cost(n) : tokens(n));
  const hasDaily = !!daily && daily.some((d) => d.responses > 0);

  return (
    <Page>
      <PageHeader
        eyebrow="Observe"
        title="Usage"
        description="Tokens and spend across every agent and model. Subscription logins report token counts; cost reflects list API prices."
        actions={
          <Button variant="ghost" icon={<RefreshCw className={cn(loading && "animate-spin")} />} onClick={load}>
            Refresh
          </Button>
        }
      />

      {!usage ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[124px] rounded-xl" />
          <Skeleton className="h-[120px] rounded-xl" />
          <Skeleton className="h-[280px] rounded-xl" />
        </div>
      ) : totalTokens(usage.total) === 0 ? (
        <Card>
          <EmptyState icon={<ChartNoAxesColumn />} title="No usage yet" description="Once your agents start answering, tokens and costs show up here, broken down by model and agent." />
        </Card>
      ) : (
        <>
          {/* Totals: one hero figure, three supporting tiles. */}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-card lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
            <div className="relative col-span-2 overflow-hidden bg-surface px-5 py-4 lg:col-span-1">
              <div aria-hidden className="pointer-events-none absolute -left-10 -top-16 hidden size-48 rounded-full bg-accent/10 blur-3xl dark:block" />
              <p className="relative text-[12.5px] text-subtle">Total cost</p>
              <p className="relative mt-1 text-[44px] font-semibold leading-none tracking-[-0.04em] text-fg">{cost(usage.total.cost)}</p>
              <p className="relative mt-2.5 font-mono text-[11px] text-faint">at list API prices · {tokens(totalTokens(usage.total))} tokens</p>
            </div>
            <Tile
              label="Total tokens"
              value={tokens(totalTokens(usage.total))}
              sub={tokens(totalTokens(usage.total)) === num(totalTokens(usage.total)) ? "every model and agent" : `${num(totalTokens(usage.total))} exact`}
            />
            <Tile label="Output tokens" value={tokens(usage.total.output)} sub={`${tokens(promptTokens(usage.total))} prompt tokens`} />
            <Tile label="Cache-read share" value={pct(cacheShare(usage.total))} sub="of prompt tokens from cache" className="col-span-2 lg:col-span-1" />
          </div>

          <Card className="mt-3 p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Where the tokens went</h2>
              <span className="font-mono text-[11px] text-faint">{num(totalTokens(usage.total))} tokens</span>
            </div>
            <TokenMix usage={usage.total} />
          </Card>

          {/* One filter row; it scopes everything below it. */}
          <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="label-mono text-faint">Measure</span>
              <Segmented<Metric>
                size="sm"
                value={effective}
                onChange={setMetric}
                options={[
                  { value: "cost", label: "Cost" },
                  { value: "tokens", label: "Tokens" },
                ]}
              />
            </div>
            {hasDaily && <span className="font-mono text-[11px] text-faint">Last 14 days · UTC</span>}
          </div>

          {hasDaily && (
            <Card className="mt-3 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">{effective === "cost" ? "Spend" : "Tokens"} per day</h2>
                <span className="flex items-center gap-1.5 text-[12px] text-subtle">
                  <span className="h-2.5 w-1.5 rounded-t-[2px] bg-accent-line" />
                  Today
                </span>
              </div>
              <DailyColumns days={daily!} value={value} format={format} metric={effective} />
            </Card>
          )}

          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <section className="min-w-0">
              <SectionHeader title="By model" description={`Ranked by ${effective === "cost" ? "spend" : "tokens"}.`} />
              <Card className="p-1.5">
                <BarList
                  rows={usage.byModel
                    .map((m) => ({ key: m.model, usage: m.usage }))
                    .sort((a, b) => value(b.usage) - value(a.usage))
                    .map((r) => {
                      const [provider, ...rest] = r.key.split("/");
                      return {
                        key: r.key,
                        label: (
                          <span className="flex min-w-0 items-center gap-2.5">
                            <ProviderMark id={provider ?? ""} name={provider ?? "?"} size="sm" />
                            <span className="min-w-0 truncate font-mono text-[12.5px] text-fg">{rest.join("/") || r.key}</span>
                          </span>
                        ),
                        sub: provider,
                        usage: r.usage,
                      };
                    })}
                  value={value}
                  format={format}
                />
              </Card>
            </section>
            <section className="min-w-0">
              <SectionHeader title="By agent" description={`Ranked by ${effective === "cost" ? "spend" : "tokens"}.`} />
              <Card className="p-1.5">
                <AgentBars usage={usage} value={value} format={format} />
              </Card>
            </section>
          </div>
        </>
      )}
    </Page>
  );
}

function Tile({ label, value, sub, className }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col bg-surface px-5 py-4", className)}>
      <p className="text-[12.5px] text-subtle">{label}</p>
      <p className="mt-1.5 text-[26px] font-semibold leading-tight tracking-[-0.03em] text-fg">{value}</p>
      {sub && <p className="mt-auto truncate pt-1 font-mono text-[11px] text-faint">{sub}</p>}
    </div>
  );
}

const MIX = [
  { key: "input", label: "Input", color: "var(--series-1)" },
  { key: "output", label: "Output", color: "var(--series-2)" },
  { key: "cacheRead", label: "Cache read", color: "var(--series-3)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--series-4)" },
] as const;
type MixKey = (typeof MIX)[number]["key"];

/**
 * One whole split into its parts: a thin segmented bar (2px surface gaps, rounded ends, no text) over a legend that
 * carries every value. Hovering or focusing a part lifts it and its legend entry.
 */
function TokenMix({ usage }: { usage: UsageNumbers }) {
  const [active, setActive] = useState<MixKey | null>(null);
  const total = totalTokens(usage) || 1;
  const parts = MIX.map((m) => ({ ...m, value: usage[m.key] })).filter((p) => p.value > 0);
  return (
    <div className="mt-4" onMouseLeave={() => setActive(null)}>
      <div className="flex h-2 w-full gap-[2px]" role="list" aria-label="Tokens by type">
        {parts.map((p, i) => (
          <div
            key={p.key}
            role="listitem"
            tabIndex={0}
            aria-label={`${p.label}: ${num(p.value)} tokens, ${pct(p.value / total)}`}
            title={`${p.label}: ${num(p.value)} tokens (${pct(p.value / total)})`}
            onMouseEnter={() => setActive(p.key)}
            onFocus={() => setActive(p.key)}
            onBlur={() => setActive(null)}
            className={cn(
              "h-full min-w-[3px] outline-offset-2 transition-opacity duration-150",
              i === 0 && "rounded-l-full",
              i === parts.length - 1 && "rounded-r-full",
              active && active !== p.key && "opacity-35",
            )}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
          />
        ))}
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {MIX.map((m) => (
          <div
            key={m.key}
            className={cn("min-w-0 transition-opacity duration-150", active && active !== m.key && "opacity-40")}
            onMouseEnter={() => usage[m.key] > 0 && setActive(m.key)}
          >
            <dt className="flex items-center gap-2 text-[12px] text-subtle">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: m.color }} />
              {m.label}
            </dt>
            <dd className="mt-1 pl-[18px]">
              <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{tokens(usage[m.key])}</span>{" "}
              <span className="font-mono text-[11px] text-faint">{pct(usage[m.key] / total)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AgentBars({ usage, value, format }: { usage: UsageSummary; value: (u: UsageNumbers) => number; format: (n: number) => string }) {
  const agentMap = useAgentMap();
  return (
    <BarList
      rows={[...usage.byAgent]
        .sort((a, b) => value(b.usage) - value(a.usage))
        .map((row) => {
          const agent = agentMap.get(row.agentId);
          return {
            key: row.agentId,
            label: (
              <span className="flex min-w-0 items-center gap-2.5">
                <AgentAvatar agent={agent} size="sm" />
                <span className="truncate text-[13px] font-medium text-fg">{agent?.name ?? "Deleted agent"}</span>
              </span>
            ),
            sub: pluralize(row.threads, "thread"),
            usage: row.usage,
          };
        })}
      value={value}
      format={format}
    />
  );
}

/** Clean axis steps: 1, 2, 2.5, 5 × 10ⁿ. */
function niceCeil(x: number): number {
  if (x <= 0) return 0;
  const base = 10 ** Math.floor(Math.log10(x));
  const f = x / base;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * base;
}

const compactAxis = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Axis labels, one style per axis: "$0", "$0.025", "$1.5"; "0", "2,500", "5,000" — or "0", "10K", "20K" once it reaches 10K. */
function axisLabel(v: number, metric: Metric, top: number): string {
  if (metric === "tokens") return top >= 10_000 ? compactAxis.format(v) : num(v);
  if (v === 0) return "$0";
  const digits = v >= 10 ? 0 : v >= 1 ? 1 : Math.min(4, Math.max(2, -Math.floor(Math.log10(v)) + 1));
  return `$${v.toFixed(digits).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")}`;
}

/**
 * One column per UTC day, a single measure: past days in a quiet neutral, today in lime. Values on hover and focus
 * (value first), a direct label on today's cap and on the peak, and a table for screen readers.
 */
function DailyColumns({ days, value, format, metric }: { days: DailyUsage[]; value: (u: UsageNumbers) => number; format: (n: number) => string; metric: Metric }) {
  const [active, setActive] = useState<number | null>(null);
  const values = days.map((d) => value(d.usage));
  const max = Math.max(...values, 0);
  const top = niceCeil(max) || 1;
  const ticks = [0, top / 2, top];
  const today = days.length - 1;
  const peak = values.indexOf(max);
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const shown = active !== null ? days[active] : undefined;
  const height = (v: number) => (v > 0 ? Math.max(1.5, (v / top) * 100) : 0);

  return (
    <div className="mt-5">
      <div className="flex">
        {/* Y axis */}
        <div className="relative h-48 w-14 shrink-0" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-3 translate-y-1/2 font-mono text-[10.5px] tabular-nums text-faint" style={{ bottom: `${(t / top) * 100}%` }}>
              {axisLabel(t, metric, top)}
            </span>
          ))}
        </div>
        {/* Plot */}
        <div className="relative h-48 min-w-0 flex-1" onMouseLeave={() => setActive(null)}>
          {ticks.map((t, i) => (
            <div key={t} aria-hidden className={cn("absolute inset-x-0 h-px", i === 0 ? "bg-border-strong" : "bg-border")} style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end" role="list" aria-label={`${metric === "cost" ? "Spend" : "Tokens"} per day`}>
            {days.map((d, i) => {
              const v = values[i]!;
              const isToday = i === today;
              const labelled = v > 0 && (isToday || i === peak);
              return (
                <div
                  key={d.day}
                  role="listitem"
                  tabIndex={0}
                  aria-label={`${isToday ? "Today" : label(d.day)}: ${format(v)}, ${pluralize(d.responses, "response")}`}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="group relative flex h-full flex-1 cursor-default items-end justify-center outline-offset-[-2px]"
                >
                  {active === i && <div aria-hidden className="absolute inset-x-0.5 inset-y-0 rounded-md bg-surface-2/70" />}
                  <div
                    className={cn(
                      "relative w-[min(24px,62%)] rounded-t-[4px] transition-colors duration-150",
                      isToday
                        ? "bg-accent-line shadow-[0_0_18px_-4px_var(--accent-glow)] group-hover:bg-accent-hover"
                        : "bg-[var(--fg-faint)] group-hover:bg-[var(--fg-subtle)]",
                    )}
                    style={{ height: `${height(v)}%` }}
                  >
                    {labelled && active === null && (
                      <span className="absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap font-mono text-[10.5px] font-medium text-fg">{format(v)}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {shown && active !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-10 w-44 -translate-x-1/2 rounded-lg border border-border-strong bg-overlay/95 px-3 py-2.5 shadow-lg backdrop-blur-xl"
              style={{
                left: `clamp(88px, ${((active + 0.5) / days.length) * 100}%, calc(100% - 88px))`,
                bottom: `calc(${Math.min(height(values[active]!), 72)}% + 12px)`,
              }}
            >
              <p className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{format(values[active]!)}</p>
              <p className="mt-0.5 text-[11.5px] text-subtle">{active === today ? "Today" : label(shown.day)}</p>
              <div className="mt-2 space-y-0.5 border-t border-border pt-2 font-mono text-[11px] text-faint">
                <p className="flex justify-between">
                  {metric === "cost" ? "tokens" : "spend"} <span className="text-muted">{metric === "cost" ? tokens(totalTokens(shown.usage)) : cost(shown.usage.cost)}</span>
                </p>
                <p className="flex justify-between">
                  responses <span className="text-muted">{num(shown.responses)}</span>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* X axis */}
      <div className="ml-14 mt-2 flex justify-between font-mono text-[10.5px] text-faint" aria-hidden>
        <span>{label(days[0]!.day)}</span>
        {days.length > 8 && <span>{label(days[Math.floor((days.length - 1) / 2)]!.day)}</span>}
        <span className="text-subtle">Today</span>
      </div>
      <table className="sr-only">
        <caption>Usage per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Spend</th>
            <th>Tokens</th>
            <th>Responses</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{cost(d.usage.cost)}</td>
              <td>{num(totalTokens(d.usage))}</td>
              <td>{d.responses}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One ranked bar: the leader in lime (the emphasis), everyone else in a quiet neutral. */
function RankBar({ value, max, emphasis, label }: { value: number; max: number; emphasis: boolean; label: string }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div
        className={cn("h-full rounded-full transition-[width] duration-500 ease-out", emphasis ? "bg-accent-line shadow-[0_0_10px_-2px_var(--accent-glow)]" : "bg-[var(--fg-subtle)]")}
        style={{ width: `${value > 0 ? Math.max(1.5, share * 100) : 0}%` }}
      />
    </div>
  );
}

/** Ranked horizontal bars for one measure: values and shares as text, the leader emphasized, details on hover. */
function BarList({
  rows,
  value,
  format,
}: {
  rows: { key: string; label: ReactNode; sub?: string; usage: UsageNumbers }[];
  value: (u: UsageNumbers) => number;
  format: (n: number) => string;
}) {
  if (rows.length === 0) return <p className="px-3 py-8 text-center text-[13px] text-subtle">No data yet.</p>;
  const max = Math.max(...rows.map((r) => value(r.usage)), 0) || 1;
  const sum = rows.reduce((acc, r) => acc + value(r.usage), 0) || 1;
  return (
    <ul className="flex flex-col">
      {rows.map((row, i) => {
        const v = value(row.usage);
        const u = row.usage;
        const detail = `Input ${num(u.input)} · Output ${num(u.output)} · Cache read ${num(u.cacheRead)} · Cache write ${num(u.cacheWrite)} · ${cost(u.cost)}`;
        return (
          <li key={row.key} title={detail} className="rounded-lg px-3 py-3 transition-colors hover:bg-surface-2/60">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">{row.label}</div>
              <span className="shrink-0 font-mono text-[12.5px] font-medium tabular-nums text-fg">{format(v)}</span>
            </div>
            <RankBar value={v} max={max} emphasis={i === 0 && v > 0} label={`${format(v)}, ${pct(v / sum)} of the total`} />
            <div className="mt-1.5 flex items-center justify-between gap-3 font-mono text-[10.5px] text-faint">
              <span className="truncate">
                {row.sub ? `${row.sub} · ` : ""}
                {pct(cacheShare(u))} cached
              </span>
              <span className="shrink-0 tabular-nums">{pct(v / sum)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
