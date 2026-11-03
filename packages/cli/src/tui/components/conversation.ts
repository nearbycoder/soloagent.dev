import {
  type Component,
  Container,
  Loader,
  Markdown,
  ScrollView,
  type ScrollViewOptions,
  Spacer,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Agent, LiveState, Message, ToolCallInfo } from "@soloagent/client";
import { bytes, clock, oneLine, SOURCE_LABEL, sourceIcon, summarizeArgs, words } from "../format.ts";
import type { AssistantMessage, EventMessage, Notice, Pending, ToolMessage, UserMessage, ViewModel } from "../model.ts";
import { agentColor, bold, c, italic, markdownTheme, spinnerFrame, thinkingMarkdownTheme } from "../theme.ts";
import { center, Dynamic, fit, fitAll, sanitize, spread, wrapWith } from "./util.ts";
import { Welcome } from "./welcome.ts";

const INDENT = "   ";
/** OSC 133 prompt-start marker: lets Ctrl+↑/↓ jump between user messages. */
const PROMPT_MARK = "\x1b]133;A\x07";

function agentName(agent: Agent | undefined) {
  return agent?.name ?? "Agent";
}

function header(left: string, at: number | undefined, width: number): string {
  return spread(left, at ? c.dim(clock(at)) : "", width);
}

/** Markdown kept across frames so its parse and layout caches survive. */
class MarkdownCache {
  #md: Markdown | undefined;
  #text = "";
  readonly thinking: boolean;
  constructor(thinking = false) {
    this.thinking = thinking;
  }
  render(text: string, width: number): string[] {
    if (!this.#md) {
      this.#md = this.thinking
        ? new Markdown(text, 0, 0, thinkingMarkdownTheme, { color: c.dim, italic: true })
        : new Markdown(text, 0, 0, markdownTheme);
      this.#text = text;
    } else if (text !== this.#text) {
      this.#md.setText(text);
      this.#text = text;
    }
    return this.#md.render(Math.max(1, width));
  }
  invalidate() {
    this.#md?.invalidate();
  }
}

// ── user ────────────────────────────────────────────────────────────────────

class UserBlock implements Component {
  message: UserMessage | Pending;
  constructor(message: UserMessage | Pending) {
    this.message = message;
  }
  render(width: number): string[] {
    const m = this.message;
    const pending = !("kind" in m);
    const name = pending ? "You" : m.author.name;
    const source = pending ? "tui" : m.author.source;
    const meta = pending
      ? m.failed
        ? c.red("not sent")
        : c.dim("sending…")
      : c.dim(source === "tui" ? SOURCE_LABEL[source] : `${sourceIcon(source)} ${SOURCE_LABEL[source]}`);
    const lines = [PROMPT_MARK + header(` ${c.accent("❯")} ${bold(name)}  ${meta}`, pending ? undefined : m.at, width)];
    // Files & images: one chip per file, e.g. [image: screenshot.png]
    const chips = pending
      ? (m.files ?? []).map((f) => `[file: ${f}]`)
      : (m.attachments ?? []).map((a) => `[${a.mimeType.startsWith("image/") ? "image" : "file"}: ${a.name}]`);
    if (chips.length) lines.push(...wrapWith(sanitize(chips.join(" ")), width, INDENT, c.cyan));
    if (m.text) lines.push(...wrapWith(sanitize(m.text), width, INDENT, pending ? c.muted : (s) => s));
    return fitAll(lines, width);
  }
  invalidate(): void {}
}

// ── tools ───────────────────────────────────────────────────────────────────

function toolStatus(vm: ViewModel, callId: string): LiveState["tools"][number] | undefined {
  return vm.state.live.tools.find((t) => t.callId === callId);
}

