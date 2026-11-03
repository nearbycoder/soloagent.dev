import { useEffect, useMemo, useState } from "react";
import { Bot, Brain, Eye, MessageSquare, Pencil, Plus, ShieldAlert, Star, Trash, TriangleAlert } from "lucide-react";
import { AGENT_SKILLS, type Agent, type AgentBudget, type AgentInput, type AgentSkill, type AgentSpend, type ThinkingLevel } from "@soloagent/client";
import { client } from "../api/client.ts";
import { loadProviders, local, useApp, useIsAdmin } from "../api/store.ts";
import { AgentAvatar, ProviderMark } from "../components/brand.tsx";
import { findModel, ModelPicker } from "../components/ModelPicker.tsx";
import { Drawer } from "../components/overlay.tsx";
import { Badge, Button, Card, EmptyState, Field, Input, Page, PageHeader, Segmented, Skeleton, Switch, Textarea } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { contextWindow, cost, perMillion, slugify } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { confirm, toast } from "../lib/toast.ts";

export const GLYPHS = ["●", "◆", "✦", "▲", "■", "★", "⚡", "λ", "∞", "§", "☾", "☀", "✿", "⌘", "♪", "❖"];
export const EMOJI = ["🤖", "🧠", "🦊", "🐙", "🦉", "🚀", "🔮", "🧪", "📚", "🛠️", "🎨", "💼", "🧭", "🌱", "🐝", "🍀"];
export const COLORS = ["#9cbf10", "#3b82f6", "#0ea5e9", "#14b8a6", "#10b981", "#65a30d", "#eab308", "#f59e0b", "#f97316", "#f43f5e", "#ec4899", "#78716c"];
const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function Agents({ editId }: { editId?: string }) {
  const agents = useApp((s) => s.agents);
  const providers = useApp((s) => s.providers);
  const threads = useApp((s) => s.threads);
  const isAdmin = useIsAdmin();
  const spend = useSpendToday();

  useEffect(() => {
    void loadProviders();
  }, []);

  const editing = editId === "new" ? null : agents?.find((a) => a.id === editId);
  const drawerOpen = (editId === "new" && isAdmin) || !!editing;

  return (
    <Page wide>
      <PageHeader
        title="Agents"
        description="Each agent has its own instructions, model, and skills. Mention them by @handle anywhere they're connected."
        actions={
          isAdmin && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/agents/new")}>
              New agent
            </Button>
          )
        }
      />

      {!agents ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[196px] rounded-xl" />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bot />}
            title="No agents yet"
            description="Agents answer in chat, Slack, Discord, and Telegram. Create your first one."
            action={
              isAdmin && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/agents/new")}>
                  Create agent
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => {
            const found = findModel(providers, agent.model);
            const count = threads?.filter((t) => t.agentId === agent.id).length ?? 0;
            return (
              <Card
                key={agent.id}
                interactive
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/agents/${agent.id}`)}
                onKeyDown={(e) => e.key === "Enter" && navigate(`/agents/${agent.id}`)}
                className="group relative flex cursor-pointer flex-col overflow-hidden p-5"
              >
                <div className="pointer-events-none absolute inset-x-0 top-0 h-20 opacity-60" style={{ background: `linear-gradient(180deg, color-mix(in srgb, ${agent.color} 12%, transparent), transparent)` }} />
                <div className="relative flex items-start gap-3.5">
                  <AgentAvatar agent={agent} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="truncate text-[15px] font-semibold tracking-tight text-fg">{agent.name}</h3>
                      {agent.isDefault && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label="Default agent" />}
                    </div>
                    <p className="truncate font-mono text-[12px] text-subtle">@{agent.handle}</p>
                  </div>
                  {isAdmin ? (
                    <Pencil className="size-3.5 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                  ) : (
                    <Eye className="size-3.5 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </div>
                <p className="relative mt-3 line-clamp-2 min-h-[3.25em] text-[13px] leading-relaxed text-muted">{agent.description || "No description."}</p>
                <div className="relative mt-4 flex items-center gap-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-2">
                  {agent.model ? (
                    <>
                      <ProviderMark id={agent.model.provider} name={found?.provider.name ?? agent.model.provider} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{found?.model.name ?? agent.model.modelId}</span>
                      {agent.thinkingLevel !== "off" && (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-subtle" title={`Thinking: ${agent.thinkingLevel}`}>
                          <Brain className="size-3" />
                          {agent.thinkingLevel}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-[12.5px] text-warning">No model selected</span>
                  )}
                </div>
                <div className="relative mt-3 flex flex-wrap gap-1">
                  {agent.skills.length === 0 && <span className="text-[12px] text-faint">No skills</span>}
                  {agent.skills.map((skill) => (
                    <Badge key={skill} tone={skill === "workspace" ? "warning" : "neutral"}>
                      {AGENT_SKILLS.find((s) => s.id === skill)?.label ?? skill}
                    </Badge>
                  ))}
                </div>
                <SpendMeter spend={spend?.find((s) => s.agentId === agent.id)} budget={agent.budget} className="relative mt-3" />
                <div className="relative mt-4 flex items-center justify-between border-t border-border pt-3">
                  <span className="text-[12px] text-faint">{count === 1 ? "1 thread" : `${count} threads`}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<MessageSquare className="size-3.5" />}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/chat/new/${agent.id}`);
                    }}
                  >
                    Chat
                  </Button>
                </div>
              </Card>
            );
          })}
          {isAdmin && (
            <button
              type="button"
              onClick={() => navigate("/agents/new")}
              className="flex min-h-[196px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-subtle transition-colors hover:border-accent-line/50 hover:bg-accent-soft hover:text-accent-text"
            >
              <Plus className="size-5" />
              <span className="text-[13px] font-medium">New agent</span>
            </button>
          )}
        </div>
      )}

      {drawerOpen && <AgentEditor key={editId} agent={editing ?? null} readOnly={!isAdmin} spend={spend?.find((s) => s.agentId === editing?.id)} onClose={() => navigate("/agents")} />}
      {editId && editId !== "new" && agents && !editing && <MissingAgent />}
    </Page>
  );
}

