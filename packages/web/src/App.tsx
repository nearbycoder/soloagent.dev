import { useEffect, useState } from "react";
import { client, setUnauthorizedHandler } from "./api/client.ts";
import { endSession, startSession } from "./api/store.ts";
import { ConfirmHost, Toaster } from "./components/overlay.tsx";
import { SparkMark } from "./components/brand.tsx";
import { Shell } from "./components/Shell.tsx";
import { Login } from "./pages/Login.tsx";
import { InvitePage } from "./pages/Invite.tsx";

type Phase = { name: "checking" } | { name: "login"; expired?: boolean } | { name: "invite"; code: string } | { name: "app" };

/** Invite links open before sign-in: /invite/<code>. */
const inviteCode = () => /^\/invite\/([^/]+)\/?$/.exec(location.pathname)?.[1];

export function App() {
  const [phase, setPhase] = useState<Phase>(() => {
    const code = inviteCode();
    return code ? { name: "invite", code: decodeURIComponent(code) } : { name: "checking" };
  });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      endSession();
      setPhase((p) => (p.name === "app" ? { name: "login", expired: true } : p.name === "checking" ? { name: "login" } : p));
    });
    let cancelled = false;
    if (inviteCode()) return;
    client
      .me()
      .then((me) => {
        if (cancelled) return;
        startSession(me);
        setPhase({ name: "app" });
      })
      .catch(() => !cancelled && setPhase({ name: "login" }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {phase.name === "checking" && <Splash />}
      {phase.name === "login" && (
        <Login
          expired={phase.expired}
          onLoggedIn={(me) => {
            startSession(me);
            setPhase({ name: "app" });
          }}
        />
      )}
      {phase.name === "invite" && (
        <InvitePage
          code={phase.code}
          onJoined={(me) => {
            history.replaceState(null, "", "/");
            startSession(me);
            setPhase({ name: "app" });
          }}
        />
      )}
      {phase.name === "app" && (
        <Shell
          onSignOut={async () => {
            await client.logout().catch(() => {});
            endSession();
            setPhase({ name: "login" });
          }}
        />
      )}
      <Toaster />
      <ConfirmHost />
    </>
  );
}

function Splash() {
  return (
    <div className="grid h-full place-items-center bg-bg">
      <SparkMark className="size-7 animate-pulse-soft text-accent" />
    </div>
  );
}
