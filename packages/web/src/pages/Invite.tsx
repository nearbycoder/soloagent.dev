import { useEffect, useState } from "react";
import { ArrowRight, CircleAlert, Link2Off, ShieldCheck } from "lucide-react";
import type { Me, Role } from "@soloagent/client";
import { client, errorMessage } from "../api/client.ts";
import { Badge, Button, Field, Input, Spinner } from "../components/ui.tsx";
import { fullDate, relativeTime } from "../lib/format.ts";
import { AuthLayout, Orbital } from "./Login.tsx";

const MIN_PASSWORD = 8;

/** /invite/<code>: the invitee picks a name and password and is signed in. */
export function InvitePage({ code, onJoined }: { code: string; onJoined: (me: Me) => void }) {
  const [invite, setInvite] = useState<{ role: Role; name: string | null; expiresAt: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Join · soloagent";
    client
      .invite(code)
      .then((found) => {
        setInvite(found);
        setName(found.name ?? "");
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, [code]);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError("Choose the name your team will see.");
    if (password.length < MIN_PASSWORD) return setError(`Use a password of at least ${MIN_PASSWORD} characters.`);
    if (password !== confirmPassword) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await client.acceptInvite(code, { name: name.trim(), password });
      try {
        localStorage.setItem("solo.login.mode", "password");
      } catch {
        // ignore
      }
      onJoined(await client.me());
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <Orbital small className="mb-7" />
      <h1 className="font-display text-balance text-center text-[30px] font-semibold leading-tight text-fg sm:text-[32px]">
        {loadError ? "This link doesn't work" : "Join your team"}
      </h1>
      <div className="mt-3 flex min-h-6 max-w-sm flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-[14.5px] leading-relaxed text-subtle">
        {invite ? (
          <>
            <span>You're invited to soloagent as</span>
            <Badge tone={invite.role === "admin" ? "warning" : "neutral"} className="h-6 px-2 text-[12px]">
              {invite.role === "admin" ? "an admin" : "a member"}
            </Badge>
          </>
        ) : loadError ? (
          <span>Invite links work once and expire after 7 days.</span>
        ) : (
          <span>The control plane for your agents.</span>
        )}
      </div>

      <div className="lit mt-8 w-full max-w-[400px] animate-rise rounded-2xl border border-border-strong bg-surface/80 p-5 shadow-lg backdrop-blur-xl sm:p-6">
        {loadError ? (
          <div className="flex flex-col items-center gap-3 py-3 text-center">
            <span className="grid size-11 place-items-center rounded-xl border border-danger/25 bg-danger-soft text-danger">
              <Link2Off className="size-5" />
            </span>
            <p className="max-w-[300px] text-balance text-[13.5px] leading-relaxed text-fg">{loadError}</p>
            <a href="/" className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-control px-3 text-[13px] font-medium text-fg shadow-xs transition-colors hover:bg-control-hover">
              Go to sign in
              <ArrowRight className="size-3.5" />
            </a>
          </div>
        ) : !invite ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <Field label="Your name" htmlFor="invite-name" hint="Shown on your messages, and what you sign in with.">
              <Input id="invite-name" autoFocus autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
            </Field>
            <Field label="Password" htmlFor="invite-password" error={tooShort ? `At least ${MIN_PASSWORD} characters` : null}>
              <Input id="invite-password" type="password" autoComplete="new-password" value={password} invalid={tooShort} onChange={(e) => setPassword(e.target.value)} className="h-10" />
            </Field>
            <Field label="Confirm password" htmlFor="invite-confirm" error={mismatch ? "Doesn't match" : null}>
              <Input
                id="invite-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                invalid={mismatch}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="h-10"
              />
            </Field>
            {error && (
              <p role="alert" className="flex items-center gap-1.5 text-[12.5px] text-danger">
                <CircleAlert className="size-3.5 shrink-0" />
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">
              Join and sign in
              {!busy && <ArrowRight />}
            </Button>
            <div className="flex gap-2.5 border-t border-border pt-4 text-[12.5px] leading-relaxed text-subtle">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-faint" />
              <p>
                This link works once and expires{" "}
                <span className="font-mono text-[11.5px] text-muted" title={fullDate(invite.expiresAt)}>
                  {relativeTime(invite.expiresAt)}
                </span>
                .
              </p>
            </div>
          </form>
        )}
      </div>
    </AuthLayout>
  );
}
