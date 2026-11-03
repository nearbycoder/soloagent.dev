import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, CircleCheck, CircleX, ExternalLink, KeyRound, LogIn, LogOut, Search, ShieldCheck, Sparkles } from "lucide-react";
import type { LoginFlowState, ProviderInfo } from "@soloagent/client";
import { client } from "../api/client.ts";
import { loadProviders, setFlow, useApp } from "../api/store.ts";
import { ProviderMark } from "../components/brand.tsx";
import { Modal } from "../components/overlay.tsx";
import { Badge, Button, Card, CopyButton, CopyField, Input, Page, PageHeader, SectionHeader, Select, Skeleton, Spinner } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { clockTime } from "../lib/format.ts";
import { confirm, toast } from "../lib/toast.ts";

const SUBSCRIPTION_HINT: Record<string, string> = {
  anthropic: "Claude Pro / Max",
  openai: "ChatGPT Plus / Pro",
  "openai-codex": "ChatGPT Plus / Pro",
  "github-copilot": "Copilot Individual / Business",
  xai: "SuperGrok / X Premium",
};

export function Providers() {
  const providers = useApp((s) => s.providers);
  const [query, setQuery] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  useEffect(() => {
    void loadProviders(true);
  }, []);

  const subscriptions = useMemo(
    () => (providers ?? []).filter((p) => p.oauth?.subscription).sort((a, b) => Number(b.featured) - Number(a.featured) || Number(!!b.configured) - Number(!!a.configured)),
    [providers],
  );
  const keyed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (providers ?? [])
      .filter((p) => (p.apiKey || (p.oauth && !p.oauth.subscription)) && p.configured?.source !== "built-in")
      .filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q))
      .sort((a, b) => Number(!!b.configured) - Number(!!a.configured) || Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));
  }, [providers, query]);
  const builtIn = (providers ?? []).filter((p) => p.configured?.source === "built-in");

  const startLogin = async (provider: ProviderInfo) => {
    setStarting(provider.id);
    try {
      const flow = await client.startLogin(provider.id, "oauth");
      setFlow(flow);
      setFlowId(flow.id);
    } catch (error) {
      toast.error(error, `Could not start ${provider.name} sign-in`);
    } finally {
      setStarting(null);
    }
  };

  const logout = async (provider: ProviderInfo) => {
    const ok = await confirm({
      title: `Disconnect ${provider.name}?`,
      body: "Agents using its models will stop answering until you connect it again or switch their model.",
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await client.logoutProvider(provider.id);
      toast.success(`${provider.name} disconnected`);
      void loadProviders(true);
    } catch (error) {
      toast.error(error, "Could not disconnect");
    }
  };

  const configuredCount = (providers ?? []).filter((p) => p.configured && p.configured.source !== "built-in").length;

  return (
    <Page>
      <PageHeader
        title="Subscriptions & keys"
        description="Run agents on the subscriptions you already pay for, or bring API keys from 30+ providers. Credentials are stored on your server only."
        actions={providers && <Badge tone={configuredCount ? "success" : "neutral"}>{configuredCount ? `${configuredCount} connected` : "None connected"}</Badge>}
      />

      <section>
        <SectionHeader title="Sign in with a subscription" description="No API key needed — use your existing plan." />
        {!providers ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[150px] rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subscriptions.map((provider) => {
              const connected = !!provider.configured;
              return (
                <Card key={provider.id} className={cn("relative flex flex-col overflow-hidden p-4", connected && "border-success/30")}>
                  {provider.featured && !connected && <div className="pointer-events-none absolute -right-10 -top-10 size-28 rounded-full bg-accent/10 blur-2xl" />}
                  <div className="relative flex items-start gap-3">
                    <ProviderMark id={provider.id} name={provider.name} size="lg" />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[14px] font-semibold text-fg">{provider.name}</h3>
                      <p className="truncate text-[12.5px] text-subtle">{SUBSCRIPTION_HINT[provider.id] ?? provider.oauth?.label}</p>
                    </div>
                    {connected && (
                      <Badge tone="success" dot>
                        Connected
                      </Badge>
                    )}
                  </div>
                  <p className="relative mt-3 text-[12px] text-faint">
                    {provider.models.length} models
                    {connected && provider.configured?.type === "api_key" && " · via API key"}
                  </p>
                  <div className="relative mt-3 flex gap-2">
                    {connected ? (
                      <>
                        <Button size="sm" variant="secondary" className="flex-1" icon={<LogIn className="size-3.5" />} loading={starting === provider.id} onClick={() => startLogin(provider)}>
                          Sign in again
                        </Button>
                        <Button size="sm" variant="ghost" icon={<LogOut className="size-3.5" />} onClick={() => logout(provider)}>
                          Sign out
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="secondary" className="w-full" icon={<LogIn className="size-3.5" />} loading={starting === provider.id} onClick={() => startLogin(provider)}>
                        <span className="truncate">{provider.oauth?.label ?? "Sign in"}</span>
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-10">
        <SectionHeader
          title="API keys"
          description="Paste a key from any provider."
          action={
            <div className="relative w-56 max-w-[45vw]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search providers" className="h-8 pl-8 text-[13px]" aria-label="Search providers" />
            </div>
          }
        />
        <Card className="overflow-hidden">
          {!providers ? (
            <div className="divide-y divide-border">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-3 p-4">
                  <Skeleton className="size-9 rounded-lg" />
                  <Skeleton className="h-4 w-40" />
                </div>
              ))}
            </div>
          ) : keyed.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-subtle">No providers match “{query}”.</p>
          ) : (
            <ul className="divide-y divide-border">
              {keyed.map((provider) => (
                <KeyRow key={provider.id} provider={provider} onLogin={() => startLogin(provider)} onLogout={() => logout(provider)} starting={starting === provider.id} />
              ))}
            </ul>
          )}
        </Card>
        {builtIn.length > 0 && (
          <p className="mt-4 flex items-center gap-2 text-[12.5px] text-subtle">
            <Sparkles className="size-3.5 text-accent-text" />
            {builtIn.map((p) => p.name).join(", ")} is built in, so you can try soloagent without any account.
          </p>
        )}
      </section>

      {flowId && <LoginFlowModal flowId={flowId} onClose={() => setFlowId(null)} />}
    </Page>
  );
}

function KeyRow({ provider, onLogin, onLogout, starting }: { provider: ProviderInfo; onLogin: () => void; onLogout: () => void; starting: boolean }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    try {
      await client.setApiKey(provider.id, key.trim());
      toast.success(`${provider.name} key saved`);
      setEditing(false);
      setKey("");
      void loadProviders(true);
    } catch (error) {
      toast.error(error, "Could not save key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <ProviderMark id={provider.id} name={provider.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg">{provider.name}</span>
            {provider.configured && (
              <Badge tone="success" dot>
                {provider.configured.type === "oauth" ? "Signed in" : provider.configured.source ? `Key · ${provider.configured.source}` : "Key set"}
              </Badge>
            )}
          </div>
          <p className="truncate text-[12px] text-faint">
            <span className="font-mono">{provider.id}</span> · {provider.models.length} models
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {provider.oauth && !provider.oauth.subscription && (
            <Button size="sm" variant="ghost" loading={starting} onClick={onLogin} className="hidden sm:inline-flex">
              {provider.oauth.label}
            </Button>
          )}
          {provider.apiKey && (
            <Button size="sm" variant={editing ? "ghost" : "secondary"} icon={!editing && <KeyRound className="size-3.5" />} onClick={() => setEditing((e) => !e)}>
              {editing ? "Cancel" : provider.configured ? "Replace" : "Set key"}
            </Button>
          )}
          {provider.configured && (
            <Button size="sm" variant="ghost" onClick={onLogout} aria-label={`Remove ${provider.name} credential`} className="px-2 text-subtle hover:text-danger">
              <LogOut className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <form onSubmit={save} className="mt-3 flex animate-fade-in flex-col gap-2 sm:ml-12 sm:flex-row">
          <Input autoFocus type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={`${provider.name} API key`} className="font-mono" />
          <Button type="submit" variant="primary" loading={saving} disabled={!key.trim()} className="h-9 shrink-0">
            Save key
          </Button>
        </form>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// OAuth login flow

export function LoginFlowModal({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const flow = useApp((s) => s.flows[flowId]);
  const providers = useApp((s) => s.providers);
  const provider = providers?.find((p) => p.id === flow?.providerId);
  const finished = flow && (flow.status === "done" || flow.status === "failed" || flow.status === "cancelled");

  // Poll as a fallback in case a WebSocket update is missed.
  useEffect(() => {
    if (finished) return;
    const id = setInterval(async () => {
      try {
        setFlow(await client.loginFlow(flowId));
      } catch {
        // keep the last known state
      }
    }, 2500);
    return () => clearInterval(id);
  }, [flowId, finished]);

  useEffect(() => {
    if (flow?.status === "done") {
      void loadProviders(true);
      toast.success(`${provider?.name ?? "Provider"} connected`);
    }
  }, [flow?.status]);

  const cancel = async () => {
    if (flow && !finished) {
      try {
        setFlow(await client.cancelLogin(flowId));
      } catch {
        // already gone
      }
    }
    onClose();
  };

  return (
    <Modal
      open
      onClose={cancel}
      size="md"
      title={
        <span className="flex items-center gap-2.5">
          {provider && <ProviderMark id={provider.id} name={provider.name} size="sm" />}
          {provider?.oauth?.label ?? `Sign in to ${provider?.name ?? "provider"}`}
        </span>
      }
      footer={
        finished ? (
          <Button variant={flow.status === "done" ? "primary" : "secondary"} onClick={onClose}>
            {flow.status === "done" ? "Done" : "Close"}
          </Button>
        ) : (
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-5 px-5 py-5">
        {!flow ? (
          <div className="flex items-center gap-3 py-6 text-[13px] text-subtle">
            <Spinner /> Starting sign-in…
          </div>
        ) : flow.status === "done" ? (
          <FlowResult tone="success" title="You're connected" body={`${provider?.name ?? "The provider"} is ready. Pick one of its models for any agent.`} />
        ) : flow.status === "failed" ? (
          <FlowResult tone="danger" title="Sign-in failed" body={flow.error ?? "Something went wrong. Try again."} />
        ) : flow.status === "cancelled" ? (
          <FlowResult tone="neutral" title="Sign-in cancelled" body="Nothing was changed." />
        ) : (
          <FlowSteps flow={flow} />
        )}

        {flow && flow.log.length > 0 && (
          <details className="group rounded-lg border border-border bg-code" open={flow.status === "failed"}>
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[12px] font-medium text-subtle hover:text-fg">
              Log · {flow.log.length} {flow.log.length === 1 ? "line" : "lines"}
              <span className="text-faint group-open:rotate-90">›</span>
            </summary>
            <ol className="max-h-44 overflow-y-auto border-t border-border px-3 py-2 font-mono text-[11.5px] leading-relaxed">
              {flow.log.map((line, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="shrink-0 text-faint">{clockTime(line.at)}</span>
                  <span className="min-w-0 break-words text-muted">
                    {line.message}
                    {line.links?.map((link) => (
                      <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="ml-1.5 text-accent-text underline underline-offset-2">
                        {link.label ?? link.url}
                      </a>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </Modal>
  );
}

function FlowResult({ tone, title, body }: { tone: "success" | "danger" | "neutral"; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center py-4 text-center">
      <div
        className={cn(
          "grid size-12 animate-scale-in place-items-center rounded-full [&_svg]:size-6",
          tone === "success" ? "bg-success-soft text-success" : tone === "danger" ? "bg-danger-soft text-danger" : "bg-surface-3 text-subtle",
        )}
      >
        {tone === "success" ? <CircleCheck /> : <CircleX />}
      </div>
      <h3 className="mt-3 text-[15px] font-semibold text-fg">{title}</h3>
      <p className="mt-1 max-w-sm break-words text-[13px] leading-relaxed text-subtle">{body}</p>
    </div>
  );
}

function FlowSteps({ flow }: { flow: LoginFlowState }) {
  const nothingYet = !flow.authUrl && !flow.deviceCode && !flow.prompt;
  return (
    <>
      {flow.authUrl && (
        <div className="flex flex-col gap-3">
          <StepLabel n={1}>Open the sign-in page and approve access</StepLabel>
          <a
            href={flow.authUrl.url}
            target="_blank"
            rel="noreferrer"
            className="flex h-11 items-center justify-center gap-2 rounded-xl bg-accent text-[14px] font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_6px_20px_-6px_var(--accent)] transition-colors hover:bg-accent-hover"
          >
            Open sign-in page
            <ExternalLink className="size-4" />
          </a>
          <CopyField value={flow.authUrl.url} />
          {flow.authUrl.instructions && <p className="text-[12.5px] leading-relaxed text-subtle">{flow.authUrl.instructions}</p>}
        </div>
      )}

      {flow.deviceCode && (
        <div className="flex flex-col gap-3">
          <StepLabel n={flow.authUrl ? 2 : 1}>Enter this code on the verification page</StepLabel>
          <div className="flex items-center justify-center gap-3 rounded-xl border border-border bg-code px-4 py-5">
            <span className="select-all font-mono text-[28px] font-semibold tracking-[0.18em] text-fg">{flow.deviceCode.userCode}</span>
            <CopyButton text={flow.deviceCode.userCode} label="Copy code" />
          </div>
          <a
            href={flow.deviceCode.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 text-[13.5px] font-medium text-fg transition-colors hover:border-border-strong"
          >
            Open {new URL(flow.deviceCode.verificationUri, location.href).host}
            <ArrowUpRight className="size-4" />
          </a>
        </div>
      )}

      {flow.prompt && <FlowPrompt key={`${flow.prompt.type}:${flow.prompt.message}`} flow={flow} step={(flow.authUrl ? 1 : 0) + (flow.deviceCode ? 1 : 0) + 1} />}

      {!flow.prompt && (
        <div className="flex items-center gap-2.5 rounded-lg bg-surface-2/60 px-3 py-2.5 text-[12.5px] text-subtle">
          <Spinner className="size-3.5" />
          {nothingYet ? "Preparing sign-in…" : "Waiting for you to finish in the browser…"}
        </div>
      )}
      <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-faint">
        <ShieldCheck className="mt-px size-3.5 shrink-0" />
        Tokens go straight to your soloagent server and never leave it.
      </p>
    </>
  );
}

function StepLabel({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-[13px] font-medium text-fg">
      <span className="grid size-5 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-text">{n}</span>
      {children}
    </div>
  );
}

function FlowPrompt({ flow, step }: { flow: LoginFlowState; step: number }) {
  const prompt = flow.prompt!;
  const [value, setValue] = useState(prompt.type === "select" ? (prompt.options?.[0]?.id ?? "") : "");
  const [sending, setSending] = useState(false);
  // Any server update (including the answer's response) ends the sending state.
  useEffect(() => setSending(false), [flow]);

  const answer = async (answerValue = value) => {
    // Plain text prompts may legitimately be left blank (e.g. "blank for github.com").
    if (!answerValue.trim() && (prompt.type === "secret" || prompt.type === "manual_code")) return;
    setSending(true);
    try {
      setFlow(await client.answerLogin(flow.id, answerValue.trim()));
    } catch (error) {
      toast.error(error, "Could not send that");
      setSending(false);
    }
  };

  const isManual = prompt.type === "manual_code";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void answer();
      }}
      className="flex flex-col gap-3"
    >
      <StepLabel n={step}>{isManual ? "Paste the code or the full redirect URL from your browser" : prompt.message}</StepLabel>
      {isManual && (
        <p className="-mt-1 text-[12.5px] leading-relaxed text-subtle">
          After approving, your browser lands on a page that may not load (it points at <span className="font-mono">localhost</span>). That's expected — copy the whole URL from the address bar
          and paste it here.
          {prompt.message && prompt.message !== "Paste the code or the full redirect URL from your browser" && <span className="mt-1 block text-faint">{prompt.message}</span>}
        </p>
      )}
      {prompt.type === "select" ? (
        prompt.options && prompt.options.length <= 5 ? (
          <div className="flex flex-col gap-1.5">
            {prompt.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={sending}
                onClick={() => {
                  setValue(option.id);
                  void answer(option.id);
                }}
                className="flex items-start gap-3 rounded-lg border border-border bg-surface-2/40 px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft disabled:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium text-fg">{option.label}</span>
                  {option.description && <span className="mt-0.5 block text-[12px] text-subtle">{option.description}</span>}
                </span>
                {sending && value === option.id && <Spinner className="size-3.5" />}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex gap-2">
            <Select value={value} onChange={(e) => setValue(e.target.value)} className="flex-1">
              {prompt.options?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="primary" loading={sending} className="h-9">
              Continue
            </Button>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            autoFocus
            type={prompt.type === "secret" ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={prompt.placeholder ?? (isManual ? "https://localhost/callback?code=…" : "")}
            autoComplete="off"
            spellCheck={false}
            className={cn((isManual || prompt.type === "secret") && "font-mono text-[12.5px]")}
          />
          <Button type="submit" variant="primary" loading={sending} disabled={prompt.type !== "text" && !value.trim()} className="h-9 shrink-0">
            {isManual ? "Finish sign-in" : prompt.type === "text" && !value.trim() ? "Skip" : "Continue"}
          </Button>
        </div>
      )}
    </form>
  );
}