function MissingAgent() {
  useEffect(() => {
    toast.info("That agent no longer exists");
    navigate("/agents", { replace: true });
  }, []);
  return null;
}

type Draft = Required<Omit<AgentInput, "model" | "budget">> & { model: AgentInput["model"]; budget: AgentBudget };

function toDraft(agent: Agent | null, defaultModel: Agent["model"]): Draft {
  return {
    name: agent?.name ?? "",
    handle: agent?.handle ?? "",
    avatar: agent?.avatar ?? "●",
    color: agent?.color ?? COLORS[Math.floor(Math.random() * COLORS.length)]!,
    description: agent?.description ?? "",
    instructions: agent?.instructions ?? "",
    model: agent ? agent.model : defaultModel,
    thinkingLevel: agent?.thinkingLevel ?? "medium",
    skills: agent?.skills ?? ["memory", "web", "delegate", "schedule"],
    maxTurns: agent?.maxTurns ?? 40,
    isDefault: agent?.isDefault ?? false,
    budget: agent?.budget ?? { dailyUsd: null, dailyRuns: null },
    chatAccess: agent?.chatAccess ?? false,
  };
}

/** Today's spend per agent, refreshed as replies come in. */
function useSpendToday(): AgentSpend[] | null {
  const [spend, setSpend] = useState<AgentSpend[] | null>(null);
  const activityCount = useApp((s) => s.activity.length);
  useEffect(() => {
    const id = setTimeout(() => void client.spendToday().then(setSpend).catch(() => {}), spend ? 1500 : 0);
    return () => clearTimeout(id);
  }, [activityCount]);
  return spend;
}