/** `🔧 web_fetch("https://…") ✓ 3 lines`, plus the result when expanded. */
function renderToolCall(vm: ViewModel, call: ToolCallInfo, result: ToolMessage | undefined, width: number, indent = INDENT): string[] {
  const live = toolStatus(vm, call.id);
  let status: string;
  if (result) {
    const n = result.text ? result.text.split("\n").length : 0;
    status = result.isError ? c.red(" ✗") : `${c.green(" ✓")}${result.text ? c.dim(` ${n > 1 ? `${n} lines` : bytes(result.text.length)}`) : ""}`;
  } else if (live?.status === "running") status = ` ${c.accent(spinnerFrame())}`;
  else if (live?.status === "done") status = c.green(" ✓");
  else if (vm.isBusy()) status = c.dim(" …");
  else status = c.dim(" ·");
  const nameWidth = visibleWidth(call.name);
  const args = summarizeArgs(call.args, Math.max(8, width - visibleWidth(indent) - nameWidth - 16));
  const line = `${indent}🔧 ${bold(call.name)}${c.dim(`(${args})`)}${status}`;
  const lines = [fit(line, width)];
  const expanded = vm.expandTools || vm.expandedCalls.has(call.id);
  const body = result?.text ?? (live?.status === "running" ? live.output : undefined);
  const gutter = `${indent}   ${c.faint("│")} `;
  if (expanded && body) {
    const max = vm.expandedCalls.has(call.id) ? 400 : 24;
    const all = wrapWith(sanitize(body.trimEnd()), width, gutter, result?.isError ? c.red : c.muted);
    lines.push(...all.slice(0, max));
    if (all.length > max) lines.push(`${gutter}${c.dim(`… ${all.length - max} more lines · click to expand`)}`);
  } else if (result?.isError && result.text) {
    lines.push(fit(`${indent}   ${c.faint("⎿")} ${c.red(oneLine(sanitize(result.text)))}`, width));
  }
  return lines;
}

// ── assistant ───────────────────────────────────────────────────────────────

class AssistantBlock implements Component {
  readonly vm: ViewModel;
  message: AssistantMessage;
  results: Map<string, ToolMessage>;
  showHeader = true;
  #md = new MarkdownCache();
  #thinking = new MarkdownCache(true);
  #rows = new Map<number, string>();

  constructor(vm: ViewModel, message: AssistantMessage, results: Map<string, ToolMessage>) {
    this.vm = vm;
    this.message = message;
    this.results = results;
  }

