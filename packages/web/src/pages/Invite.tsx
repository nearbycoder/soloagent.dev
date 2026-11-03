import { useEffect, useState } from "react";
import { ArrowRight, CircleAlert, ShieldCheck } from "lucide-react";
import type { Me, Role } from "@soloagent/client";
import { client, errorMessage } from "../api/client.ts";
import { SparkMark } from "../components/brand.tsx";
import { Button, Field, Input, Spinner } from "../components/ui.tsx";
import { fullDate } from "../lib/format.ts";

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
    <div className="relative flex h-full flex-col overflow-y-auto bg-bg">
      <div className="relative flex flex-1 flex-col items-center justify-center px-4 py-16">
        <div className="mb-9 flex flex-col items-center text-center">
          <SparkMark className="mb-6 size-14" />
          <h1 className="font-display text-[30px] font-semibold text-fg">Join your team</h1>
          <p className="mt-2 max-w-xs text-[14px] leading-relaxed text-subtle">
            {invite ? (
              <>
                You're invited to soloagent as {invite.role === "admin" ? "an admin" : "a member"}. Pick a name and password to sign in.
              </>
            ) : (
              "One control plane for all of your AI agents."
            )}
          </p>
        </div>

        <div className="w-full max-w-[380px] animate-scale-in rounded-2xl border border-border bg-surface/80 p-6 shadow-lg backdrop-blur-xl">
          {loadError ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CircleAlert className="size-6 text-danger" />
              <p className="text-[13.5px] text-fg">{loadError}</p>
              <a href="/" className="text-[13px] font-medium text-accent-text hover:underline">
                Go to sign in
              </a>
            </div>
          ) : !invite ? (
            <div className="grid place-items-center py-8">
              <Spinner />
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
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
                <p role="alert" className="text-[12.5px] text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
                Join and sign in
                {!busy && <ArrowRight className="size-4" />}
              </Button>
              <div className="flex gap-2.5 rounded-lg border border-border bg-surface-2/50 p-3 text-[12.5px] leading-relaxed text-subtle">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent-text" />
                <p>This link works once and expires {fullDate(invite.expiresAt)}.</p>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
