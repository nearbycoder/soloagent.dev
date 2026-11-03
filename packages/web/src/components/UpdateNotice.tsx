import { useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { useApp } from "../api/store.ts";
import { linkHandler } from "../lib/router.ts";

const DISMISS_KEY = "solo.update.dismissed";

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/** Sidebar footer note when a newer release exists. Dismissed per version. */
export function UpdateNotice({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const update = useApp((s) => s.overview?.update);
  const [dismissed, setDismissed] = useState(dismissedVersion);
  if (!update?.updateAvailable || !update.latest || dismissed === update.latest) return null;
  const latest = update.latest;

  if (collapsed) {
    return (
      <a
        href="/settings"
        onClick={linkHandler("/settings", onNavigate)}
        title={`soloagent v${latest} is available`}
        aria-label={`soloagent v${latest} is available`}
        className="mx-auto mb-1 grid size-7 place-items-center rounded-md text-accent-text hover:bg-surface-2"
      >
        <ArrowUpCircle className="size-4" />
      </a>
    );
  }

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, latest);
    } catch {
      // the notice just comes back next load
    }
    setDismissed(latest);
  };

  return (
    <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-accent-line/25 bg-accent-soft px-2.5 py-2 text-[12px]">
      <ArrowUpCircle className="mt-px size-3.5 shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1 leading-snug">
        <p className="font-medium text-fg">v{latest} available</p>
        <p className="mt-0.5 text-subtle">
          {update.url && (
            <>
              <a href={update.url} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">
                Release notes
              </a>
              {" · "}
            </>
          )}
          <a href="/settings" onClick={linkHandler("/settings", onNavigate)} className="text-accent-text hover:underline">
            How to upgrade
          </a>
        </p>
      </div>
      <button type="button" onClick={dismiss} aria-label="Dismiss update notice" title="Dismiss" className="-mr-1 -mt-0.5 grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-surface-2 hover:text-fg">
        <X className="size-3" />
      </button>
    </div>
  );
}
