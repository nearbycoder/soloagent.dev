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
import { highlightCode } from "./highlight.ts";

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

/**
 * The soloagent palette: the same ink / lime system as the dashboard's dark theme and soloagent.dev, so the
 * terminal and the browser feel like one product. Warm neutrals; lime for focus and activity.
 */
export const palette = {
  accent: "#c3e82a",
  accentBright: "#d2f53c",
  accentSoft: "#e2f59a",
  accentDeep: "#7f9e12",
  /** The mark's lime, slightly deepened so it still reads on light terminals. */
  brand: "#b6dc1f",
  muted: "#bdbbb0",
  dim: "#8d8b80",
  faint: "#5e5c52",
  green: "#8fd16a",
  yellow: "#f0b27a",
  red: "#f2857a",
  blue: "#8fb8e8",
  cyan: "#7cc9c4",
  pink: "#e89ac0",
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

/** The soloagent mark in text form: a bold "s" on a lime chip, so it reads on dark terminals. */
export const BRAND = "\x1b[48;2;210;245;60m\x1b[38;2;21;20;15m\x1b[1m s \x1b[22m\x1b[39m\x1b[49m";

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

/** Whether the next fence the renderer draws closes a block (fences come in open/close pairs). */
let fenceOpen = false;

export const markdownTheme: MarkdownTheme = {
  heading: (t) => bold(c.accentBright(t)),
  link: (t) => underline(c.blue(t)),
  linkUrl: (t) => c.dim(t),
  code: (t) => c.accentSoft(t),
  codeBlock: (t) => t,
  // Fences become a light frame: "╭─ ts" above the code, "╰─" below, a rail beside it.
  codeBlockBorder: (t) => {
    const lang = t.replace(/^`+/, "").trim();
    // A fence with a language always opens; a bare fence closes an open block or opens an unlabeled one.
    fenceOpen = lang ? true : !fenceOpen;
    return c.faint(fenceOpen ? `╭─${lang ? ` ${lang}` : ""}` : "╰─");
  },
  codeBlockIndent: c.faint("│ "),
  highlightCode: (code, lang) => highlightCode(code, lang) ?? code.split("\n").map((line) => c.accentSoft(line)),
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
