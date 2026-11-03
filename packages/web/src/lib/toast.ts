import { useSyncExternalStore } from "react";
import { errorMessage, SoloApiError } from "../api/client.ts";

export type Toast = { id: number; tone: "error" | "success" | "info"; title: string; description?: string };

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(t: Omit<Toast, "id">, ttl: number) {
  const id = next++;
  toasts = [...toasts.slice(-4), { ...t, id }];
  emit();
  setTimeout(() => dismissToast(id), ttl);
}

export const toast = {
  error(error: unknown, title = "Something went wrong") {
    // A 401 already sends the app back to the login screen, which says why; don't pile a toast on top.
    if (error instanceof SoloApiError && error.status === 401) return;
    push({ tone: "error", title, description: errorMessage(error) }, 6000);
  },
  success(title: string, description?: string) {
    push({ tone: "success", title, description }, 3200);
  },
  info(title: string, description?: string) {
    push({ tone: "info", title, description }, 3600);
  },
};

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
}

// ---------------------------------------------------------------------------
// Confirm dialogs, promise based: `if (await confirm({...})) doIt()`.

export type ConfirmRequest = {
  title: string;
  body?: string;
  confirmLabel?: string;
  tone?: "danger" | "default";
};
type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };
let pending: Pending | null = null;

export function confirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    pending?.resolve(false);
    pending = { ...request, resolve };
    emit();
  });
}

export function settleConfirm(ok: boolean) {
  pending?.resolve(ok);
  pending = null;
  emit();
}

export function usePendingConfirm(): Pending | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
}
