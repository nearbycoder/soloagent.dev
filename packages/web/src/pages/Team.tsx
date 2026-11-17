import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, KeyRound, Link2, ShieldCheck, Trash, UserPlus, Users } from "lucide-react";
import type { CreatedInvite, Invite, Role, User } from "@soloagent/client";
import { client } from "../api/client.ts";
import { useApp, useIsAdmin } from "../api/store.ts";
import { Badge, Button, Card, CopyField, EmptyState, Field, IconButton, Input, Page, PageHeader, Select, Skeleton } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { fullDate, initials, relativeTime } from "../lib/format.ts";
import { linkHandler } from "../lib/router.ts";
import { confirm, toast } from "../lib/toast.ts";

export function Team() {
  const isAdmin = useIsAdmin();
  const me = useApp((s) => s.me);
  const [users, setUsers] = useState<User[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);

  const load = async () => {
    try {
      const [u, i] = await Promise.all([client.users(), client.invites()]);
      setUsers(u);
      setInvites(i);
    } catch (error) {
      toast.error(error, "Could not load the team");
    }
  };

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin]);

  if (!isAdmin) return <AdminsOnly what="the team" />;

  const pending = invites?.filter((i) => i.usedAt === null && i.expiresAt > Date.now()) ?? null;
  const admins = users?.filter((u) => u.role === "admin").length ?? 0;

  const changeRole = async (user: User, role: Role) => {
    try {
      const updated = await client.updateUser(user.id, { role });
      setUsers((list) => list?.map((u) => (u.id === user.id ? updated : u)) ?? null);
      toast.success(`${user.name} is now ${role === "admin" ? "an admin" : "a member"}`);
    } catch (error) {
      toast.error(error, "Could not change the role");
    }
  };

  const remove = async (user: User) => {
    const ok = await confirm({
      title: `Remove ${user.name}?`,
      body: "They're signed out everywhere and can't sign in again. Their messages stay in your history.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await client.deleteUser(user.id);
      setUsers((list) => list?.filter((u) => u.id !== user.id) ?? null);
      toast.success(`${user.name} removed`);
    } catch (error) {
      toast.error(error, "Could not remove");
    }
  };

  const revoke = async (invite: Invite) => {
    try {
      await client.revokeInvite(invite.id);
      setInvites((list) => list?.filter((i) => i.id !== invite.id) ?? null);
      toast.success("Invite revoked");
    } catch (error) {
      toast.error(error, "Could not revoke");
    }
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Configure"
        title="Team"
        description="People who can sign in to this dashboard. Admins approve tool calls and manage agents, providers, connections, and the team. Members chat, view agents, and see usage."
      />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-10">
        <div className="flex min-w-0 flex-col gap-10 lg:order-1">
          <section>
            <ListHeader
              title="People"
              meta={users ? `${users.length} ${users.length === 1 ? "person" : "people"} · ${admins} ${admins === 1 ? "admin" : "admins"}` : undefined}
              description="Everyone with a password sign-in. The admin token always works too."
            />
            <Card className="divide-y divide-border overflow-hidden">
              <TokenRow />
              {!users ? (
                [0, 1].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                    <Skeleton className="size-8 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                  </div>
                ))
              ) : users.length === 0 ? (
                <EmptyState
                  icon={<Users />}
                  title="Nobody yet"
                  description="Create an invite link and send it to a teammate. They choose a name and password, and they're in."
                  className="py-12"
                />
              ) : (
                users.map((user) => (
                  <PersonRow key={user.id} user={user} self={me?.actor.userId === user.id} onRole={(role) => void changeRole(user, role)} onRemove={() => void remove(user)} />
                ))
              )}
            </Card>
          </section>

          <section>
            <ListHeader title="Open invites" meta={pending ? `${pending.length} open` : undefined} description="Each link works once and expires after 7 days." />
            {!pending ? (
              <Skeleton className="h-[60px] rounded-xl" />
            ) : pending.length === 0 ? (
              <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-[13px] text-subtle">
                <Link2 className="size-4 text-faint" />
                No open invites.
              </p>
            ) : (
              <Card className="divide-y divide-border overflow-hidden">
                {pending.map((invite) => (
                  <div key={invite.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2/40">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed border-border-strong text-subtle">
                      <Link2 className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
                        <span className="truncate">{invite.name ?? "Anyone with the link"}</span>
                        <RoleBadge role={invite.role} />
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[11.5px] text-faint">
                        by {invite.createdBy} · <span title={fullDate(invite.createdAt)}>{relativeTime(invite.createdAt)}</span> · expires{" "}
                        <span title={fullDate(invite.expiresAt)}>{relativeTime(invite.expiresAt)}</span>
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => revoke(invite)}>
                      Revoke
                    </Button>
                  </div>
                ))}
              </Card>
            )}
          </section>
        </div>

        <div className="-order-1 lg:sticky lg:top-6 lg:order-2">
          <InviteForm onCreated={(created) => setInvites((list) => [created.invite, ...(list ?? [])])} />
        </div>
      </div>
    </Page>
  );
}

function ListHeader({ title, meta, description }: { title: string; meta?: string; description?: string }) {
  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
        {meta && <span className="font-mono text-[11px] text-faint">{meta}</span>}
      </div>
      {description && <p className="mt-0.5 text-[13px] text-subtle">{description}</p>}
    </div>
  );
}

function RoleBadge({ role }: { role: Role }) {
  return role === "admin" ? (
    <Badge tone="warning">
      <ShieldCheck />
      Admin
    </Badge>
  ) : (
    <Badge>Member</Badge>
  );
}

