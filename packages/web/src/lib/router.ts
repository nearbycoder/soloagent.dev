import { useSyncExternalStore } from "react";

/** A tiny history router. Paths look like "/chat/thr_123". */
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

window.addEventListener("popstate", notify);

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (options.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  notify();
}

export function usePath(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => location.pathname,
  );
}

export type Route =
  | { page: "overview" }
  | { page: "chat"; threadId?: string; agentId?: string; isNew?: boolean }
  | { page: "agents"; agentId?: string }
  | { page: "providers" }
  | { page: "connections"; connectorId?: string }
  | { page: "activity" }
  | { page: "usage" }
  | { page: "settings" };

export function parseRoute(path: string): Route {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case undefined:
    case "overview":
      return { page: "overview" };
    case "chat":
      if (parts[1] === "new") return { page: "chat", isNew: true, agentId: parts[2] };
      return { page: "chat", threadId: parts[1] };
    case "agents":
      return { page: "agents", agentId: parts[1] };
    case "providers":
      return { page: "providers" };
    case "connections":
      return { page: "connections", connectorId: parts[1] };
    case "activity":
      return { page: "activity" };
    case "usage":
      return { page: "usage" };
    case "settings":
      return { page: "settings" };
    default:
      return { page: "overview" };
  }
}

/** Anchor click handler that routes in-app without a reload, but keeps cmd/ctrl-click working. */
export function linkHandler(to: string, after?: () => void) {
  return (event: React.MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
    after?.();
  };
}