/** "$0.42 today", with a bar against the daily budget when there is one. */
function SpendMeter({ spend, budget, className }: { spend: AgentSpend | undefined; budget: AgentBudget; className?: string }) {
  const usd = spend?.usd ?? 0;
  const runs = spend?.runs ?? 0;
  const parts: { label: string; ratio: number | null }[] = [
    { label: budget.dailyUsd !== null ? `${cost(usd)} of ${cost(budget.dailyUsd)}` : `${cost(usd)}`, ratio: budget.dailyUsd ? usd / budget.dailyUsd : budget.dailyUsd === 0 ? 1 : null },
  ];
  if (budget.dailyRuns !== null) parts.push({ label: `${runs} of ${budget.dailyRuns} messages`, ratio: budget.dailyRuns ? runs / budget.dailyRuns : 1 });
  const ratio = Math.max(0, ...parts.map((p) => p.ratio ?? 0));
  const limited = parts.some((p) => p.ratio !== null);
  return (
    <div className={cn("flex flex-col gap-1.5", className)} title="Today, UTC">
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className="text-subtle">Today</span>
        <span className={cn("tabular-nums", ratio >= 1 ? "font-medium text-danger" : "text-muted")}>{parts.map((p) => p.label).join(" · ")}</span>
      </div>
      {limited && (
        <div className="h-1 overflow-hidden rounded-full bg-surface-3">
          <div className={cn("h-full rounded-full", ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-accent")} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/** A number input where empty means "no limit". */
function LimitInput({ id, value, onChange, step, prefix, disabled }: { id: string; value: number | null; onChange: (value: number | null) => void; step: string; prefix?: string; disabled?: boolean }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  return (
    <div className="relative">
      {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-faint">{prefix}</span>}
      <Input
        id={id}
        type="number"
        min={0}
        step={step}
        inputMode="decimal"
        placeholder="No limit"
        disabled={disabled}
        value={text}
        className={prefix ? "pl-6" : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          onChange(e.target.value.trim() === "" || !Number.isFinite(n) || n < 0 ? null : n);
        }}
      />
    </div>
  );
}

function AgentEditor({ agent, readOnly, spend, onClose }: { agent: Agent | null; readOnly: boolean; spend: AgentSpend | undefined; onClose: () => void }) {
  const agents = useApp((s) => s.agents) ?? [];
  const providers = useApp((s) => s.providers);
  const defaultModel = agents.find((a) => a.isDefault)?.model ?? null;
  const [draft, setDraft] = useState<Draft>(() => toDraft(agent, defaultModel));
  const [handleTouched, setHandleTouched] = useState(!!agent);
  const [saving, setSaving] = useState(false);
  const [customGlyph, setCustomGlyph] = useState("");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const handleError = useMemo(() => {
    if (!draft.handle) return "Required";
    if (!/^[a-z0-9-]+$/.test(draft.handle)) return "Lowercase letters, digits, and dashes only";
    if (agents.some((a) => a.handle === draft.handle && a.id !== agent?.id)) return "Another agent already uses this handle";
    return null;
  }, [draft.handle, agents, agent]);
  const nameError = draft.name.trim() ? null : "Required";
  const model = findModel(providers, draft.model ?? null);

  const save = async () => {
    if (nameError || handleError) return;
    setSaving(true);
    try {
      const input: AgentInput = { ...draft, name: draft.name.trim(), maxTurns: Math.max(1, Math.min(500, Math.round(draft.maxTurns) || 40)) };
      const saved = agent ? await client.updateAgent(agent.id, input) : await client.createAgent(input);
      local.agent(saved);
      toast.success(agent ? "Agent saved" : `${saved.name} is ready`, agent ? undefined : `Mention @${saved.handle} or start a chat.`);
      onClose();
    } catch (error) {
      toast.error(error, "Could not save agent");
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    const ok = await confirm({
      title: `Delete ${agent.name}?`,
      body: "Its threads stay in your history, but nobody can talk to this agent anymore. This can't be undone.",
      confirmLabel: "Delete agent",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await client.deleteAgent(agent.id);
      local.agentDeleted(agent.id);
      toast.success(`${agent.name} deleted`);
      onClose();
    } catch (error) {
      toast.error(error, "Could not delete agent");
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-2xl"
      icon={<AgentAvatar agent={draft} size="md" />}
      title={agent ? (readOnly ? agent.name : `Edit ${agent.name}`) : "New agent"}
      description={agent ? `@${agent.handle}` : "Give it a personality, a model, and skills."}
      footer={
        readOnly ? (
          <div className="ml-auto flex items-center gap-3">
            <span className="text-[12.5px] text-subtle">Only admins can change agents.</span>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {agent && (
              <Button variant="primary" icon={<MessageSquare className="size-4" />} onClick={() => navigate(`/chat/new/${agent.id}`)}>
                Chat
              </Button>
            )}
          </div>
        ) : (
          <>
            {agent && (
              <Button variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" icon={<Trash className="size-4" />} onClick={remove}>
                Delete
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" loading={saving} disabled={!!nameError || !!handleError} onClick={save}>
                {agent ? "Save changes" : "Create agent"}
              </Button>
            </div>
          </>
        )
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) void save();
        }}
      >
        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-7 px-5 py-6">
        <Section title="Identity">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="agent-name" error={draft.name ? nameError : null}>
              <Input
                id="agent-name"
                data-autofocus
                value={draft.name}
                placeholder="Code Reviewer"
                onChange={(e) => {
                  const name = e.target.value;
                  setDraft((d) => ({ ...d, name, handle: handleTouched ? d.handle : slugify(name) }));
                }}
              />
            </Field>
            <Field label="Handle" htmlFor="agent-handle" error={draft.handle ? handleError : null} hint="Used for @mentions in chat and on Slack.">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[13px] text-faint">@</span>
                <Input
                  id="agent-handle"
                  value={draft.handle}
                  invalid={!!draft.handle && !!handleError}
                  placeholder="reviewer"
                  className="pl-7 font-mono"
                  onChange={(e) => {
                    setHandleTouched(true);
                    set("handle", e.target.value.toLowerCase().replace(/\s+/g, "-"));
                  }}
                />
              </div>
            </Field>
          </div>

          <Field label="Avatar">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
                {[...GLYPHS, ...EMOJI].map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => set("avatar", g)}
                    aria-label={`Avatar ${g}`}
                    aria-pressed={draft.avatar === g}
                    className={cn(
                      "grid size-9 place-items-center rounded-lg border text-[16px] transition-all",
                      draft.avatar === g ? "border-accent-line bg-accent-soft ring-3 ring-accent-line/15" : "border-border bg-surface-2/50 hover:border-border-strong hover:bg-surface-2",
                    )}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={customGlyph}
                  maxLength={4}
                  placeholder="Or type any emoji"
                  className="h-8 w-44 text-[13px]"
                  onChange={(e) => {
                    setCustomGlyph(e.target.value);
                    if (e.target.value.trim()) set("avatar", e.target.value.trim());
                  }}
                />
              </div>
            </div>
          </Field>

          <Field label="Color">
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set("color", c)}
                  aria-label={`Color ${c}`}
                  aria-pressed={draft.color === c}
                  className={cn("size-7 rounded-full transition-transform hover:scale-110", draft.color === c && "ring-2 ring-fg ring-offset-2 ring-offset-[var(--overlay)]")}
                  style={{ background: c }}
                />
              ))}
            </div>
          </Field>

          <Field label="Description" htmlFor="agent-desc" hint="A short line shown on cards and in pickers.">
            <Input id="agent-desc" value={draft.description} placeholder="Reviews pull requests and catches bugs early." onChange={(e) => set("description", e.target.value)} />
          </Field>
        </Section>

        <Section title="Instructions" description="The system prompt. Who the agent is, how it should behave, what it should never do.">
          <Textarea
            value={draft.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            rows={10}
            placeholder={"You are a careful senior engineer who reviews code.\n\n- Be specific and cite file names.\n- Suggest fixes, not just problems."}
            className="min-h-[200px] font-mono text-[12.5px] leading-relaxed"
            aria-label="Instructions"
          />
        </Section>

        <Section title="Model">
          <Field label="Model" htmlFor="agent-model" hint={model ? `${contextWindow(model.model.contextWindow)} context · ${perMillion(model.model.cost.input)} in / ${perMillion(model.model.cost.output)} out per million tokens` : undefined}>
            <ModelPicker id="agent-model" value={draft.model ?? null} onChange={(m) => set("model", m)} />
          </Field>
          <Field
            label="Thinking"
            hint={model && !model.model.reasoning ? "This model doesn't support extended thinking; the setting is ignored." : "How long the model reasons before answering. Higher is slower and costs more."}
          >
            <Segmented
              value={draft.thinkingLevel}
              onChange={(v) => set("thinkingLevel", v)}
              size="sm"
              className="w-full max-w-md"
              options={THINKING.map((t) => ({ value: t, label: t }))}
            />
          </Field>
        </Section>

        <Section title="Skills" description="What the agent is allowed to do beyond talking.">
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {AGENT_SKILLS.map((skill) => {
              const on = draft.skills.includes(skill.id);
              const toggle = (value: boolean) =>
                set("skills", value ? [...draft.skills, skill.id] : draft.skills.filter((s): s is AgentSkill => s !== skill.id));
              return (
                <label key={skill.id} className={cn("flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/40", skill.dangerous && on && "bg-warning-soft")}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-medium text-fg">{skill.label}</span>
                      {skill.dangerous && (
                        <Badge tone="warning">
                          <ShieldAlert className="size-3" />
                          Dangerous
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-subtle">{skill.description}</p>
                    {skill.dangerous && on && (
                      <p className="mt-1 text-[12px] text-warning">
                        Anyone who can talk to this agent can run shell commands on your server.
                        {!draft.chatAccess && " Slack, Discord, and Telegram can't reach it unless you allow chat access below."}
                      </p>
                    )}
                  </div>
                  <Switch checked={on} onChange={toggle} label={skill.label} />
                </label>
              );
            })}
          </div>
        </Section>

        {draft.skills.includes("workspace") && (
          <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3", draft.chatAccess ? "border-danger/40 bg-danger-soft" : "border-border")}>
            <TriangleAlert className={cn("mt-0.5 size-4 shrink-0", draft.chatAccess ? "text-danger" : "text-warning")} />
            <div className="min-w-0 flex-1">
              <span className="text-[13.5px] font-medium text-fg">Reachable from chat apps</span>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-subtle">
                Off by default: agents with the workspace skill answer only here, in the terminal, the API, and webhooks.
              </p>
              {draft.chatAccess && (
                <p className="mt-1.5 text-[12.5px] font-medium leading-relaxed text-danger">
                  Anyone who can message this agent in Slack, Discord, or Telegram can run shell commands on your server. Limit who can reach it with each connection's access lists.
                </p>
              )}
            </div>
            <Switch
              checked={draft.chatAccess}
              label="Reachable from chat apps"
              onChange={async (value) => {
                if (value) {
                  const ok = await confirm({
                    title: "Let chat apps reach this agent?",
                    body: "It can run shell commands on your server. Everyone who can message it on a connection, and isn't excluded by that connection's access lists, gets that power.",
                    confirmLabel: "Allow chat access",
                    tone: "danger",
                  });
                  if (!ok) return;
                }
                set("chatAccess", value);
              }}
            />
          </label>
        )}

        <Section title="Budget" description="Checked before each message. Over the limit, chat users get a short reply and the API answers 429. Days are UTC.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Daily spend" htmlFor="agent-budget-usd" hint="USD, at list API prices. Empty for no limit.">
              <LimitInput id="agent-budget-usd" step="0.01" prefix="$" value={draft.budget.dailyUsd} onChange={(v) => set("budget", { ...draft.budget, dailyUsd: v })} />
            </Field>
            <Field label="Daily messages" htmlFor="agent-budget-runs" hint="Messages admitted per day. Empty for no limit.">
              <LimitInput id="agent-budget-runs" step="1" value={draft.budget.dailyRuns} onChange={(v) => set("budget", { ...draft.budget, dailyRuns: v === null ? null : Math.round(v) })} />
            </Field>
          </div>
          {agent && <SpendMeter spend={spend} budget={draft.budget} className="rounded-lg border border-border bg-surface-2/40 px-3 py-2.5" />}
        </Section>

        <Section title="Behavior">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Max turns" htmlFor="agent-turns" hint="Upper bound on tool rounds per run.">
              <Input id="agent-turns" type="number" min={1} max={500} value={draft.maxTurns} onChange={(e) => set("maxTurns", Number(e.target.value))} />
            </Field>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border px-4 py-3">
            <Star className={cn("mt-0.5 size-4 shrink-0", draft.isDefault ? "fill-warning text-warning" : "text-faint")} />
            <div className="min-w-0 flex-1">
              <span className="text-[13.5px] font-medium text-fg">Default agent</span>
              <p className="mt-0.5 text-[12.5px] text-subtle">Answers messages that don't mention a specific agent, on every connection without its own binding.</p>
            </div>
            <Switch checked={draft.isDefault} onChange={(v) => set("isDefault", v)} label="Default agent" disabled={agent?.isDefault} />
          </label>
        </Section>
        <button type="submit" hidden />
        </fieldset>
      </form>
    </Drawer>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-subtle">{title}</h3>
        {description && <p className="mt-1 text-[12.5px] text-subtle">{description}</p>}
      </div>
      {children}
    </section>
  );
}
