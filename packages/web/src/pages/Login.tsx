import { useState } from "react";
import { ArrowRight, Eye, EyeOff, KeyRound, ShieldCheck } from "lucide-react";
import { client, errorMessage } from "../api/client.ts";
import { SparkMark } from "../components/brand.tsx";
import { Button } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";

export function Login({ onLoggedIn, expired }: { onLoggedIn: (version: string) => void; expired?: boolean }) {
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(expired ? "Your session ended. Sign in again to continue." : null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) return setError("Paste your admin token to continue.");
    setBusy(true);
    setError(null);
    try {
      await client.login(value);
      const me = await client.me();
      onLoggedIn(me.version);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col overflow-y-auto bg-bg">
      {/* Backdrop: a faded grid and a soft violet glow */}
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-60 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_40%,black,transparent)]" />
      <div className="pointer-events-none absolute left-1/2 top-[22%] h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />

      <div className="relative flex flex-1 flex-col items-center justify-center px-4 py-16">
        <div className="mb-9 flex flex-col items-center text-center">
          <div className="relative mb-6">
            <div className="absolute inset-0 rounded-2xl bg-accent/50 blur-xl" />
            <SparkMark className="size-14" />
          </div>
          <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-fg">
            soloagent
          </h1>
          <p className="mt-2 max-w-xs text-[14px] leading-relaxed text-subtle">One control plane for all of your AI agents.</p>
        </div>

        <form
          onSubmit={submit}
          className="w-full max-w-[380px] animate-scale-in rounded-2xl border border-border bg-surface/80 p-6 shadow-lg backdrop-blur-xl"
        >
          <label htmlFor="token" className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <KeyRound className="size-3.5 text-subtle" />
            Admin token
          </label>
          <div
            className={cn(
              "mt-2 flex h-10 items-center rounded-lg border bg-surface-2/60 transition-[border-color,box-shadow] focus-within:bg-surface focus-within:ring-3",
              error ? "border-danger/60 focus-within:ring-danger/15" : "border-border focus-within:border-accent/70 focus-within:ring-accent/15",
            )}
          >
            <input
              id="token"
              type={show ? "text" : "password"}
              autoFocus
              autoComplete="current-password"
              spellCheck={false}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setError(null);
              }}
              placeholder="Paste your token"
              className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] text-fg outline-none placeholder:font-sans"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide token" : "Show token"}
              className="mr-1 grid size-8 place-items-center rounded-md text-subtle hover:text-fg"
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-[12.5px] text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-4 w-full">
            Continue
            {!busy && <ArrowRight className="size-4" />}
          </Button>
          <div className="mt-5 flex gap-2.5 rounded-lg border border-border bg-surface-2/50 p-3 text-[12.5px] leading-relaxed text-subtle">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent-text" />
            <p>
              The server prints its token on first start. If you set <code className="rounded bg-surface-3 px-1 font-mono text-[11.5px] text-muted">SOLOAGENT_TOKEN</code>, use
              that value.
            </p>
          </div>
        </form>

        <p className="mt-8 text-[12px] text-faint">
          <a href="https://soloagent.dev" target="_blank" rel="noreferrer" className="hover:text-subtle">
            soloagent.dev
          </a>
          <span className="mx-2">·</span>
          Open source
        </p>
      </div>
    </div>
  );
}
