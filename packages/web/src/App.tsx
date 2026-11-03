import { useEffect, useState } from "react";
import { client, setUnauthorizedHandler } from "./api/client.ts";
import { endSession, startSession } from "./api/store.ts";
import { ConfirmHost, Toaster } from "./components/overlay.tsx";
import { SparkMark } from "./components/brand.tsx";
import { Shell } from "./components/Shell.tsx";
import { Login } from "./pages/Login.tsx";

type Phase = { name: "checking" } | { name: "login"; expired?: boolean } | { name: "app" };

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: "checking" });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      endSession();
      setPhase((p) => (p.name === "app" ? { name: "login", expired: true } : p.name === "checking" ? { name: "login" } : p));
    });
    let cancelled = false;
    client
      .me()
      .then((me) => {
        if (cancelled) return;
        startSession(me.version);
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
          onLoggedIn={(version) => {
            startSession(version);
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
