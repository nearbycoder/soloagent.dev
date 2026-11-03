import { ExternalLink, LogOut, Monitor, Moon, SquareTerminal, Sun } from "lucide-react";
import { useApp } from "../api/store.ts";
import { Button, Card, CopyField, Kbd, Page, PageHeader, Segmented, SectionHeader } from "../components/ui.tsx";
import { duration } from "../lib/format.ts";
import { setTheme, useTheme, type ThemePref } from "../lib/theme.ts";

export function SettingsPage({ onSignOut }: { onSignOut: () => void }) {
  const version = useApp((s) => s.version);
  const overview = useApp((s) => s.overview);
  const { pref } = useTheme();
  const origin = location.origin;

  return (
    <Page narrow>
      <PageHeader title="Settings" />

      <section>
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

      <section className="mt-10">
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
            <p className="mt-0.5 text-[12.5px] text-subtle">Your agents keep running. You'll need the token to sign back in.</p>
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
