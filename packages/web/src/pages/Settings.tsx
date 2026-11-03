import { useState } from "react";
import { ExternalLink, KeyRound, LogOut, Monitor, Moon, RotateCw, SquareTerminal, Sun } from "lucide-react";
import { client } from "../api/client.ts";
import { useApp, useIsAdmin } from "../api/store.ts";
import { confirm, toast } from "../lib/toast.ts";
import { Button, Card, CopyField, Kbd, Page, PageHeader, Segmented, SectionHeader } from "../components/ui.tsx";
import { duration } from "../lib/format.ts";
import { setTheme, useTheme, type ThemePref } from "../lib/theme.ts";

export function SettingsPage({ onSignOut }: { onSignOut: () => void }) {
  const version = useApp((s) => s.version);
  const overview = useApp((s) => s.overview);
  const { pref } = useTheme();
  const origin = location.origin;
  const isAdmin = useIsAdmin();
  const actor = useApp((s) => s.me?.actor);

  return (
    <Page narrow>
      <PageHeader title="Settings" />

      {isAdmin && (
        <section className="mb-10">
          <SectionHeader title="Terminal" description="Chat with the same agents and threads from your terminal." />
          <Card className="p-5">
            <div className="flex items-start gap-3.5">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-success-soft text-success">
                <SquareTerminal className="size-4.5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-[14px] font-semibold text-fg">Connect the TUI</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-subtle">Run this anywhere with Node 22+. Replace the token placeholder with your admin token.</p>
                <CopyField value={`npx soloagent --url ${origin} --token <token>`} className="mt-3" />
                <div className="mt-4 rounded-lg border border-border bg-surface-2/50 p-3 text-[12.5px] leading-relaxed text-subtle">
                  <p className="font-medium text-fg">Where's my token?</p>
                  <p className="mt-1">
                    For security the server never sends it back to the browser. It's either the value of the <code className="rounded bg-surface-3 px-1 font-mono text-[11.5px] text-muted">SOLOAGENT_TOKEN</code>{" "}
                    environment variable, or — if that isn't set — the token printed in the server logs when it starts (look for the <span className="font-mono">soloagent is up</span>{" "}
                    banner). On Railway, find it under your service's <span className="font-medium text-muted">Variables</span> or <span className="font-medium text-muted">Deploy logs</span>.
                  </p>
                </div>
              </div>
            </div>
          </Card>
        </section>
      )}

      {isAdmin && <AdminToken />}

      <section>
        <SectionHeader title="Appearance" />
        <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-[13.5px] font-medium text-fg">Theme</h3>
            <p className="mt-0.5 text-[12.5px] text-subtle">System follows your operating system.</p>
          </div>
          <Segmented<ThemePref>
            value={pref}
            onChange={setTheme}
            options={[
              { value: "dark", label: <><Moon className="size-3.5" /> Dark</> },
              { value: "light", label: <><Sun className="size-3.5" /> Light</> },
              { value: "system", label: <><Monitor className="size-3.5" /> System</> },
            ]}
          />
        </Card>
      </section>

      <section className="mt-10">
        <SectionHeader title="Keyboard" />
        <Card className="divide-y divide-border">
          {[
            ["Command palette", ["⌘", "K"]],
            ["Toggle sidebar", ["⌘", "\\"]],
            ["Send message", ["↵"]],
            ["New line", ["⇧", "↵"]],
            ["Queue a follow-up while the agent works", ["⌥", "↵"]],
            ["Stop the agent", ["esc"]],
          ].map(([label, keys]) => (
            <div key={label as string} className="flex items-center justify-between px-5 py-2.5 text-[13px]">
              <span className="text-muted">{label as string}</span>
              <span className="flex gap-1">
                {(keys as string[]).map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </Card>
      </section>

      <section className="mt-10">
        <SectionHeader title="Session" />
        <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-[13.5px] font-medium text-fg">Sign out of this browser</h3>
            <p className="mt-0.5 text-[12.5px] text-subtle">
              {actor ? (
                <>
                  Signed in as <span className="font-medium text-muted">{actor.kind === "token" ? "admin (token)" : actor.name}</span>
                  {actor.kind === "user" && <> · {actor.role === "admin" ? "admin" : "member"}</>}.{" "}
                </>
              ) : null}
              Your agents keep running. You'll need your {actor?.kind === "user" ? "password" : "token"} to sign back in.
            </p>
          </div>
          <Button variant="danger" icon={<LogOut className="size-4" />} onClick={onSignOut}>
            Sign out
          </Button>
        </Card>
      </section>

      <section className="mt-10">
        <SectionHeader title="About" />
        <Card className="divide-y divide-border text-[13px]">
          <Row label="Version" value={<span className="font-mono">{version ? `v${version}` : "—"}</span>} />
          <Row label="Server" value={<span className="font-mono">{location.host}</span>} />
          <Row label="Uptime" value={overview ? duration(overview.uptimeMs) : "—"} />
          <Row label="Runtime" value="Pi Durable" />
          <Row
            label="Website"
            value={
              <a href="https://soloagent.dev" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline">
                soloagent.dev <ExternalLink className="size-3" />
              </a>
            }
          />
        </Card>
      </section>
    </Page>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="text-subtle">{label}</span>
      <span className="text-fg">{value}</span>
    </div>
  );
}

function AdminToken() {
  const tokenFromEnv = useApp((s) => s.me?.tokenFromEnv ?? false);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const rotate = async () => {
    const ok = await confirm({
      title: "Rotate the admin token?",
      body: "The CLI, the TUI, scripts, and browsers signed in with the old token stop working until they use the new one. Team members signed in with a password are not affected.",
      confirmLabel: "Rotate token",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      setFresh((await client.rotateAdminToken()).token);
      toast.success("Admin token rotated", "Copy the new token now. It isn't shown again.");
    } catch (error) {
      toast.error(error, "Could not rotate the token");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-10">
      <SectionHeader title="Admin token" description="The superuser credential for the CLI, the TUI, and the API." />
      <Card className="p-5">
        <div className="flex items-start gap-3.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning">
            <KeyRound className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-fg">Rotate the admin token</h3>
            {tokenFromEnv ? (
              <p className="mt-1 text-[13px] leading-relaxed text-subtle">
                This server takes its token from the <code className="rounded bg-surface-3 px-1 font-mono text-[11.5px] text-muted">SOLOAGENT_TOKEN</code> environment variable. To rotate
                it, set a new value there and restart the server.
              </p>
            ) : (
              <>
                <p className="mt-1 text-[13px] leading-relaxed text-subtle">Replace the token if it leaked or someone who had it left the team. The new token is shown once.</p>
                <Button variant="secondary" className="mt-3" loading={busy} icon={<RotateCw className="size-4" />} onClick={rotate}>
                  Rotate token
                </Button>
              </>
            )}
            {fresh && (
              <div className="mt-4 flex flex-col gap-2">
                <CopyField value={fresh} />
                <p className="text-[12px] text-subtle">Update the CLI with <span className="font-mono">soloagent connect {location.origin} --token &lt;new token&gt;</span>.</p>
              </div>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
