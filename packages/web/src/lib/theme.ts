import { useSyncExternalStore } from "react";

export type ThemePref = "dark" | "light" | "system";
const KEY = "solo.theme";
const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "system" ? value : "dark";
  } catch {
    return "dark";
  }
}

let pref: ThemePref = read();
const media = window.matchMedia("(prefers-color-scheme: light)");

function apply() {
  const resolved = pref === "system" ? (media.matches ? "light" : "dark") : pref;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "light" ? "#ffffff" : "#0a0a0c");
  for (const listener of listeners) listener();
}

media.addEventListener("change", () => pref === "system" && apply());
apply();

export function setTheme(next: ThemePref) {
  pref = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // private mode: theme just won't persist
  }
  apply();
}

export function resolvedTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function toggleTheme() {
  setTheme(resolvedTheme() === "dark" ? "light" : "dark");
}

export function useTheme(): { pref: ThemePref; resolved: "dark" | "light" } {
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const p = useSyncExternalStore(subscribe, () => pref);
  const resolved = useSyncExternalStore(subscribe, resolvedTheme);
  return { pref: p, resolved };
}
