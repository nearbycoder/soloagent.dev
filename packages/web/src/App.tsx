import { lazy, Suspense, useEffect, useState } from "react";
import { client, setUnauthorizedHandler } from "./api/client.ts";
import { endSession, startSession } from "./api/store.ts";
import { ConfirmHost, Toaster } from "./components/overlay.tsx";
import { SparkMark } from "./components/brand.tsx";
import { Login } from "./pages/Login.tsx";
import { InvitePage } from "./pages/Invite.tsx";

const Shell = lazy(() => import("./components/Shell.tsx").then((m) => ({ default: m.Shell })));

type Phase = { name: "checking" } | { name: "login"; expired?: boolean } | { name: "invite"; code: string } | { name: "app" };

/** Invite links open before sign-in: /invite/<code>. */
const inviteCode = () => /^\/invite\/([^/]+)\/?$/.exec(location.pathname)?.[1];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function App() {
  const [phase, setPhase] = useState<Phase>(() => {
    const code = inviteCode();
    return code ? { name: "invite", code: safeDecode(code) } : { name: "checking" };
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
        <Suspense fallback={<Splash />}>
          <Shell
            onSignOut={async () => {
              await client.logout().catch(() => {});
              endSession();
              setPhase({ name: "login" });
            }}
          />
        </Suspense>
      )}
      <Toaster />
      <ConfirmHost />
    </>
  );
}

function Splash() {
  return (
    <div className="grid h-full place-items-center bg-bg">
      <div className="relative">
        <div aria-hidden className="absolute inset-0 -z-10 scale-150 rounded-full bg-accent/20 blur-2xl" />
        <SparkMark className="size-9 animate-pulse-soft" />
      </div>
    </div>
  );
}
