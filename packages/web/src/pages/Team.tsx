import { useEffect, useState } from "react";
import { Link2, ShieldCheck, Trash, UserPlus, Users } from "lucide-react";
import type { CreatedInvite, Invite, Role, User } from "@soloagent/client";
import { client } from "../api/client.ts";
import { useApp, useIsAdmin } from "../api/store.ts";
import { Badge, Button, Card, CopyField, EmptyState, Field, Input, Page, PageHeader, SectionHeader, Segmented, Select, Skeleton } from "../components/ui.tsx";
import { initials, relativeTime } from "../lib/format.ts";
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
    <Page narrow>
      <PageHeader
        title="Team"
        description="People who can sign in to this dashboard. Admins manage agents, providers, connections, and the team. Members chat, view agents, and see usage."
      />

      <InviteForm onCreated={(created) => setInvites((list) => [created.invite, ...(list ?? [])])} />

      <section className="mt-10">
        <SectionHeader title="People" description="The admin token always works too: it's the superuser the CLI and API use." />
        {!users ? (
          <Skeleton className="h-[120px] rounded-xl" />
        ) : users.length === 0 ? (
          <Card className="border-dashed bg-transparent shadow-none">
            <EmptyState icon={<Users />} title="Nobody yet" description="Create an invite link above and send it to a teammate." />
          </Card>
        ) : (
          <Card className="divide-y divide-border">
            {users.map((user) => {
              const self = me?.actor.userId === user.id;
              return (
                <div key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-[12px] font-semibold text-muted">{initials(user.name)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
                      <span className="truncate">{user.name}</span>
                      {self && <Badge tone="accent">You</Badge>}
                    </p>
                    <p className="text-[12px] text-subtle">
                      Joined {relativeTime(user.createdAt)}
                      {user.lastSeenAt ? ` · active ${relativeTime(user.lastSeenAt)}` : " · never signed in"}
                    </p>
                  </div>
                  <Select aria-label={`Role for ${user.name}`} value={user.role} onChange={(e) => void changeRole(user, e.target.value as Role)} className="w-32">
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </Select>
                  <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-soft hover:text-danger" icon={<Trash className="size-3.5" />} onClick={() => remove(user)}>
                    Remove
                  </Button>
                </div>
              );
            })}
          </Card>
        )}
      </section>

      <section className="mt-10">
        <SectionHeader title="Open invites" description="Each link works once and expires after 7 days." />
        {!pending ? (
          <Skeleton className="h-[64px] rounded-xl" />
        ) : pending.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-[13px] text-subtle">No open invites.</p>
        ) : (
          <Card className="divide-y divide-border">
            {pending.map((invite) => (
              <div key={invite.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Link2 className="size-4 shrink-0 text-subtle" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13.5px] text-fg">
                    <span className="truncate">{invite.name ?? "Anyone with the link"}</span>
                    <Badge tone={invite.role === "admin" ? "warning" : "neutral"}>{invite.role === "admin" ? "Admin" : "Member"}</Badge>
                  </p>
                  <p className="text-[12px] text-subtle">
                    By {invite.createdBy} · {relativeTime(invite.createdAt)} · expires {relativeTime(invite.expiresAt)}
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
    </Page>
  );
}

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
    <Card className="p-5">
      <form onSubmit={create} className="flex flex-col gap-4">
        <div className="flex items-start gap-3.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
            <UserPlus className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-fg">Invite someone</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-subtle">Create a one-time link. They open it, choose a name and password, and they're in.</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <Field label="Name" htmlFor="invite-name" hint="Optional. They can change it when they join.">
            <Input id="invite-name" value={name} placeholder="Ann" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Role">
            <Segmented<Role>
              value={role}
              onChange={setRole}
              options={[
                { value: "member", label: "Member", title: "Chat, view agents, see usage" },
                { value: "admin", label: "Admin", title: "Also manage agents, providers, connections, and the team" },
              ]}
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy} icon={<Link2 className="size-4" />}>
            Create invite link
          </Button>
        </div>
      </form>
      {created && (
        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-accent-line/40 bg-accent-soft p-4">
          <p className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <ShieldCheck className="size-4 text-accent-text" />
            Invite link for {created.invite.name ?? (created.invite.role === "admin" ? "an admin" : "a member")}
          </p>
          <CopyField value={created.url} />
          <p className="text-[12px] text-subtle">Send it privately. It works once, expires in 7 days, and isn't shown again.</p>
        </div>
      )}
    </Card>
  );
}

/** Shown to members who open an admin page by URL. */
export function AdminsOnly({ what }: { what: string }) {
  return (
    <Page narrow>
      <Card>
        <EmptyState icon={<ShieldCheck />} title="Admins only" description={`Only admins can manage ${what}. Ask an admin on your team if something needs changing.`} />
      </Card>
    </Page>
  );
}
