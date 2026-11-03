import { type Component, ScrollView, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { oneLine, relTime, sourceIcon } from "../format.ts";
import type { ViewModel } from "../model.ts";
import { agentColor, bold, c, spinnerFrame } from "../theme.ts";
import { fit, padRight, spread } from "./util.ts";

export const SIDEBAR_WIDTH = 30;
export const SIDEBAR_MIN_TERMINAL = 90;

/** Recent threads: source icon, title, agent, age, busy spinner and unread dot. */
export class Sidebar implements Component {
  readonly vm: ViewModel;
  /** Row → thread id, from the last render, for clicks. */
  #rows: (string | null)[] = [];
  /** Row of the current thread, so the scroll view can keep it visible. */
  currentRow = 0;

  constructor(vm: ViewModel) {
    this.vm = vm;
  }

  render(width: number): string[] {
    const vm = this.vm;
    const inner = Math.max(4, width - 1);
    const lines: string[] = [];
    this.#rows = [];
    const push = (line: string, id: string | null = null) => {
      lines.push(fit(padRight(line, inner), width));
      this.#rows.push(id);
    };
    push(spread(` ${c.dim("THREADS")}`, c.faint(`${vm.threads.length} `), inner));
    push("");

    const current = vm.current.threadId;
    if (current === null) {
      const agent = vm.agentById(vm.current.agentId);
      this.currentRow = lines.length;
      push(`${c.accent("▌")}${c.accent("✦")} ${bold(c.accentBright("New conversation"))}`, null);
      push(`${c.accent("▌")}  ${c.dim(agent ? `@${agent.handle} · draft` : "draft")}`, null);
      push("");
    }

    for (const thread of vm.threads) {
      const selected = thread.id === current;
      const agent = vm.agentById(thread.agentId);
      const bar = selected ? c.accent("▌") : " ";
      const icon = selected ? c.accent(sourceIcon(thread.source)) : c.dim(sourceIcon(thread.source));
      const marker = thread.waitingApproval ? c.yellow("⏸") : thread.busy ? c.accent(spinnerFrame()) : vm.unread.has(thread.id) ? c.accentBright("●") : "";
      const titleRoom = inner - 4 - (marker ? 2 : 0);
      const raw = oneLine(thread.title) || "Untitled";
      const title = selected ? bold(fit(raw, titleRoom)) : vm.unread.has(thread.id) ? fit(raw, titleRoom) : c.muted(fit(raw, titleRoom));
      if (selected) this.currentRow = lines.length;
      push(spread(`${bar}${icon} ${title}`, marker ? `${marker} ` : "", inner), thread.id);
      const who = agent ? agentColor(agent.color)(`@${agent.handle}`) : c.dim("?");
      const where = thread.location ? ` ${oneLine(thread.location)}` : "";
      push(`${bar}  ${who}${c.dim(`${where} · ${relTime(thread.updatedAt)}`)}`, thread.id);
      push("");
    }
    if (vm.threads.length === 0) push(c.dim("  No threads yet"));
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const id = this.#rows[event.y];
    if (!id) return { handled: true, render: false };
    this.vm.openThread(id);
    return { handled: true };
  }

  invalidate(): void {}
}

/** Keeps the current thread in view as the selection moves. */
export class SidebarScroll extends ScrollView {
  readonly sidebar: Sidebar;
  #lastRow = -1;
  constructor(sidebar: Sidebar) {
    super(sidebar, { follow: "none", scrollbar: "auto", scrollbarThumbStyle: c.accent, scrollbarTrackStyle: c.faint });
    this.sidebar = sidebar;
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    const row = this.sidebar.currentRow;
    if (row === this.#lastRow || viewportHeight <= 0) return;
    this.#lastRow = row;
    if (row < this.scrollTop + 2) this.scrollTo(Math.max(0, row - 2));
    else if (row + 3 > this.scrollTop + viewportHeight) this.scrollTo(row + 3 - viewportHeight);
  }
}

/** The thin divider between sidebar and transcript. Taller than any viewport; the layout clips it. */
export class VerticalRule implements Component {
  readonly tui: { terminal: { rows: number } };
  constructor(tui: { terminal: { rows: number } }) {
    this.tui = tui;
  }
  render(): string[] {
    return Array.from({ length: Math.max(1, this.tui.terminal.rows) }, () => c.faint("│"));
  }
  invalidate(): void {}
}
