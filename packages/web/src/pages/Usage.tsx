import { useEffect, useState, type ReactNode } from "react";
import { ChartNoAxesColumn, RefreshCw } from "lucide-react";
import type { Usage as UsageNumbers, UsageSummary } from "@soloagent/client";
import { client } from "../api/client.ts";
import { useAgentMap, useApp } from "../api/store.ts";
import { AgentAvatar, ProviderMark } from "../components/brand.tsx";
import { Button, Card, EmptyState, Page, PageHeader, Segmented, SectionHeader, Skeleton } from "../components/ui.tsx";
import { cost, num, pluralize, tokens } from "../lib/format.ts";
import { toast } from "../lib/toast.ts";

const totalTokens = (u: UsageNumbers) => u.input + u.output + u.cacheRead + u.cacheWrite;
const promptTokens = (u: UsageNumbers) => u.input + u.cacheRead + u.cacheWrite;
const cacheShare = (u: UsageNumbers) => (promptTokens(u) ? u.cacheRead / promptTokens(u) : 0);
const pct = (x: number) => `${x >= 0.995 || x === 0 ? Math.round(x * 100) : (x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

type Metric = "cost" | "tokens";

export function Usage() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [metric, setMetric] = useState<Metric | null>(null);
  const activityCount = useApp((s) => s.activity.length);

  const load = async () => {
    setLoading(true);
    try {
      setUsage(await client.usage());
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
    const id = setTimeout(() => void client.usage().then(setUsage).catch(() => {}), 1500);
    return () => clearTimeout(id);
  }, [activityCount]);

  const effective: Metric = metric ?? (usage && usage.total.cost > 0 ? "cost" : "tokens");
  const value = (u: UsageNumbers) => (effective === "cost" ? u.cost : totalTokens(u));
  const format = (n: number) => (effective === "cost" ? cost(n) : tokens(n));

  return (
    <Page>
      <PageHeader
        title="Usage"
        description="Tokens and spend across every agent and model. Subscription logins report token counts; cost reflects list API prices."
        actions={
          <Button variant="ghost" icon={<RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />} onClick={load}>
            Refresh
          </Button>
        }
      />

      {!usage ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[104px] rounded-xl" />
          ))}
        </div>
      ) : totalTokens(usage.total) === 0 ? (
        <Card>
          <EmptyState icon={<ChartNoAxesColumn />} title="No usage yet" description="Once your agents start answering, tokens and costs show up here, broken down by model and agent." />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Total cost" value={cost(usage.total.cost)} sub="at list API prices" hero />
            <Tile label="Total tokens" value={tokens(totalTokens(usage.total))} sub={`${num(totalTokens(usage.total))} exact`} />
            <Tile label="Output tokens" value={tokens(usage.total.output)} sub={`${tokens(promptTokens(usage.total))} prompt tokens`} />
            <Tile label="Cache-read share" value={pct(cacheShare(usage.total))} sub="of prompt tokens served from cache" />
          </div>

          <Card className="mt-3 p-5">
            <h2 className="text-[13px] font-semibold text-fg">Where the tokens went</h2>
            <TokenMix usage={usage.total} />
          </Card>

          <div className="mt-10 flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight text-fg">Breakdown</h2>
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

          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <section>
              <SectionHeader title="By model" />
              <Card className="p-2">
                <BarList
                  rows={usage.byModel
                    .map((m) => ({ key: m.model, usage: m.usage }))
                    .sort((a, b) => value(b.usage) - value(a.usage))
                    .map((r) => {
                      const [provider, ...rest] = r.key.split("/");
                      return {
                        key: r.key,
                        label: (
                          <span className="flex min-w-0 items-center gap-2">
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
            <section>
              <SectionHeader title="By agent" />
              <Card className="p-2">
                <AgentBars usage={usage} value={value} format={format} />
              </Card>
            </section>
          </div>
        </>
      )}
    </Page>
  );
}

function Tile({ label, value, sub, hero }: { label: string; value: string; sub?: string; hero?: boolean }) {
  return (
    <Card className="relative overflow-hidden p-4">
      {hero && <div className="pointer-events-none absolute -right-8 -top-8 size-24 rounded-full bg-accent/15 blur-2xl" />}
      <p className="relative text-[12.5px] font-medium text-subtle">{label}</p>
      <p className="relative mt-2 text-[26px] font-semibold tabular-nums tracking-[-0.02em] text-fg">{value}</p>
      {sub && <p className="relative mt-0.5 truncate text-[12px] text-faint">{sub}</p>}
    </Card>
  );
}

const MIX = [
  { key: "input", label: "Input", color: "var(--series-1)" },
  { key: "output", label: "Output", color: "var(--series-2)" },
  { key: "cacheRead", label: "Cache read", color: "var(--series-3)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--series-4)" },
] as const;

/** One stacked bar of token types, 2px surface gaps between segments, with a labeled legend. */
function TokenMix({ usage }: { usage: UsageNumbers }) {
  const total = totalTokens(usage) || 1;
  const parts = MIX.map((m) => ({ ...m, value: usage[m.key] })).filter((p) => p.value > 0);
  return (
    <div className="mt-4">
      <div className="flex h-3 w-full gap-[2px]" role="img" aria-label={parts.map((p) => `${p.label} ${pct(p.value / total)}`).join(", ")}>
        {parts.map((p, i) => (
          <div
            key={p.key}
            title={`${p.label}: ${num(p.value)} tokens (${pct(p.value / total)})`}
            className="h-full min-w-[3px] transition-opacity hover:opacity-80"
            style={{
              width: `${(p.value / total) * 100}%`,
              background: p.color,
              borderRadius: `${i === 0 ? 4 : 1}px ${i === parts.length - 1 ? 4 : 1}px ${i === parts.length - 1 ? 4 : 1}px ${i === 0 ? 4 : 1}px`,
            }}
          />
        ))}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {MIX.map((m) => (
          <div key={m.key} className="min-w-0">
            <dt className="flex items-center gap-2 text-[12px] text-subtle">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: m.color }} />
              {m.label}
            </dt>
            <dd className="mt-0.5 pl-[18px] text-[14px] font-medium tabular-nums text-fg">
              {tokens(usage[m.key])} <span className="text-[12px] font-normal text-faint">{pct(usage[m.key] / total)}</span>
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
              <span className="flex min-w-0 items-center gap-2">
                <AgentAvatar agent={agent} size="sm" />
                <span className="truncate text-[13px] text-fg">{agent?.name ?? "Deleted agent"}</span>
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

/** Ranked horizontal bars for one measure: a single hue, values as text, details on hover. */
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
  return (
    <ul className="flex flex-col">
      {rows.map((row) => {
        const v = value(row.usage);
        const u = row.usage;
        const detail = `Input ${num(u.input)} · Output ${num(u.output)} · Cache read ${num(u.cacheRead)} · Cache write ${num(u.cacheWrite)} · ${cost(u.cost)}`;
        return (
          <li key={row.key} title={detail} className="group rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2/60">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">{row.label}</div>
              <span className="shrink-0 text-[13px] font-medium tabular-nums text-fg">{format(v)}</span>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(v > 0 ? 1.5 : 0, (v / max) * 100)}%` }} />
              </div>
              <span className="w-40 shrink-0 truncate text-right text-[11.5px] text-faint">
                {row.sub ? `${row.sub} · ` : ""}
                {pct(cacheShare(u))} cached
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
