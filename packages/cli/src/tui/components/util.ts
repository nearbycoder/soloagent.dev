import { type Component, replaceControlCharacters, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Clamp a line to the width. Every custom line goes through this: an overlong line is a render error. */
export function fit(line: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…");
}

export function fitAll(lines: string[], width: number): string[] {
  return lines.map((line) => fit(line, width));
}

export function padRight(line: string, width: number): string {
  const w = visibleWidth(line);
  return w >= width ? fit(line, width) : line + " ".repeat(width - w);
}

export function center(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w >= width) return fit(line, width);
  return " ".repeat(Math.floor((width - w) / 2)) + line;
}

/** Left text, right text, spaced to fill the width. The left side gives way first. */
export function spread(left: string, right: string, width: number): string {
  const rw = visibleWidth(right);
  if (rw >= width) return fit(right, width);
  const lw = Math.min(visibleWidth(left), width - rw - 1);
  const l = fit(left, Math.max(0, lw));
  return l + " ".repeat(Math.max(1, width - visibleWidth(l) - rw)) + right;
}

/** Wrap plain text into lines with an indent/gutter prefix. */
export function wrapWith(text: string, width: number, prefix: string, style: (s: string) => string = (s) => s): string[] {
  const inner = Math.max(1, width - visibleWidth(prefix));
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const wrapped = raw.length === 0 ? [""] : wrapTextWithAnsi(raw, inner);
    for (const line of wrapped) out.push(prefix + style(line));
  }
  return out;
}

/** Make untrusted text (tool output, user text) safe to print: no escapes, no control chars, tabs expanded. */
export function sanitize(text: string): string {
  return stripTerminalSequences(text.replace(/\r\n?/g, "\n").replace(/\t/g, "    "))
    .split("\n")
    .map((line) => replaceControlCharacters(line))
    .join("\n");
}

/** A component computed from a function on every frame. Header, footer, and small status pieces. */
export class Dynamic implements Component {
  #render: (width: number) => string[];
  constructor(render: (width: number) => string[]) {
    this.#render = render;
  }
  render(width: number): string[] {
    return fitAll(this.#render(width), width);
  }
  invalidate(): void {}
}

/** Indent a child component by a fixed number of columns. */
export class Indent implements Component {
  readonly child: Component;
  readonly cols: number;
  readonly prefix: string | undefined;
  constructor(child: Component, cols: number, prefix?: string) {
    this.child = child;
    this.cols = cols;
    this.prefix = prefix;
  }
  render(width: number): string[] {
    const pad = this.prefix ?? " ".repeat(this.cols);
    return this.child.render(Math.max(1, width - this.cols)).map((line) => pad + line);
  }
  invalidate(): void {
    this.child.invalidate();
  }
}
