import { useEffect, useState } from "react";
import { ArrowRight, Eye, EyeOff, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import type { Me } from "@soloagent/client";
import { client, errorMessage } from "../api/client.ts";
import { SparkMark } from "../components/brand.tsx";
import { Button, Input, Segmented } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";

type Mode = "password" | "token";
const MODE_KEY = "solo.login.mode";

function savedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "password" ? "password" : "token";
  } catch {
    return "token";
  }
}

export function Login({ onLoggedIn, expired }: { onLoggedIn: (me: Me) => void; expired?: boolean }) {
  const [mode, setMode] = useState<Mode>(savedMode);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(expired ? "Your session ended. Sign in again to continue." : null);

  useEffect(() => {
    document.title = "Sign in · soloagent";
  }, []);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setShow(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === "token" && !token.trim()) return setError("Paste your admin token to continue.");
    if (mode === "password" && (!name.trim() || !password)) return setError("Enter your name and password.");
    setBusy(true);
    setError(null);
    try {
      if (mode === "token") await client.login(token.trim());
      else await client.loginPassword(name.trim(), password);
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        // ignore
      }
      onLoggedIn(await client.me());
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col overflow-y-auto bg-bg">

      <div className="relative flex flex-1 flex-col items-center justify-center px-4 py-16">
        <div className="mb-9 flex flex-col items-center text-center">
          <SparkMark className="mb-6 size-14" />
          <h1 className="font-display text-[34px] font-semibold text-fg">
            soloagent
          </h1>
          <p className="mt-2 max-w-xs text-[14px] leading-relaxed text-subtle">One control plane for all of your AI agents.</p>
        </div>

        <form
          onSubmit={submit}
          className="w-full max-w-[380px] animate-scale-in rounded-2xl border border-border bg-surface/80 p-6 shadow-lg backdrop-blur-xl"
        >
          <Segmented<Mode>
            value={mode}
            onChange={switchMode}
            className="mb-5 w-full"
            options={[
              { value: "password", label: <><UserRound className="size-3.5" /> Team member</> },
              { value: "token", label: <><KeyRound className="size-3.5" /> Admin token</> },
            ]}
          />
          {mode === "password" ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="login-name" className="text-[13px] font-medium text-fg">
                  Name
                </label>
                <Input
                  id="login-name"
                  autoFocus
                  autoComplete="username"
                  value={name}
                  invalid={!!error}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                  className="h-10"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="login-password" className="text-[13px] font-medium text-fg">
                  Password
                </label>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  invalid={!!error}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  className="h-10"
                />
              </div>
            </div>
          ) : (
            <>
            <label htmlFor="token" className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <KeyRound className="size-3.5 text-subtle" />
              Admin token
            </label>
            <div
              className={cn(
                "mt-2 flex h-10 items-center rounded-lg border bg-surface-2/60 transition-[border-color,box-shadow] focus-within:bg-surface focus-within:ring-3",
                error ? "border-danger/60 focus-within:ring-danger/15" : "border-border focus-within:border-accent-line/70 focus-within:ring-accent-line/15",
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
            </>
          )}
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
            {mode === "password" ? (
              <p>Use the name and password you chose when you opened your invite link. No account yet? Ask an admin for an invite.</p>
            ) : (
              <p>
                The server prints its token on first start. If you set <code className="rounded bg-surface-3 px-1 font-mono text-[11.5px] text-muted">SOLOAGENT_TOKEN</code>, use
                that value.
              </p>
            )}
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