/** The superuser credential, shown first so it's clear who else can always sign in. */
function TokenRow() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-surface-2/30 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border-strong bg-surface-2 text-subtle">
        <KeyRound className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
          Admin token
          <Badge className="font-mono">superuser</Badge>
        </p>
        <p className="mt-0.5 truncate font-mono text-[11.5px] text-faint">cli · tui · api · always has admin access</p>
      </div>
      <a href="/settings" onClick={linkHandler("/settings")} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-subtle transition-colors hover:bg-surface-2 hover:text-fg">
        Rotate in Settings
        <ArrowRight className="size-3.5" />
      </a>
    </div>
  );
}

function PersonRow({ user, self, onRole, onRemove }: { user: User; self: boolean; onRole: (role: Role) => void; onRemove: () => void }) {
  return (
    <div className="group flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2/40">
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-b from-surface-3 to-surface-2 font-mono text-[11px] font-semibold text-muted ring-1",
          self ? "ring-accent-line/50" : "ring-border-strong",
        )}
      >
        {initials(user.name)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
          <span className="truncate">{user.name}</span>
          {self && <Badge tone="accent">You</Badge>}
        </p>
        <p className="mt-0.5 truncate font-mono text-[11.5px] text-faint">
          joined <span title={fullDate(user.createdAt)}>{relativeTime(user.createdAt)}</span>
          {" · "}
          {user.lastSeenAt ? (
            <>
              active <span title={fullDate(user.lastSeenAt)}>{relativeTime(user.lastSeenAt)}</span>
            </>
          ) : (
            "never signed in"
          )}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Select aria-label={`Role for ${user.name}`} value={user.role} onChange={(e) => onRole(e.target.value as Role)} className="w-[120px]">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </Select>
        <IconButton label={`Remove ${user.name}`} onClick={onRemove} className="text-faint hover:bg-danger-soft hover:text-danger">
          <Trash className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}

const ROLES: { value: Role; title: string; description: string }[] = [
  { value: "member", title: "Member", description: "Chat with agents, view them, and see usage." },
  { value: "admin", title: "Admin", description: "Also approve tool calls and manage agents, providers, connections, and the team." },
];

function InviteForm({ onCreated }: { onCreated: (created: CreatedInvite) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await client.createInvite({ role, name: name.trim() || undefined });
      // The server builds the URL from the request; prefer what the browser sees, which is right behind most proxies.
      setCreated({ ...result, url: `${location.origin}${result.path}` });
      onCreated(result);
      setName("");
    } catch (error) {
      toast.error(error, "Could not create the invite");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="lit overflow-hidden">
      <form onSubmit={create} className="flex flex-col gap-5 p-5">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border-strong bg-surface-2 text-fg shadow-xs">
            <UserPlus className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Invite someone</h3>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-subtle">A one-time link. They open it, choose a name and password, and they're in.</p>
          </div>
        </div>
        <Field label="Name" htmlFor="invite-name" hint="Optional. They can change it when they join.">
          <Input id="invite-name" value={name} placeholder="Ann" onChange={(e) => setName(e.target.value)} />
        </Field>
        <RolePicker value={role} onChange={setRole} />
        <Button type="submit" variant="primary" loading={busy} icon={<Link2 />} className="w-full">
          Create invite link
        </Button>
      </form>
      {created && (
        <div className="flex animate-rise flex-col gap-2.5 border-t border-border bg-surface-2/50 p-5">
          <p className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <span className="grid size-5 place-items-center rounded-full bg-success-soft text-success ring-1 ring-success/25">
              <Check className="size-3" strokeWidth={3} />
            </span>
            Invite link for {created.invite.name ?? (created.invite.role === "admin" ? "an admin" : "a member")}
          </p>
          <CopyField value={created.url} />
          <p className="text-[12px] leading-relaxed text-subtle">Send it privately. It works once, expires in 7 days, and isn't shown again.</p>
        </div>
      )}
    </Card>
  );
}

/** Two radio cards. Arrow keys move between them, like native radios. */
function RolePicker({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, step: number) => {
    const next = (from + step + ROLES.length) % ROLES.length;
    onChange(ROLES[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="text-[13px] font-medium text-fg">
        Role
      </span>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="grid gap-2">
        {ROLES.map((option, index) => {
          const checked = value === option.value;
          return (
            <button
              key={option.value}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-labelledby={`${id}-${option.value}`}
              aria-describedby={`${id}-${option.value}-d`}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                  event.preventDefault();
                  move(index, 1);
                } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  move(index, -1);
                }
              }}
              className={cn(
                "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-150",
                checked ? "border-accent-line/60 bg-surface-2 shadow-[0_0_0_3px_var(--focus-ring)]" : "border-border bg-field hover:border-border-strong",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                  checked ? "border-accent-line bg-accent-line" : "border-border-strong bg-surface",
                )}
              >
                {checked && <span className="size-1.5 rounded-full bg-[var(--panel)]" />}
              </span>
              <span className="min-w-0">
                <span id={`${id}-${option.value}`} className="block text-[13px] font-medium text-fg">
                  {option.title}
                </span>
                <span id={`${id}-${option.value}-d`} className="mt-0.5 block text-[12px] leading-snug text-subtle">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Shown to members who open an admin page by URL. */
export function AdminsOnly({ what }: { what: string }) {
  return (
    <Page narrow>
      <Card className="mt-6 overflow-hidden">
        <EmptyState
          icon={<ShieldCheck />}
          title="Admins only"
          description={`Only admins can manage ${what}. Ask an admin on your team if something needs changing.`}
          action={
            <a href="/" onClick={linkHandler("/")} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-control px-3 text-[13px] font-medium text-fg shadow-xs transition-colors hover:bg-control-hover">
              Back to Overview
              <ArrowRight className="size-3.5" />
            </a>
          }
        />
      </Card>
    </Page>
  );
}
