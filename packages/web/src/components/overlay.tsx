import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { dismissToast, settleConfirm, usePendingConfirm, useToasts } from "../lib/toast.ts";
import { Button, IconButton } from "./ui.tsx";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Escape-to-close, focus the panel on open, keep Tab inside, restore focus on close. */
function useDialogBehavior(open: boolean, onClose: () => void, panel: React.RefObject<HTMLElement | null>, autoFocus = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    if (node && autoFocus) {
      // Focus an explicitly marked control, otherwise the panel itself (not the close button).
      const target = node.querySelector<HTMLElement>("[data-autofocus]");
      (target ?? node).focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Let the innermost open dialog handle Escape.
        const dialogs = document.querySelectorAll("[data-dialog]");
        if (dialogs[dialogs.length - 1] !== panel.current) return;
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab" && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [open, panel, autoFocus]);
}

export function Modal({
  open,
  onClose,
  children,
  className,
  title,
  description,
  footer,
  size = "md",
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  dismissable?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogBehavior(open, () => dismissable && onClose(), panel);
  if (!open) return null;
  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)] backdrop-blur-[2px]" onClick={() => dismissable && onClose()} />
      <div
        ref={panel}
        data-dialog
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[92dvh] w-full animate-scale-in flex-col overflow-hidden rounded-t-2xl border border-border bg-overlay shadow-lg outline-none sm:rounded-2xl",
          width,
          className,
        )}
      >
        {title && (
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h2>
              {description && <p className="mt-0.5 text-[13px] text-subtle">{description}</p>}
            </div>
            {dismissable && (
              <IconButton label="Close" size="sm" onClick={onClose} className="-mr-1 mt-0.5">
                <X className="size-4" />
              </IconButton>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/40 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-xl",
  icon,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  icon?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogBehavior(open, onClose, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 animate-fade-in bg-[var(--scrim)]" onClick={onClose} />
      <div
        ref={panel}
        data-dialog
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn("relative flex h-full w-full animate-slide-in-right flex-col border-l border-border bg-overlay shadow-lg outline-none", width)}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            {icon}
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold tracking-tight text-fg">{title}</h2>
              {description && <p className="truncate text-[12.5px] text-subtle">{description}</p>}
            </div>
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center gap-2 border-t border-border bg-surface-2/40 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Popover menu anchored to a trigger, rendered in a portal so it is never clipped.

export function Popover({
  open,
  onClose,
  anchor,
  children,
  align = "start",
  className,
  matchWidth,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  matchWidth?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const h = p.offsetHeight;
      const w = matchWidth ? a.width : p.offsetWidth;
      const up = a.bottom + h + 8 > window.innerHeight && a.top - h - 8 > 0;
      let left = align === "end" ? a.right - w : a.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      setPos({ top: up ? a.top - h - 6 : a.bottom + 6, left, width: a.width, up });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, align, matchWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: matchWidth ? pos?.width : undefined, visibility: pos ? "visible" : "hidden" }}
      className={cn("fixed z-[60] animate-scale-in overflow-hidden rounded-xl border border-border bg-overlay p-1 shadow-lg", className)}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  active,
  hint,
  disabled,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  active?: boolean;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        danger ? "text-danger hover:bg-danger-soft" : "text-fg hover:bg-surface-2",
        active && "bg-surface-2",
      )}
    >
      {icon && <span className={cn(danger ? "text-danger" : "text-subtle")}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-xs text-subtle">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{children}</div>;
}

// ---------------------------------------------------------------------------
// Hosts for the global toast and confirm stores

export function Toaster() {
  const toasts = useToasts();
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className="pointer-events-auto flex w-full max-w-sm animate-slide-up items-start gap-3 rounded-xl border border-border bg-overlay px-3.5 py-3 shadow-lg"
        >
          <span className={cn("mt-0.5", t.tone === "error" ? "text-danger" : t.tone === "success" ? "text-success" : "text-info")}>
            {t.tone === "error" ? <CircleAlert className="size-4" /> : t.tone === "success" ? <CircleCheck className="size-4" /> : <Info className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-fg">{t.title}</p>
            {t.description && <p className="mt-0.5 break-words text-[12.5px] leading-relaxed text-muted">{t.description}</p>}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="-mr-1 rounded p-0.5 text-subtle hover:text-fg">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function ConfirmHost() {
  const pending = usePendingConfirm();
  return (
    <Modal
      open={!!pending}
      onClose={() => settleConfirm(false)}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => settleConfirm(false)}>
            Cancel
          </Button>
          <Button data-autofocus variant={pending?.tone === "danger" ? "danger" : "primary"} onClick={() => settleConfirm(true)}>
            {pending?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {pending && (
        <div className="px-5 pb-5 pt-5">
          <h2 className="text-[15px] font-semibold text-fg">{pending.title}</h2>
          {pending.body && <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{pending.body}</p>}
        </div>
      )}
    </Modal>
  );
}