  render(width: number): string[] {
    const { vm, message: m } = this;
    const agent = vm.agentById(m.agentId);
    const color = agentColor(agent?.color);
    const lines: string[] = [];
    this.#rows.clear();
    if (this.showHeader) {
      const model = m.model ? c.dim(m.model) : "";
      lines.push(header(` ${color(agent?.avatar ?? "✦")} ${bold(color(agentName(agent)))}  ${model}`, m.at, width));
    }
    const inner = Math.max(1, width - INDENT.length);
    if (m.thinking) {
      this.#rows.set(lines.length, "thinking");
      lines.push(...renderThinking(vm, m.thinking, inner, this.#thinking, false).map((l) => INDENT + l));
    }
    if (m.text.trim()) lines.push(...this.#md.render(m.text, inner).map((l) => INDENT + l));
    if (m.error) {
      const stopped = m.stopReason === "aborted";
      lines.push(...wrapWith(stopped ? "◼ Stopped" : `✗ ${sanitize(m.error)}`, width, INDENT, stopped ? c.dim : c.red));
    }
    for (const call of m.toolCalls) {
      this.#rows.set(lines.length, call.id);
      lines.push(...renderToolCall(vm, call, this.results.get(call.id), width));
    }
    return fitAll(lines, width);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const target = this.#rows.get(event.y);
    if (!target) return undefined;
    if (target === "thinking") this.vm.toggleThinking();
    else this.vm.toggleCall(target);
    return { handled: true };
  }

  invalidate(): void {
    this.#md.invalidate();
    this.#thinking.invalidate();
  }
}

function renderThinking(vm: ViewModel, thinking: string, width: number, cache: MarkdownCache, streaming: boolean): string[] {
  if (!vm.showThinking) {
    const label = streaming ? `${c.accent(spinnerFrame())} ${italic(c.dim("Thinking…"))}` : c.dim(italic(`▸ Thought for ${words(thinking)} words`));
    const tail = streaming ? `  ${c.faint(tailWords(oneLine(thinking), Math.max(0, width - 16)))}` : c.faint("  ctrl+t");
    return [fit(label + tail, width)];
  }
  const gutter = c.faint("┊ ");
  return [c.dim(italic(streaming ? "▾ Thinking…" : "▾ Thinking")), ...cache.render(thinking, width - 2).map((l) => gutter + l)];
}

/** The end of a long string, starting on a word boundary. */
function tailWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(-(max - 1));
  const space = cut.indexOf(" ");
  return `…${space >= 0 && space < 20 ? cut.slice(space + 1) : cut}`;
}

// ── standalone pieces ───────────────────────────────────────────────────────

class ToolBlock implements Component {
  readonly vm: ViewModel;
  message: ToolMessage;
  constructor(vm: ViewModel, message: ToolMessage) {
    this.vm = vm;
    this.message = message;
  }
  render(width: number): string[] {
    const m = this.message;
    return renderToolCall(this.vm, { id: m.callId, name: m.name, args: {} }, m, width);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.y !== 0) return undefined;
    this.vm.toggleCall(this.message.callId);
    return { handled: true };
  }
  invalidate(): void {}
}

class EventBlock implements Component {
  message: EventMessage;
  constructor(message: EventMessage) {
    this.message = message;
  }
  render(width: number): string[] {
    const tone = this.message.tone === "error" ? c.red : this.message.tone === "warn" ? c.yellow : c.dim;
    const text = oneLine(sanitize(this.message.text));
    const room = Math.max(0, width - visibleWidth(text) - 4);
    const dash = Math.min(6, Math.floor(room / 2));
    return [center(`${c.faint("─".repeat(dash))} ${tone(text)} ${c.faint("─".repeat(dash))}`, width)];
  }
  invalidate(): void {}
}

class NoticeBlock implements Component {
  notice: Notice;
  constructor(notice: Notice) {
    this.notice = notice;
  }
  render(width: number): string[] {
    const { tone, text } = this.notice;
    const icon = tone === "error" ? c.red("✗") : tone === "success" ? c.green("✓") : tone === "warn" ? c.yellow("!") : c.accent("·");
    const style = tone === "error" ? c.red : tone === "warn" ? c.yellow : c.muted;
    const lines = wrapWith(text, width - 3, "", style);
    return fitAll(
      lines.map((l, i) => (i === 0 ? ` ${icon} ${l}` : `   ${l}`)),
      width,
    );
  }
  invalidate(): void {}
}

class TopIndicator implements Component {
  readonly vm: ViewModel;
  constructor(vm: ViewModel) {
    this.vm = vm;
  }
  render(width: number): string[] {
    const { state, loadingEarlier } = this.vm;
    if (state.messages.length === 0) return [];
    if (state.hasMore) {
      return [center(loadingEarlier ? `${c.accent(spinnerFrame())} ${c.dim("loading earlier messages…")}` : c.dim("↑ scroll up for earlier messages"), width)];
    }
    const created = state.thread?.createdAt;
    return [center(c.faint(`· start of conversation${created ? ` · ${clock(created)}` : ""} ·`), width)];
  }
  invalidate(): void {}
}

/** One-line spinner without the Loader's leading blank line. */
class InlineLoader extends Loader {
  override render(width: number): string[] {
    return super.render(width).slice(1);
  }
}

// ── live run ────────────────────────────────────────────────────────────────

class LiveBlock implements Component {
  readonly vm: ViewModel;
  showHeader = true;
  #md = new MarkdownCache();
  #thinking = new MarkdownCache(true);
  readonly loader: InlineLoader;
  #loaderRunning = false;
  #loaderMessage = "";
  #rows = new Map<number, string>();

  constructor(vm: ViewModel, tui: TUI) {
    this.vm = vm;
    this.loader = new InlineLoader(tui, c.accent, c.dim, "Thinking…");
    this.loader.stop();
  }

  /** Whether anything should be drawn. Also starts or stops the spinner. */
  active(): boolean {
    const live = this.vm.state.live;
    const showLoader = live.busy && !live.partial?.text.trim() && !live.partial?.thinking && !live.tools.some((t) => t.status === "running");
    if (showLoader && !this.#loaderRunning) {
      this.loader.start();
      this.#loaderRunning = true;
    } else if (!showLoader && this.#loaderRunning) {
      this.loader.stop();
      this.#loaderRunning = false;
    }
    return live.busy || Boolean(live.failure) || Boolean(live.retry);
  }

  dispose() {
    this.loader.stop();
    this.#loaderRunning = false;
  }

