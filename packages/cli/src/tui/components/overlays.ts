import {
  type Component,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  matchesKey,
  SelectList,
  type SelectItem,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { bold, c, selectListTheme, type Style } from "../theme.ts";
import { fit, padRight } from "./util.ts";

type Child = Component & Partial<Focusable>;

/** Rounded, titled border around an overlay's content. Forwards input, focus, and mouse. */
export class Frame implements Component, Focusable {
  readonly child: Child;
  title: string;
  hint: string | (() => string);
  color: Style;
  #focused = false;

  constructor(child: Child, options: { title: string; hint?: string | (() => string); color?: Style }) {
    this.child = child;
    this.title = options.title;
    this.hint = options.hint ?? "esc close";
    this.color = options.color ?? c.accent;
  }

  get focused() {
    return this.#focused;
  }
  set focused(value: boolean) {
    this.#focused = value;
    if ("focused" in this.child) this.child.focused = value;
  }

  get capturesViewportInput() {
    return true;
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const b = this.color;
    const title = ` ${bold(this.title)} `;
    const topFill = Math.max(0, width - 3 - visibleWidth(title));
    const top = fit(b("╭─") + title + b(`${"─".repeat(topFill)}╮`), width);
    const body = this.child.render(inner).map((line) => `${b("│")} ${padRight(line, inner)} ${b("│")}`);
    const hintText = typeof this.hint === "function" ? this.hint() : this.hint;
    const hint = hintText ? ` ${c.dim(hintText)} ` : "";
    const bottomFill = Math.max(0, width - 3 - visibleWidth(hint));
    const bottom = fit(b("╰─") + hint + b(`${"─".repeat(bottomFill)}╯`), width);
    const blank = b("│") + " ".repeat(Math.max(0, width - 2)) + b("│");
    return [top, blank, ...body, blank, bottom];
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.child.handleMouse) return event.type === "wheel" ? { handled: true } : undefined;
    const local = { ...event, x: event.x - 2, y: event.y - 2, width: Math.max(1, event.width - 4), height: Math.max(1, event.height - 4) };
    if (local.y < 0 || local.x < 0) return { handled: true, render: false };
    return this.child.handleMouse(local) ?? { handled: true, render: false };
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

export type PickerItem = SelectItem & { search?: string };

/** Type-to-filter list: an Input over a fuzzy-filtered SelectList. */
export class Picker implements Component, Focusable {
  readonly input: Input;
  #items: PickerItem[];
  #list: SelectList;
  #maxVisible: number;
  #emptyText: string;
  #focused = false;
  onSelect?: (value: string) => void;
  onCancel?: () => void;
  onHighlight?: (value: string) => void;

  constructor(items: PickerItem[], options: { placeholder?: string; maxVisible?: number; emptyText?: string; selected?: string } = {}) {
    this.#items = items;
    this.#maxVisible = options.maxVisible ?? 10;
    this.#emptyText = options.emptyText ?? "No matches";
    this.input = new Input({ prompt: c.accent("› "), placeholder: options.placeholder ?? "Type to filter…", placeholderStyle: c.dim });
    this.#list = this.#build(items);
    if (options.selected) {
      const index = items.findIndex((i) => i.value === options.selected);
      if (index >= 0) this.#list.setSelectedIndex(index);
    }
  }

  get focused() {
    return this.#focused;
  }
  set focused(value: boolean) {
    this.#focused = value;
    this.input.focused = value;
  }

  get capturesViewportInput() {
    return true;
  }

  setItems(items: PickerItem[]) {
    const selected = this.#list.getSelectedItem()?.value;
    this.#items = items;
    this.#refilter();
    if (selected) {
      const index = this.#filtered().findIndex((i) => i.value === selected);
      if (index >= 0) this.#list.setSelectedIndex(index);
    }
  }

  #filtered(): PickerItem[] {
    const query = this.input.getValue().trim();
    return query ? fuzzyFilter(this.#items, query, (i) => i.search ?? `${i.label} ${i.description ?? ""}`) : this.#items;
  }

  #build(items: PickerItem[]): SelectList {
    const list = new SelectList(items, this.#maxVisible, selectListTheme, { minPrimaryColumnWidth: 14, maxPrimaryColumnWidth: 36 });
    list.onSelect = (item) => this.onSelect?.(item.value);
    list.onCancel = () => this.onCancel?.();
    list.onSelectionChange = (item) => this.onHighlight?.(item.value);
    return list;
  }

  #refilter() {
    this.#list = this.#build(this.#filtered());
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) return this.onCancel?.();
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.pageUp") ||
      kb.matches(data, "tui.select.pageDown") ||
      kb.matches(data, "tui.select.confirm") ||
      matchesKey(data, "tab")
    ) {
      this.#list.handleInput(matchesKey(data, "tab") ? "\x1b[B" : data);
      return;
    }
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.#refilter();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y < 2) return this.input.handleMouse(event);
    return this.#list.handleMouse({ ...event, y: event.y - 2 });
  }

  render(width: number): string[] {
    const lines = [...this.input.render(width), ""];
    if (this.#filtered().length === 0) lines.push(c.dim(`  ${this.#emptyText}`));
    else lines.push(...this.#list.render(width));
    return lines.map((l) => fit(l, width));
  }

  invalidate(): void {
    this.input.invalidate();
    this.#list.invalidate();
  }
}

/** Read-only scrollable panel for help, usage, and connector status. */
export class InfoPanel implements Component {
  #content: (width: number) => string[];
  #maxHeight: () => number;
  #offset = 0;
  #lastTotal = 0;
  #lastVisible = 0;
  onClose?: () => void;
  onKey?: (data: string) => boolean;

  constructor(content: (width: number) => string[], maxHeight: () => number) {
    this.#content = content;
    this.#maxHeight = maxHeight;
  }

  get capturesViewportInput() {
    return true;
  }

  /** "↓ 12 more" style hint for the frame, or "" when everything fits. */
  scrollHint(): string {
    const below = this.#lastTotal - this.#offset - this.#lastVisible;
    if (this.#lastTotal <= this.#lastVisible) return "";
    return `${this.#offset > 0 ? "↑" : " "}${below > 0 ? "↓" : " "} ${this.#offset + 1}-${this.#offset + this.#lastVisible}/${this.#lastTotal}`;
  }

  #scroll(delta: number) {
    const max = Math.max(0, this.#lastTotal - this.#lastVisible);
    this.#offset = Math.max(0, Math.min(max, this.#offset + delta));
  }

  handleInput(data: string): void {
    if (this.onKey?.(data)) return;
    const page = Math.max(1, this.#lastVisible - 1);
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c") || data === "q") return this.onClose?.();
    if (matchesKey(data, "up") || data === "k") this.#scroll(-1);
    else if (matchesKey(data, "down") || data === "j") this.#scroll(1);
    else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+space")) this.#scroll(-page);
    else if (matchesKey(data, "pageDown") || data === " ") this.#scroll(page);
    else if (matchesKey(data, "home") || data === "g") this.#offset = 0;
    else if (matchesKey(data, "end") || data === "G") this.#scroll(this.#lastTotal);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      this.#scroll(event.wheelDelta);
      return { handled: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    const all = this.#content(width);
    const visible = Math.max(3, this.#maxHeight());
    this.#lastTotal = all.length;
    this.#lastVisible = Math.min(visible, all.length);
    this.#offset = Math.max(0, Math.min(this.#offset, all.length - this.#lastVisible));
    return all.slice(this.#offset, this.#offset + this.#lastVisible).map((l) => fit(l, width));
  }

  invalidate(): void {}
}
