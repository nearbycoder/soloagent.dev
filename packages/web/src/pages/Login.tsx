import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, CircleAlert, Clock, Eye, EyeOff, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import type { Me } from "@soloagent/client";
import { client, errorMessage } from "../api/client.ts";
import { AgentAvatar, SoloMark, type AgentPresence } from "../components/brand.tsx";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(expired ? "Your session ended. Sign in again to continue." : null);

  useEffect(() => {
    document.title = "Sign in · soloagent";
  }, []);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
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
      setNotice(null);
      onLoggedIn(await client.me());
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <Orbital className="mb-8 sm:mb-9" />
      <h1 className="font-display text-[34px] font-semibold leading-none text-fg sm:text-[38px]">soloagent</h1>
      <p className="mt-3 text-balance text-center text-[15px] text-subtle">The control plane for your agents.</p>

      <form
        onSubmit={submit}
        noValidate
        className="lit mt-9 w-full max-w-[400px] animate-rise rounded-2xl border border-border-strong bg-surface/80 p-5 shadow-lg backdrop-blur-xl sm:p-6"
      >
        {notice && (
          <div role="status" className="mb-5 flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-warning">
            <Clock className="mt-px size-3.5 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        <Segmented<Mode>
          value={mode}
          onChange={switchMode}
          className="mb-5 w-full"
          options={[
            { value: "password", label: <><UserRound /> Team member</> },
            { value: "token", label: <><KeyRound /> Admin token</> },
          ]}
        />

        {mode === "password" ? (
          <div className="flex flex-col gap-4">
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
              <SecretInput
                id="login-password"
                autoComplete="current-password"
                value={password}
                invalid={!!error}
                revealLabel="password"
                onChange={(value) => {
                  setPassword(value);
                  setError(null);
                }}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="token" className="text-[13px] font-medium text-fg">
              Admin token
            </label>
            <SecretInput
              id="token"
              mono
              autoFocus
              autoComplete="current-password"
              placeholder="Paste your token"
              value={token}
              invalid={!!error}
              revealLabel="token"
              onChange={(value) => {
                setToken(value);
                setError(null);
              }}
            />
          </div>
        )}

        {error && (
          <p role="alert" className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-danger">
            <CircleAlert className="size-3.5 shrink-0" />
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-5 w-full">
          Continue
          {!busy && <ArrowRight />}
        </Button>

        <div className="mt-5 flex gap-2.5 border-t border-border pt-4 text-[12.5px] leading-relaxed text-subtle">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-faint" />
          {mode === "password" ? (
            <p>Use the name and password you chose when you opened your invite link. No account yet? Ask an admin for an invite.</p>
          ) : (
            <p>
              The server prints its token on first start. If you set <code className="rounded-md border border-border bg-surface-2 px-1 font-mono text-[11.5px] text-muted">SOLOAGENT_TOKEN</code>,
              use that value.
            </p>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}

/** A password-style field with a show/hide toggle. `mono` for machine secrets like tokens. */
function SecretInput({
  id,
  value,
  onChange,
  invalid,
  mono,
  autoFocus,
  autoComplete,
  placeholder,
  revealLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  mono?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  placeholder?: string;
  revealLabel: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div
      className={cn(
        "flex h-10 items-center rounded-lg border bg-field shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:ring-[3px]",
        invalid ? "border-danger/60 focus-within:border-danger focus-within:ring-danger/15" : "border-border hover:border-border-strong focus-within:border-accent-line/60 focus-within:ring-focus",
      )}
    >
      <input
        id={id}
        type={show ? "text" : "password"}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn("h-full min-w-0 flex-1 bg-transparent px-3 text-fg outline-none placeholder:font-sans placeholder:text-faint", mono ? "font-mono text-[13px]" : "text-[13.5px]")}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? `Hide ${revealLabel}` : `Show ${revealLabel}`}
        title={show ? `Hide ${revealLabel}` : `Show ${revealLabel}`}
        className="mr-1 grid size-8 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/** The frame shared by the signed-out screens (sign in, invite links): dot grid, a soft glow, a quiet footer. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-full flex-col overflow-y-auto overflow-x-hidden bg-bg">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[720px]">
        <div className="bg-dots mask-radial absolute inset-0" />
        <div className="absolute left-1/2 top-16 h-[300px] w-[min(520px,100%)] -translate-x-1/2 rounded-full bg-accent/[0.045] blur-[90px]" />
      </div>
      <div className="relative flex flex-1 flex-col items-center justify-center px-4 py-12 sm:py-16">{children}</div>
      <footer className="relative flex shrink-0 items-center justify-center gap-2.5 pb-6 font-mono text-[11px] text-faint">
        <a href="https://soloagent.dev" target="_blank" rel="noreferrer" className="transition-colors hover:text-subtle">
          soloagent.dev
        </a>
        <span aria-hidden>·</span>
        <span>open source</span>
        <span aria-hidden>·</span>
        <span>self-hosted</span>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The orbital: the soloagent mark with agents circling it. Decorative only.

type Satellite = { angle: number; avatar: string; color: string; presence?: AgentPresence };

const OUTER: Satellite[] = [
  { angle: -58, avatar: "◆", color: "#8b7cf6" },
  { angle: 148, avatar: "●", color: "#10b981" },
];
const INNER: Satellite[] = [
  { angle: 32, avatar: "▲", color: "#0ea5e9", presence: "working" },
  { angle: 212, avatar: "■", color: "#f59e0b" },
];

export function Orbital({ className, small }: { className?: string; small?: boolean }) {
  return (
    <div aria-hidden className={cn("relative shrink-0", small ? "size-[168px]" : "size-[196px] sm:size-[228px]", className)}>
      {/* Rings */}
      <div className="absolute inset-0 rounded-full border border-dashed border-border-strong" />
      <div className="absolute inset-[17%] rounded-full border border-border" />
      <div className="absolute inset-[33%] rounded-full bg-[radial-gradient(circle,var(--surface-2)_0%,transparent_70%)]" />

      {/* Outer ring: clockwise, with one lime packet in flight. */}
      <div className="absolute inset-0 animate-[spin_96s_linear_infinite]">
        <span className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-line shadow-[0_0_10px_2px_var(--accent-glow)]" />
        <span className="absolute bottom-[14.6%] right-[14.6%] size-1 translate-x-1/2 translate-y-1/2 rounded-full bg-faint" />
        {OUTER.map((s) => (
          <Satellite key={s.avatar} satellite={s} small={small} spin="animate-[spin_96s_linear_infinite] [animation-direction:reverse]" />
        ))}
      </div>

      {/* Inner ring: counter-clockwise. */}
      <div className="absolute inset-[17%] animate-[spin_72s_linear_infinite] [animation-direction:reverse]">
        <span className="absolute left-0 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-faint" />
        {INNER.map((s) => (
          <Satellite key={s.avatar} satellite={s} small={small} spin="animate-[spin_72s_linear_infinite]" />
        ))}
      </div>

      {/* The mark */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="absolute inset-0 -z-10 scale-[1.7] rounded-full bg-accent/20 blur-2xl" />
        <SoloMark className={cn("drop-shadow-[0_10px_24px_rgb(0_0_0/0.45)]", small ? "size-14" : "size-16 sm:size-[72px]")} />
      </div>
    </div>
  );
}

function Satellite({ satellite, small, spin }: { satellite: Satellite; small?: boolean; spin: string }) {
  const rad = (satellite.angle * Math.PI) / 180;
  return (
    <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${50 + 50 * Math.cos(rad)}%`, top: `${50 + 50 * Math.sin(rad)}%` }}>
      {/* Counter-rotate so the glyph stays upright while its ring turns. */}
      <div className={spin}>
        <AgentAvatar
          agent={{ avatar: satellite.avatar, color: satellite.color, name: "" }}
          size={small ? "sm" : "md"}
          presence={satellite.presence}
          className={cn("shadow-md", !small && "size-7 text-[13px] sm:size-8 sm:text-[15px]")}
        />
      </div>
    </div>
  );
}