  render(width: number): string[] {
    const { vm } = this;
    const live = vm.state.live;
    const lines: string[] = [];
    this.#rows.clear();
    const agent = vm.agentById(vm.state.thread?.agentId ?? vm.current.agentId);
    const color = agentColor(agent?.color);
    const inner = Math.max(1, width - INDENT.length);
    if (live.busy) {
      if (this.showHeader) lines.push(` ${color(agent?.avatar ?? "✦")} ${bold(color(agentName(agent)))}  ${c.dim(agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : "")}`);
      const partial = live.partial;
      const committed = lastAssistant(vm.state.messages);
      const duplicate = partial && committed && committed.text === partial.text && committed.text !== "";
      if (partial?.thinking && !duplicate) {
        this.#rows.set(lines.length, "thinking");
        lines.push(...renderThinking(vm, partial.thinking, inner, this.#thinking, !partial.text).map((l) => INDENT + l));
      }
      if (partial?.text.trim() && !duplicate) {
        // Copy: the Markdown component caches and returns the same array every frame.
        const md = [...this.#md.render(partial.text, inner)];
        // Caret after the last non-empty line of the stream.
        let last = md.length - 1;
        while (last > 0 && !md[last]!.trim()) last--;
        md[last] = `${md[last]!.trimEnd()}${c.accent("▍")}`;
        lines.push(...md.slice(0, last + 1).map((l) => INDENT + l));
      }
      for (const call of partial?.toolCalls ?? []) {
        this.#rows.set(lines.length, call.id);
        lines.push(...renderToolCall(vm, call, undefined, width));
      }
      if (this.#loaderRunning) {
        const elapsed = vm.busySince ? Math.floor((Date.now() - vm.busySince) / 1000) : 0;
        const message = `${agentName(agent)} is thinking…${elapsed >= 2 ? ` ${elapsed}s` : ""}  ${c.faint("esc to stop")}`;
        // setMessage requests a render; only call it on change or every frame would schedule another.
        if (message !== this.#loaderMessage) {
          this.#loaderMessage = message;
          this.loader.setMessage(message);
        }
        lines.push(...this.loader.render(width - 2).map((l) => `  ${l}`));
      }
      if (live.queued > 0) lines.push(`${INDENT}${c.dim(`+${live.queued} queued`)}`);
    }
    if (live.retry) lines.push(...wrapWith(`↻ Retrying: ${oneLine(live.retry.error)}`, width, INDENT, c.yellow));
    // A run the user stopped already shows "◼ Stopped" on its message.
    if (!live.busy && live.failure && !/abort|stop|cancel/i.test(live.failure.reason)) {
      lines.push(...wrapWith(`✗ Run failed: ${live.failure.reason}${live.failure.detail ? ` — ${oneLine(live.failure.detail)}` : ""}`, width, INDENT, c.red));
    }
    return fitAll(lines, width);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const target = this.#rows.get(event.y);
    if (!target) return undefined;
    if (target === "thinking") this.vm.toggleThinking();
    else this.vm.toggleCall(target);
    return { handled: true };
  }

  invalidate(): void {
    this.#md.invalidate();
    this.#thinking.invalidate();
  }
}

function lastAssistant(messages: Message[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "assistant") return m;
    if (m.kind === "user") return undefined;
  }
  return undefined;
}

// ── the transcript ──────────────────────────────────────────────────────────

/** The scrollable transcript: rebuilt from the view model with per-message blocks reused across syncs. */
export class Conversation extends Container {
  readonly vm: ViewModel;
  readonly live: LiveBlock;
  readonly top: TopIndicator;
  readonly welcome: Welcome;
  #blocks = new Map<string, Component>();
  #threadId: string | null | undefined;

  constructor(vm: ViewModel, tui: TUI) {
    super();
    this.vm = vm;
    this.live = new LiveBlock(vm, tui);
    this.top = new TopIndicator(vm);
    this.welcome = new Welcome(vm);
  }

  /** Rebuild the child list from the current state. Cheap: blocks are cached by message id. */
  sync() {
    const vm = this.vm;
    if (vm.current.threadId !== this.#threadId) {
      this.#blocks.clear();
      this.#threadId = vm.current.threadId;
    }
    const children: Component[] = [];
    const add = (component: Component) => {
      if (children.length > 0) children.push(new Spacer(1));
      children.push(component);
    };

    let messages = vm.state.messages;
    if (vm.clearedAfter) {
      const index = messages.findIndex((m) => m.id === vm.clearedAfter);
      if (index >= 0) messages = messages.slice(index + 1);
    }
    const results = new Map<string, ToolMessage>();
    const calls = new Set<string>();
    for (const m of vm.state.messages) {
      if (m.kind === "tool") results.set(m.callId, m);
      if (m.kind === "assistant") for (const call of m.toolCalls) calls.add(call.id);
    }

    const liveActive = this.live.active();
    const empty = messages.length === 0 && vm.pending.length === 0 && !liveActive;
    if (empty && !vm.clearedAfter) {
      children.push(this.welcome);
      for (const n of vm.notices) add(new NoticeBlock(n));
    } else {
      if (!vm.clearedAfter) children.push(this.top);
      else children.push(new Dynamic((w) => [center(c.faint("· cleared · ctrl+p and reopen this thread to see all of it ·"), w)]));
      const notices = new Map<string | null, Notice[]>();
      for (const n of vm.notices) notices.set(n.afterId, [...(notices.get(n.afterId) ?? []), n]);
      if (messages.length > 0 || !vm.pending.length) for (const n of notices.get(null) ?? []) add(new NoticeBlock(n));
      // Notices after the newest message go below pending sends, where the user is looking.
      const lastId = messages[messages.length - 1]?.id ?? null;
      const trailing = vm.pending.length ? (notices.get(lastId) ?? []) : [];
      if (vm.pending.length) notices.delete(lastId);
      let previous: Message | undefined;
      for (const m of messages) {
        if (m.kind === "tool" && calls.has(m.callId)) continue;
        const block = this.#block(m, results);
        if (block instanceof AssistantBlock) block.showHeader = previous?.kind !== "assistant" || previous.agentId !== block.message.agentId;
        add(block);
        previous = m;
        for (const n of notices.get(m.id) ?? []) add(new NoticeBlock(n));
      }
      for (const p of vm.pending) add(new UserBlock(p));
      for (const n of trailing) add(new NoticeBlock(n));
      if (liveActive) {
        const agentId = vm.state.thread?.agentId;
        this.live.showHeader = vm.pending.length > 0 || previous?.kind !== "assistant" || previous.agentId !== agentId;
        add(this.live);
      }
    }
    this.children = children;
  }

  #block(m: Message, results: Map<string, ToolMessage>): Component {
    let block = this.#blocks.get(m.id);
    if (block) {
      if (block instanceof AssistantBlock && m.kind === "assistant") {
        block.message = m;
        block.results = results;
      }
      return block;
    }
    switch (m.kind) {
      case "user":
        block = new UserBlock(m);
        break;
      case "assistant":
        block = new AssistantBlock(this.vm, m, results);
        break;
      case "tool":
        block = new ToolBlock(this.vm, m);
        break;
      case "event":
        block = new EventBlock(m);
        break;
    }
    this.#blocks.set(m.id, block);
    return block;
  }

  override render(width: number): string[] {
    // One column of breathing room on the right.
    const lines = super.render(Math.max(1, width - 1));
    return lines.length ? lines : [""];
  }

  override invalidate(): void {
    for (const block of this.#blocks.values()) block.invalidate();
    this.live.invalidate();
  }
}

/**
 * The transcript's scroll view. Asks for earlier messages when scrolled to the top and keeps the
 * reading position steady when they are prepended.
 */
export class ConversationScroll extends ScrollView {
  onReachTop?: () => void;
  #lastContentHeight = 0;
  #anchor: number | undefined;

  constructor(component: Component, options: ScrollViewOptions) {
    super(component, options);
  }

  /** Call right before prepending older messages. */
  anchorForPrepend() {
    this.#anchor = this.#lastContentHeight;
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (this.#anchor !== undefined && contentHeight !== this.#anchor) {
      const delta = contentHeight - this.#anchor;
      this.#anchor = undefined;
      if (!this.isFollowingEnd && delta > 0) this.scrollTo(this.scrollTop + delta, { disableFollow: true });
    }
    this.#lastContentHeight = contentHeight;
    if (this.scrollTop === 0 && viewportHeight > 0 && this.onReachTop) {
      const reach = this.onReachTop;
      queueMicrotask(reach);
    }
  }
}
