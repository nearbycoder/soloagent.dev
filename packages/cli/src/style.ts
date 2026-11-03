/**
 * Tiny ANSI helpers for the non-interactive commands. Colors switch off when the stream is not a
 * terminal or NO_COLOR is set, so output stays clean in pipes and scripts.
 */

const enabled = (stream: NodeJS.WriteStream) => Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

export type Paint = {
  accent: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  cyan: (s: string) => string;
  hex: (hex: string) => (s: string) => string;
};

export function paint(stream: NodeJS.WriteStream = process.stdout): Paint {
  const on = enabled(stream);
  const wrap = (open: string, close: string) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  const hex = (value: string) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
    if (!m) return (s: string) => s;
    return wrap(`38;2;${parseInt(m[1]!, 16)};${parseInt(m[2]!, 16)};${parseInt(m[3]!, 16)}`, "39");
  };
  return {
    accent: hex("#8b5cf6"),
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    green: hex("#34d399"),
    yellow: hex("#fbbf24"),
    red: hex("#f87171"),
    cyan: hex("#22d3ee"),
    hex,
  };
}

export const out = (text = "") => void process.stdout.write(`${text}\n`);
export const err = (text = "") => void process.stderr.write(`${text}\n`);

/** Display width, ignoring ANSI escapes. Good enough for tables of mostly-ASCII text. */
export function width(text: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0)!;
    w += code >= 0x1100 && /\p{Extended_Pictographic}|\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(ch) ? 2 : 1;
  }
  return w;
}

/** Render rows as an aligned table. The header row is dimmed. */
export function table(rows: string[][], header: string[], p: Paint = paint()): string {
  const all = [header, ...rows];
  const cols = header.length;
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...all.map((r) => width(r[c] ?? ""))));
  const line = (row: string[], style?: (s: string) => string) =>
    row
      .map((cell, c) => {
        const padded = c === cols - 1 ? cell : cell + " ".repeat(Math.max(0, widths[c]! - width(cell)));
        return style ? style(padded) : padded;
      })
      .join("  ")
      .trimEnd();
  return [line(header, p.dim), ...rows.map((r) => line(r))].join("\n");
}
