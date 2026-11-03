import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { Check, ChevronDown, Copy, LoaderCircle } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { copyText } from "../lib/clipboard.ts";

// ---------------------------------------------------------------------------
// Buttons

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type ButtonSize = "xs" | "sm" | "md" | "lg";

const buttonBase =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium select-none transition-[background-color,color,border-color,box-shadow,opacity,transform] duration-150 active:translate-y-px disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2";
const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover font-mono font-semibold",
  secondary: "bg-surface-2 text-fg border border-border hover:bg-surface-3 hover:border-border-strong",
  outline: "bg-transparent text-fg border border-border hover:bg-surface-2 hover:border-border-strong",
  ghost: "bg-transparent text-muted hover:text-fg hover:bg-surface-2",
  danger: "bg-danger-soft text-danger border border-transparent hover:border-danger/30",
};
const buttonSizes: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-xs rounded-md",
  sm: "h-7 px-2.5 text-[13px] rounded-md",
  md: "h-8 px-3 text-[13px] rounded-lg",
  lg: "h-10 px-4 text-sm rounded-lg",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)} {...rest}>
      {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md"; active?: boolean }>(
  function IconButton({ label, size = "md", active, className, children, type = "button", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40",
          size === "sm" ? "size-6" : "size-8",
          active && "bg-surface-2 text-fg",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

// ---------------------------------------------------------------------------
// Form controls

const fieldBase =
  "w-full rounded-lg border border-border bg-surface-2/60 text-fg text-[13.5px] transition-[border-color,box-shadow,background-color] duration-150 hover:border-border-strong focus:border-accent-line/70 focus:bg-surface focus:outline-none focus:ring-3 focus:ring-accent-line/15 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  // Callers may override horizontal padding (e.g. room for an icon), so only pad sides they don't set.
  const pad = cn(!/\bpl-/.test(className ?? "") && "pl-3", !/\bpr-/.test(className ?? "") && "pr-3");
  return <input ref={ref} className={cn(fieldBase, !/\bh-/.test(className ?? "") && "h-9", pad, invalid && "border-danger/60 focus:border-danger focus:ring-danger/15", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, "px-3 py-2 leading-relaxed resize-y", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn("relative", className)}>
      <select className={cn(fieldBase, "h-9 appearance-none pl-3 pr-8 cursor-pointer")} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  aside,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs leading-relaxed text-subtle">{hint}</p> : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  size = "md",
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-200 disabled:opacity-50",
        size === "sm" ? "h-4.5 w-8" : "h-5 w-9",
        checked ? "border-accent-line bg-accent" : "border-border-strong bg-surface-3",
      )}
    >
      <span
        className={cn(
          "inline-block rounded-full bg-white shadow-sm transition-transform duration-200",
          size === "sm" ? "size-3" : "size-3.5",
          checked ? (size === "sm" ? "translate-x-[15px]" : "translate-x-[18px]") : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex rounded-lg border border-border bg-surface-2/60 p-0.5", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex-1 inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all duration-150",
            size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-[13px]",
            value === option.value ? "bg-surface-3 text-fg shadow-sm ring-1 ring-border-strong" : "text-subtle hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
const badgeTones: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-muted border-border",
  accent: "bg-accent-soft text-accent-text border-accent-line/20",
  success: "bg-success-soft text-success border-success/20",
  warning: "bg-warning-soft text-warning border-warning/20",
  danger: "bg-danger-soft text-danger border-danger/20",
  info: "bg-info-soft text-info border-info/20",
};

export function Badge({ tone = "neutral", children, className, dot }: { tone?: BadgeTone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11px] font-medium", badgeTones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-2 px-1 font-mono text-[10.5px] text-subtle", className)}>
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn("size-4 animate-spin text-subtle", className)} aria-label="Loading" />;
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn("skeleton", className)} style={style} />;
}

export function Card({ className, children, interactive, ...rest }: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface shadow-sm",
        interactive && "transition-[border-color,box-shadow,transform] duration-200 hover:border-border-strong hover:shadow-md",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon && (
        <div className="mb-4 grid size-11 place-items-center rounded-xl border border-border bg-surface-2 text-muted shadow-sm [&_svg]:size-5">{icon}</div>
      )}
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-subtle">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function CopyButton({ text, label = "Copy", className, size = "sm", showLabel }: { text: string; label?: string; className?: string; size?: "xs" | "sm"; showLabel?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async (event) => {
        event.stopPropagation();
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-subtle transition-colors hover:bg-surface-3 hover:text-fg",
        showLabel ? "h-7 px-2 text-xs font-medium" : size === "xs" ? "size-6" : "size-7",
        copied && "text-success hover:text-success",
        className,
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {showLabel && (copied ? "Copied" : label)}
    </button>
  );
}

/** A read-only mono field with a copy button: URLs, commands, codes. */
export function CopyField({ value, className, multiline }: { value: string; className?: string; multiline?: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2 rounded-lg border border-border bg-code py-1.5 pl-3 pr-1.5", className)}>
      <code className={cn("min-w-0 flex-1 py-0.5 font-mono text-[12.5px] text-fg", multiline ? "overflow-x-auto whitespace-pre leading-relaxed" : "truncate")}>{value}</code>
      <CopyButton text={value} />
    </div>
  );
}

export function SectionHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-subtle">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-display flex items-center gap-2.5 text-[26px] font-semibold text-fg">
          {icon}
          {title}
        </h1>
        {description && <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-subtle">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, className, wide, narrow }: { children: ReactNode; className?: string; wide?: boolean; narrow?: boolean }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn("mx-auto w-full px-4 pb-16 pt-6 sm:px-8 sm:pt-10", wide ? "max-w-7xl" : narrow ? "max-w-3xl" : "max-w-6xl", className)}>{children}</div>
    </div>
  );
}

/** A small status dot, optionally pulsing. */
export function Dot({ tone, pulse, className }: { tone: "success" | "warning" | "danger" | "neutral" | "accent" | "info"; pulse?: boolean; className?: string }) {
  const color = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    neutral: "bg-faint",
    accent: "bg-accent-text",
    info: "bg-info",
  }[tone];
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", color)} />}
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}
