import {
  type EditorTheme,
  foregroundAnsi,
  getTerminalColorMode,
  type MarkdownTheme,
  mixColors,
  parseColor,
  type SelectListTheme,
  colorToHex,
} from "@earendil-works/pi-tui";

export type Style = (text: string) => string;

const mode = getTerminalColorMode();
const fgCache = new Map<string, Style>();

/** Foreground color from a hex string, converted once for the terminal's color mode. */
export function fg(hex: string): Style {
  let style = fgCache.get(hex);
  if (!style) {
    let code: string;
    try {
      code = foregroundAnsi(parseColor(hex), mode);
    } catch {
      code = "";
    }
    style = code ? (text: string) => `${code}${text}\x1b[39m` : (text: string) => text;
    fgCache.set(hex, style);
  }
  return style;
}

export const bold: Style = (t) => `\x1b[1m${t}\x1b[22m`;
export const dimAttr: Style = (t) => `\x1b[2m${t}\x1b[22m`;
export const italic: Style = (t) => `\x1b[3m${t}\x1b[23m`;
export const underline: Style = (t) => `\x1b[4m${t}\x1b[24m`;
export const strike: Style = (t) => `\x1b[9m${t}\x1b[29m`;
export const inverse: Style = (t) => `\x1b[7m${t}\x1b[27m`;

/** The soloagent palette. Violet accent, cool neutrals that read on dark and light terminals. */
export const palette = {
  accent: "#8b5cf6",
  accentBright: "#a78bfa",
  accentSoft: "#c4b5fd",
  accentDeep: "#6d28d9",
  /** The mark's lime, slightly deepened so it still reads on light terminals. */
  brand: "#b6dc1f",
  muted: "#8e8ea3",
  dim: "#6b6b80",
  faint: "#45455a",
  green: "#34d399",
  yellow: "#fbbf24",
  red: "#f87171",
  blue: "#60a5fa",
  cyan: "#22d3ee",
  pink: "#f472b6",
} as const;

export const c = {
  accent: fg(palette.accent),
  accentBright: fg(palette.accentBright),
  accentSoft: fg(palette.accentSoft),
  brand: fg(palette.brand),
  muted: fg(palette.muted),
  dim: fg(palette.dim),
  faint: fg(palette.faint),
  green: fg(palette.green),
  yellow: fg(palette.yellow),
  red: fg(palette.red),
  blue: fg(palette.blue),
  cyan: fg(palette.cyan),
};

/** The soloagent mark in text form: one live agent. */
export const BRAND = "●";

/** A color between two hex colors, 0..1. Used for the wordmark gradient. */
export function blend(a: string, b: string, t: number): string {
  try {
    return colorToHex(mixColors(parseColor(a), parseColor(b), t, "oklch"));
  } catch {
    return a;
  }
}

/** Agent colors are user supplied; fall back to the accent when one does not parse. */
export function agentColor(hex: string | undefined): Style {
  if (!hex) return c.accent;
  try {
    parseColor(hex);
    return fg(hex);
  } catch {
    return c.accent;
  }
}

export const markdownTheme: MarkdownTheme = {
  heading: (t) => bold(c.accentBright(t)),
  link: (t) => underline(c.blue(t)),
  linkUrl: (t) => c.dim(t),
  code: (t) => c.accentSoft(t),
  codeBlock: (t) => t,
  codeBlockBorder: (t) => c.faint(t),
  quote: (t) => italic(c.muted(t)),
  quoteBorder: (t) => c.accent(t),
  hr: (t) => c.faint(t),
  listBullet: (t) => c.accent(t),
  bold,
  italic,
  strikethrough: strike,
  underline,
};

export const thinkingMarkdownTheme: MarkdownTheme = {
  ...markdownTheme,
  heading: (t) => bold(c.dim(t)),
  code: (t) => c.dim(t),
  listBullet: (t) => c.dim(t),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (t) => c.accent(t),
  selectedText: (t) => bold(c.accentBright(t)),
  description: (t) => c.dim(t),
  scrollInfo: (t) => c.dim(t),
  noMatch: (t) => c.dim(t),
};

export const editorTheme: EditorTheme = {
  borderColor: (t) => c.accent(t),
  selectList: selectListTheme,
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Spinner frame derived from the clock, so every spinner on screen moves in step. */
export function spinnerFrame(): string {
  return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!;
}
