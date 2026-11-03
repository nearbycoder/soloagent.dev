import {
  type AutocompleteItem,
  type Component,
  HStack,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  TuiAltScreen,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  type Agent,
  applyThreadEvent,
  compareSemver,
  emptyLive,
  type ProviderInfo,
  type ServerEvent,
  SoloApiError,
  type SoloClient,
  type SoloStream,
  type Thread,
  type ThreadSnapshot,
  type ThreadState,
} from "@soloagent/client";
import { authorName, findAgent } from "../commands/ask.ts";
import { findProvider, sortProviders } from "../commands/login.ts";
import { openBrowser } from "../commands/prompt.ts";
import { loadHistory, saveHistory } from "../config.ts";
import { knownUpdate, refreshUpdateCache, updateChecksEnabled } from "../updates.ts";
import { type Connection, logToFile, silenceConsole } from "../connect.ts";
import { COMMANDS, type CommandSpec, findCommand, parseCommand, SlashAutocomplete } from "./commands.ts";
import { ChatEditor, renderFooter, renderHeader } from "./components/chrome.ts";
import { Conversation, ConversationScroll } from "./components/conversation.ts";
import { LoginPanel } from "./components/login.ts";
import { Frame, InfoPanel, Picker, type PickerItem } from "./components/overlays.ts";
import { Sidebar, SIDEBAR_MIN_TERMINAL, SIDEBAR_WIDTH, SidebarScroll, VerticalRule } from "./components/sidebar.ts";
import { Dynamic } from "./components/util.ts";
import { compact, money, oneLine, relTime, SOURCE_LABEL, sourceIcon } from "./format.ts";
import type { Notice, Pending, Tone, ViewModel } from "./model.ts";
import { agentColor, bold, BRAND, c } from "./theme.ts";

export type TuiOptions = { agent?: string; thread?: string; fresh?: boolean; version: string };

type OverlayKind = "picker" | "info" | "login" | "connectors";

export class App implements ViewModel {
  readonly tui: TuiAltScreen;
  readonly version: string;
  readonly conn: Connection;
  readonly client: SoloClient;
  readonly author = authorName();
  stream!: SoloStream;

  agents: Agent[] = [];
  threads: Thread[] = [];
  providers: ProviderInfo[] | null = null;
  state: ThreadState = { messages: [], hasMore: false, live: emptyLive() };
  current: { threadId: string | null; agentId: string | null } = { threadId: null, agentId: null };
  connected = false;
  everConnected = false;
  showThinking = false;
  expandTools = false;
  expandedCalls = new Set<string>();
  sidebarOpen = true;
  unread = new Set<string>();
  busySince: number | undefined;
  loadingEarlier = false;
  notices: Notice[] = [];
  pending: Pending[] = [];
  clearedAfter: string | null = null;
  update: { latest: string; url: string } | undefined;

  readonly editor: ChatEditor;
  readonly conversation: Conversation;
  readonly scroll: ConversationScroll;
  readonly sidebar: Sidebar;
  overlay: { handle: OverlayHandle; kind: OverlayKind; panel?: Component } | undefined;

  #history: string[] = [];
  #seq = 0;
  #flash: { text: string; tone: Tone; until: number } | undefined;
  #quitArmedUntil = 0;
  #unsubscribe: (() => void) | undefined;
  #snapshotFor: string | undefined;
  #earlierFailedAt = 0;
  #ticker: ReturnType<typeof setInterval> | undefined;
  #tick = 0;
  #quitting = false;
  #exit: ((code: number) => void) | undefined;
  #restoreConsole: (() => void) | undefined;

  constructor(conn: Connection, version: string) {
    this.conn = conn;
    this.client = conn.client;
    this.version = version;
    this.tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, {
      wheelScrollLines: "auto",
      openUrl: (url) => void openBrowser(url),
      scrollToEndIndicator: () => ` ${c.accent("↓")} ${c.muted("jump to latest")} `,
      searchCurrentMatchStyle: (t) => `\x1b[7m${c.accentBright(t)}\x1b[27m`,
    });

    this.editor = new ChatEditor(this.tui, this, { paddingX: 1, autocompleteMaxVisible: 8 });
    const autocomplete = new SlashAutocomplete(this.#commandsWithCompletions());
    this.editor.setAutocompleteProvider(autocomplete);
    this.editor.onSubmit = (text) => this.#submit(text);
    // Open argument suggestions as soon as "/agent " is typed, not only on the next letter.
    this.editor.onChange = (text) => {
      if (!/^\/\S+ $/.test(text) || !autocomplete.argumentCommand(text, text.length)) return;
      queueMicrotask(() => {
        const editor = this.editor as unknown as { tryTriggerAutocomplete?: () => void };
        if (this.editor.getText() === text && !this.editor.isShowingAutocomplete()) editor.tryTriggerAutocomplete?.();
      });
    };
    this.#history = loadHistory();
    for (const entry of this.#history) this.editor.addToHistory(entry);

    this.conversation = new Conversation(this, this.tui);
    this.scroll = new ConversationScroll(this.conversation, {
      follow: "end",
      primary: true,
      scrollbar: "auto",
      scrollbarThumbStyle: c.accent,
      scrollbarTrackStyle: c.faint,
    });
    this.scroll.onReachTop = () => void this.#loadEarlier();
    this.sidebar = new Sidebar(this);

    const showSidebar = (viewport: { width: number }) => this.sidebarOpen && viewport.width >= SIDEBAR_MIN_TERMINAL;
    const body = new HStack([
      { component: new SidebarScroll(this.sidebar), basis: SIDEBAR_WIDTH, visible: showSidebar },
      { component: new VerticalRule(this.tui), basis: 1, visible: showSidebar },
      { component: this.scroll, basis: 0, grow: 1, minSize: 10 },
    ]);
    this.tui.setLayoutRoot(
      new VStack([
        { component: new Dynamic((w) => renderHeader(this, w, this.tui.terminal.rows >= 22)), basis: "auto" },
        { component: body, basis: 0, grow: 1, minSize: 3 },
        { component: this.editor, basis: "auto", shrink: 1, minSize: 3 },
        { component: new Dynamic((w) => renderFooter(this, w, this.overlay?.kind)), basis: "auto" },
      ]),
    );
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.#onKey(data));
  }

  // ── view model ──────────────────────────────────────────────────────────

  agentById(id: string | null | undefined): Agent | undefined {
    return id ? this.agents.find((a) => a.id === id) : undefined;
  }
  currentAgent(): Agent | undefined {
    return this.agentById(this.state.thread?.agentId ?? this.current.agentId);
  }
  currentThread(): Thread | undefined {
    return this.current.threadId ? (this.state.thread ?? this.threads.find((t) => t.id === this.current.threadId)) : undefined;
  }
  defaultAgent(): Agent | undefined {
    return this.agents.find((a) => a.isDefault) ?? this.agents[0];
  }
  hasRealProvider(): boolean {
    return Boolean(this.providers?.some((p) => p.configured && p.id !== "demo"));
  }
  isBusy(): boolean {
    return this.state.live.busy;
  }
  footerMessage() {
    const now = Date.now();
    if (this.#quitArmedUntil > now) return { text: "press ctrl+c again to quit", tone: "warn" as Tone };
    if (this.#flash && this.#flash.until > now) return { text: this.#flash.text, tone: this.#flash.tone };
    return undefined;
  }
  toggleThinking() {
    this.showThinking = !this.showThinking;
    this.flash(this.showThinking ? "Showing thinking" : "Hiding thinking");
    this.sync();
  }
  toggleCall(callId: string) {
    if (this.expandedCalls.has(callId)) this.expandedCalls.delete(callId);
    else this.expandedCalls.add(callId);
    this.sync();
  }
  requestRender() {
    this.tui.requestRender();
  }

  /** Rebuild the transcript and repaint. */
  sync() {
    if (this.#quitting) return;
    this.conversation.sync();
    this.tui.requestRender();
  }

  flash(text: string, tone: Tone = "info", ms = 2500) {
    this.#flash = { text, tone, until: Date.now() + ms };
    this.tui.requestRender();
  }

  notice(text: string, tone: Tone = "info") {
    const last = this.state.messages[this.state.messages.length - 1];
    this.notices.push({ id: ++this.#seq, afterId: last?.id ?? null, text, tone });
    this.scroll.scrollToEnd();
    this.sync();
  }

  /** Run an action; failures become red inline notices instead of crashes. */
  guard(action: Promise<unknown>) {
    action.catch((error: unknown) => {
      const message = error instanceof SoloApiError ? error.message : error instanceof Error ? error.message : String(error);
      logToFile(`[tui] ${error instanceof Error ? (error.stack ?? message) : message}`);
      this.notice(/fetch failed|ECONNREFUSED/.test(message) ? `Could not reach the server (${message})` : message, "error");
    });
  }

  /** Upgrade notice: the server's cached release check, else this CLI's daily cache. Never blocks startup. */
  async #checkForUpdate() {
    if (!updateChecksEnabled()) return;
    const server = await this.client.version().catch(() => undefined);
    await refreshUpdateCache({ timeoutMs: 3000 });
    const local = knownUpdate(this.version);
    const candidates = [local, server?.latest ? { latest: server.latest, url: server.url ?? "" } : undefined].filter((u) => !!u);
    const newest = candidates.sort((a, b) => compareSemver(b.latest, a.latest))[0];
    // Newer than this CLI, or than the server it talks to.
    if (newest && (compareSemver(newest.latest, this.version) > 0 || server?.updateAvailable)) {
      this.update = { latest: newest.latest, url: newest.url || "https://github.com/nearbycoder/soloagent.dev/releases" };
      this.tui.requestRender();
    }
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  async start(options: TuiOptions): Promise<number> {
    const [agents, threads, providers] = await Promise.all([
      this.client.agents(),
      this.client.threads({ limit: 100 }),
      this.client.providers().catch(() => null),
    ]);
    this.agents = agents;
    this.threads = sortThreads(threads);
    this.providers = providers;
    void this.#checkForUpdate();

    this.#restoreConsole = silenceConsole();
    const onCrash = (error: unknown) => {
      logToFile(`[tui] uncaught: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!this.#quitting) this.notice(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, "error");
    };
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
    process.on("SIGINT", () => void this.quit());
    process.on("SIGTERM", () => void this.quit());
    process.on("SIGHUP", () => void this.quit());

    this.stream = this.client.connect();
    this.stream.on((event) => this.#onEvent(event));
    this.stream.onStatus((connected) => this.#onStatus(connected));

    // Where to start: --thread, --agent/--new, the latest terminal thread, or a fresh draft.
    const startAgent = options.agent ? findAgent(this.agents, options.agent) : undefined;
    if (options.agent && !startAgent) this.notices.push({ id: ++this.#seq, afterId: null, text: `No agent @${options.agent.replace(/^@/, "")}`, tone: "error" });
    if (options.thread) this.openThread(options.thread);
    else if (options.fresh || startAgent) this.newDraft(startAgent?.id);
    else {
      const latest = this.threads.find((t) => t.source === "tui");
      if (latest) this.openThread(latest.id);
      else this.newDraft();
    }

    this.tui.start();
    this.#ticker = setInterval(() => this.#onTick(), 80);
    this.sync();
    return new Promise<number>((resolve) => (this.#exit = resolve));
  }

  async quit() {
    if (this.#quitting) return;
    this.#quitting = true;
    if (this.#ticker) clearInterval(this.#ticker);
    this.conversation.live.dispose();
    const threadId = this.current.threadId;
    this.tui.stop({ preserveScreen: true });
    this.#restoreConsole?.();
    this.#unsubscribe?.();
    this.stream?.close();
    saveHistory(this.#history);
    await this.conn.close();
    const p = (s: string) => `\x1b[38;2;139;92;246m${s}\x1b[39m`;
    process.stdout.write(`${p(BRAND)} See you soon.${threadId ? `\x1b[2m  Resume with: soloagent --thread ${threadId}\x1b[22m` : ""}\n`);
    this.#exit?.(0);
  }

  #onTick() {
    this.#tick++;
    const animating = this.isBusy() || this.threads.some((t) => t.busy) || this.loadingEarlier || this.overlay?.kind === "login";
    const flashEnding = (this.#flash && this.#flash.until < Date.now() + 100) || (this.#quitArmedUntil && this.#quitArmedUntil < Date.now() + 100);
    // Animate spinners at ~12fps; otherwise refresh relative times twice a minute.
    if (animating || flashEnding || this.#tick % 375 === 0) this.tui.requestRender();
    if (this.#flash && this.#flash.until < Date.now()) this.#flash = undefined;
  }

  #onStatus(connected: boolean) {
    const was = this.connected;
    this.connected = connected;
    if (connected) {
      if (this.everConnected && !was) {
        this.flash("Reconnected", "success");
        void this.#refreshLists();
      }
      this.everConnected = true;
    } else if (was) {
      this.flash("Connection lost — reconnecting…", "warn", 60_000);
    }
    this.tui.requestRender();
  }

  async #refreshLists() {
    try {
      const [agents, threads] = await Promise.all([this.client.agents(), this.client.threads({ limit: 100 })]);
      this.agents = agents;
      this.threads = sortThreads(threads);
      this.sync();
    } catch (error) {
      logToFile(`[tui] refresh: ${String(error)}`);
    }
  }

  async refreshProviders() {
    try {
      this.providers = await this.client.providers();
      this.sync();
    } catch (error) {
      logToFile(`[tui] providers: ${String(error)}`);
    }
    return this.providers ?? [];
  }

  // ── events ──────────────────────────────────────────────────────────────

  #onEvent(event: ServerEvent) {
    switch (event.type) {
      case "thread.updated": {
        const previous = this.threads.find((t) => t.id === event.thread.id);
        this.threads = sortThreads([event.thread, ...this.threads.filter((t) => t.id !== event.thread.id)]);
        if (event.thread.id !== this.current.threadId) {
          if (previous && event.thread.messageCount > previous.messageCount) this.unread.add(event.thread.id);
        } else this.#apply(event);
        break;
      }
      case "thread.deleted":
        this.threads = this.threads.filter((t) => t.id !== event.threadId);
        this.unread.delete(event.threadId);
        if (event.threadId === this.current.threadId) {
          this.newDraft(this.current.agentId ?? undefined);
          this.notice("That thread was deleted.", "warn");
        }
        break;
      case "thread.snapshot":
      case "thread.messages":
      case "thread.live":
        this.#apply(event);
        break;
      case "agent.updated":
        this.agents = [...this.agents.filter((a) => a.id !== event.agent.id), event.agent].sort((a, b) => a.createdAt - b.createdAt);
        break;
      case "agent.deleted":
        this.agents = this.agents.filter((a) => a.id !== event.agentId);
        break;
      case "providers.changed":
        void this.refreshProviders();
        break;
      case "login.updated":
        if (this.overlay?.panel instanceof LoginPanel) this.overlay.panel.update(event.flow);
        break;
      case "connector.updated":
      case "connector.deleted":
        if (this.overlay?.kind === "connectors") void this.#loadConnectors();
        break;
      default:
        break;
    }
    this.sync();
  }

  #apply(event: ServerEvent) {
    const threadId = this.current.threadId;
    if (!threadId) return;
    const before = this.state;
    const next = applyThreadEvent(before, threadId, event);
    if (next === before) return;
    if (event.type === "thread.snapshot") this.#snapshotFor = threadId;
    this.#setState(next);
  }

  #setState(next: ThreadState) {
    const wasBusy = this.state.live.busy;
    this.state = next;
    if (next.live.busy && !wasBusy) this.busySince = Date.now();
    if (!next.live.busy) this.busySince = undefined;
    if (next.thread) this.current.agentId = next.thread.agentId;
    // Drop optimistic messages the server has now echoed: same text, newer than the pending send.
    if (this.pending.length) {
      const claimed = new Set<string>();
      this.pending = this.pending.filter((p) => {
        if (p.failed) return true;
        const start = p.baseline === null ? 0 : next.messages.findIndex((m) => m.id === p.baseline) + 1;
        const echo = next.messages.slice(start).find((m) => m.kind === "user" && !claimed.has(m.id) && m.text.trim() === p.text.trim());
        if (!echo) return true;
        claimed.add(echo.id);
        return false;
      });
    }
  }

  // ── threads ─────────────────────────────────────────────────────────────

  openThread(threadId: string, options: { keepPending?: boolean } = {}) {
    if (threadId === this.current.threadId) {
      this.clearedAfter = null;
      this.scroll.scrollToEnd();
      return this.sync();
    }
    this.#unsubscribe?.();
    const thread = this.threads.find((t) => t.id === threadId);
    this.current = { threadId, agentId: thread?.agentId ?? this.current.agentId };
    this.state = { thread, messages: [], hasMore: false, live: emptyLive() };
    this.busySince = undefined;
    this.#snapshotFor = undefined;
    this.#resetView(options.keepPending);
    this.unread.delete(threadId);
    this.#unsubscribe = this.stream.subscribe(threadId);
    this.scroll.scrollToEnd();
    this.sync();
    // REST snapshot so the thread shows even before the socket delivers one.
    this.client.thread(threadId).then(
      (snapshot: ThreadSnapshot) => {
        if (this.current.threadId !== threadId || this.#snapshotFor === threadId) return;
        this.#setState({ thread: snapshot.thread, messages: snapshot.messages, hasMore: snapshot.hasMore, live: snapshot.live });
        this.sync();
      },
      (error: unknown) => {
        if (this.current.threadId !== threadId) return;
        if (error instanceof SoloApiError && error.status === 404) {
          this.newDraft(this.current.agentId ?? undefined);
          this.notice(`Thread ${threadId} was not found.`, "error");
        } else this.guard(Promise.reject(error));
      },
    );
  }

  newDraft(agentId?: string) {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const agent = this.agentById(agentId) ?? this.currentAgent() ?? this.defaultAgent();
    this.current = { threadId: null, agentId: agent?.id ?? null };
    this.state = { messages: [], hasMore: false, live: emptyLive() };
    this.busySince = undefined;
    this.#resetView(false);
    this.scroll.scrollToEnd();
    this.sync();
  }

  #resetView(keepPending: boolean | undefined) {
    this.notices = [];
    if (!keepPending) this.pending = [];
    this.clearedAfter = null;
    this.expandedCalls.clear();
    this.loadingEarlier = false;
    this.tui.resetTextSelection();
  }

  /** Threads in sidebar order, with the draft first when there is one. */
  #navigable(): (string | null)[] {
    const ids: (string | null)[] = this.threads.map((t) => t.id);
    return this.current.threadId === null ? [null, ...ids] : ids;
  }

  #step(delta: number) {
    const ids = this.#navigable();
    if (ids.length === 0) return;
    const index = ids.indexOf(this.current.threadId);
    const next = ids[Math.max(0, Math.min(ids.length - 1, index + delta))];
    if (next === undefined || next === this.current.threadId) return;
    if (next === null) this.newDraft(this.current.agentId ?? undefined);
    else this.openThread(next);
  }

  async #loadEarlier() {
    const threadId = this.current.threadId;
    const first = this.state.messages[0];
    if (!threadId || !first || !this.state.hasMore || this.loadingEarlier || this.clearedAfter) return;
    if (Date.now() - this.#earlierFailedAt < 5000) return;
    this.loadingEarlier = true;
    this.sync();
    try {
      const page = await this.client.messages(threadId, first.id, 50);
      if (this.current.threadId !== threadId) return;
      const known = new Set(this.state.messages.map((m) => m.id));
      this.scroll.anchorForPrepend();
      this.state = { ...this.state, messages: [...page.messages.filter((m) => !known.has(m.id)), ...this.state.messages], hasMore: page.hasMore };
    } catch (error) {
      this.#earlierFailedAt = Date.now();
      logToFile(`[tui] earlier: ${String(error)}`);
    } finally {
      this.loadingEarlier = false;
      this.sync();
    }
  }

  // ── input ───────────────────────────────────────────────────────────────

  #onKey(data: string): { consume?: boolean } | undefined {
    if (this.#quitting) return { consume: true };
    if (this.overlay) {
      if (!this.overlay.handle.isFocused() && !this.overlay.handle.isHidden()) this.overlay.handle.focus();
      return undefined;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.tui.hasActiveSelection()) return undefined;
      if (this.editor.getText().length > 0) {
        this.editor.setText("");
        this.tui.requestRender();
        return { consume: true };
      }
      if (this.#quitArmedUntil > Date.now()) {
        void this.quit();
        return { consume: true };
      }
      this.#quitArmedUntil = Date.now() + 1500;
      this.tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && this.editor.getText().length === 0) {
      void this.quit();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.editor.isShowingAutocomplete()) return undefined;
      if (this.isBusy()) {
        this.#stop();
        return { consume: true };
      }
      return undefined;
    }
    const keys: [string, () => void][] = [
      ["ctrl+b", () => this.#toggleSidebar()],
      ["ctrl+t", () => this.toggleThinking()],
      ["ctrl+o", () => this.#toggleTools()],
      ["ctrl+p", () => this.#threadPicker()],
      ["ctrl+n", () => this.newDraft(this.current.agentId ?? undefined)],
      ["ctrl+l", () => this.#clear()],
      ["alt+up", () => this.#step(-1)],
      ["alt+down", () => this.#step(1)],
    ];
    for (const [key, run] of keys) {
      if (matchesKey(data, key as Parameters<typeof matchesKey>[1])) {
        run();
        return { consume: true };
      }
    }
    return undefined;
  }

  #toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
    if (this.sidebarOpen && this.tui.terminal.columns < SIDEBAR_MIN_TERMINAL) this.flash(`The sidebar needs ${SIDEBAR_MIN_TERMINAL}+ columns — use ctrl+p`, "warn");
    this.tui.requestRender();
  }

  #toggleTools() {
    this.expandTools = !this.expandTools;
    if (!this.expandTools) this.expandedCalls.clear();
    this.flash(this.expandTools ? "Expanded tool output" : "Collapsed tool output");
    this.sync();
  }

  #clear() {
    const last = this.state.messages[this.state.messages.length - 1];
    if (last) this.clearedAfter = last.id;
    this.notices = [];
    this.pending = this.pending.filter((p) => !p.failed);
    this.tui.resetTextSelection();
    this.sync();
    this.tui.requestRender(true);
  }

  #stop() {
    const threadId = this.current.threadId;
    if (!threadId) return;
    this.flash("Stopping…", "warn");
    this.guard(this.client.stop(threadId));
  }

  #submit(raw: string) {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith("/") && !text.startsWith("//")) {
      const parsed = parseCommand(text);
      const spec = parsed && findCommand(parsed.name);
      if (!spec?.secret) this.#remember(text);
      if (!parsed || !spec) {
        this.notice(`Unknown command ${text.split(/\s/)[0]} — try /help. Start with // to send a message that begins with a slash.`, "error");
        return;
      }
      this.guard(this.#command(spec.name, parsed.arg));
      return;
    }
    this.#remember(text);
    this.guard(this.#send(text.startsWith("//") ? text.slice(1) : text));
  }

  #remember(text: string) {
    this.editor.addToHistory(text);
    if (this.#history[this.#history.length - 1] !== text) this.#history.push(text);
    if (this.#history.length > 200) this.#history = this.#history.slice(-200);
  }

  async #send(text: string) {
    const newest = this.current.threadId ? this.state.messages[this.state.messages.length - 1] : undefined;
    const pending: Pending = { id: ++this.#seq, text, at: Date.now(), baseline: newest?.id ?? null };
    this.pending.push(pending);
    this.scroll.scrollToEnd();
    this.sync();
    try {
      let threadId = this.current.threadId;
      if (!threadId) {
        const thread = await this.client.createThread({ agentId: this.current.agentId ?? undefined, source: "tui" });
        this.threads = sortThreads([thread, ...this.threads.filter((t) => t.id !== thread.id)]);
        this.openThread(thread.id, { keepPending: true });
        threadId = thread.id;
      }
      await this.client.send(threadId, text, { author: this.author, source: "tui", whenBusy: "steer" });
    } catch (error) {
      pending.failed = true;
      this.sync();
      throw error;
    }
  }

  // ── slash commands ──────────────────────────────────────────────────────

  #commandsWithCompletions(): CommandSpec[] {
    const agentItems = (prefix: string): AutocompleteItem[] =>
      this.agents.map((a) => ({
        value: `${prefix}${a.handle}`,
        label: `${prefix}${a.handle}`,
        description: `${a.name}${a.model ? ` · ${a.model.provider}/${a.model.modelId}` : ""}`,
      }));
    const filter = (items: AutocompleteItem[], arg: string) => {
      const q = arg.trim().toLowerCase();
      return q ? items.filter((i) => i.value.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q)) : items;
    };
    const completers: Record<string, (arg: string) => Promise<AutocompleteItem[]> | AutocompleteItem[]> = {
      new: (arg) => filter(agentItems("@"), arg),
      agent: (arg) => filter(agentItems("@"), arg),
      login: async (arg) =>
        filter(
          sortProviders((this.providers ?? (await this.refreshProviders())).filter((p) => p.oauth)).map((p) => ({
            value: p.id,
            label: p.id,
            description: `${p.oauth!.label}${p.configured ? " · ✓ configured" : ""}`,
          })),
          arg,
        ),
      key: async (arg) =>
        filter(
          sortProviders((this.providers ?? (await this.refreshProviders())).filter((p) => p.apiKey && p.id !== "demo")).map((p) => ({
            value: `${p.id} `,
            label: p.id,
            description: `${p.name}${p.configured ? " · ✓ configured" : ""}`,
          })),
          arg,
        ),
      model: async (arg) => filter(this.#modelItems(await this.#ensureProviders()), arg).slice(0, 60),
    };
    return COMMANDS.map((command) => (completers[command.name] ? { ...command, complete: completers[command.name] } : command));
  }

  async #ensureProviders(): Promise<ProviderInfo[]> {
    return this.providers ?? this.refreshProviders();
  }

  #modelItems(providers: ProviderInfo[]): AutocompleteItem[] {
    return providers
      .filter((p) => p.configured)
      .flatMap((p) =>
        p.models.map((m) => ({
          value: `${p.id}/${m.id}`,
          label: `${p.id}/${m.id}`,
          description: `${m.name}${m.contextWindow ? ` · ${compact(m.contextWindow)} ctx` : ""}${m.reasoning ? " · reasoning" : ""}`,
        })),
      );
  }

  #requireThread(): string {
    if (!this.current.threadId) throw new Error("Send a message first — this conversation has not started yet.");
    return this.current.threadId;
  }

  async #command(name: string, arg: string) {
    switch (name) {
      case "new": {
        const agent = arg ? findAgent(this.agents, arg) : undefined;
        if (arg && !agent) throw new Error(`No agent ${arg.startsWith("@") ? arg : `@${arg}`}. Try /agents.`);
        this.newDraft(agent?.id ?? this.current.agentId ?? undefined);
        return;
      }
      case "agent": {
        if (!arg) return this.#agentPicker("switch");
        const agent = findAgent(this.agents, arg);
        if (!agent) throw new Error(`No agent ${arg.startsWith("@") ? arg : `@${arg}`}. Try /agents.`);
        return this.#switchAgent(agent);
      }
      case "agents":
        return this.#agentPicker("new");
      case "threads":
        return this.#threadPicker();
      case "model":
        return this.#setModel(arg);
      case "title": {
        if (!arg) throw new Error("Usage: /title <new title>");
        const threadId = this.#requireThread();
        const thread = await this.client.updateThread(threadId, { title: arg });
        this.#onEvent({ type: "thread.updated", thread });
        this.notice(`Renamed to “${thread.title}”`, "success");
        return;
      }
      case "reset": {
        await this.client.reset(this.#requireThread());
        this.flash("Fresh context — the agent starts over from here", "success");
        return;
      }
      case "stop": {
        const threadId = this.#requireThread();
        if (!this.isBusy()) return this.flash("Nothing is running");
        await this.client.stop(threadId);
        this.flash("Stopped", "warn");
        return;
      }
      case "compact": {
        this.flash("Compacting…");
        await this.client.compact(this.#requireThread());
        this.flash("Compacted older messages", "success");
        return;
      }
      case "providers":
        return this.#providerPicker();
      case "login": {
        const providers = (await this.#ensureProviders()).filter((p) => p.id !== "demo");
        if (!arg) return this.#providerPicker(true);
        const provider = findProvider(providers, arg);
        if (!provider) throw new Error(`Unknown provider “${arg}”. Try /providers.`);
        if (!provider.oauth) {
          this.editor.setText(`/key ${provider.id} `);
          this.notice(`${provider.name} signs in with an API key — paste it after /key ${provider.id}`, "info");
          return;
        }
        return this.#login(provider);
      }
      case "key": {
        const [providerRef, ...rest] = arg.split(/\s+/);
        const key = rest.join(" ").trim();
        if (!providerRef) throw new Error("Usage: /key <provider> <api-key>");
        const provider = findProvider(await this.#ensureProviders(), providerRef);
        if (!provider) throw new Error(`Unknown provider “${providerRef}”. Try /providers.`);
        if (!key) {
          this.editor.setText(`/key ${provider.id} `);
          this.flash(`Paste your ${provider.name} API key and press enter`);
          return;
        }
        await this.client.setApiKey(provider.id, key);
        this.notice(`Saved the ${provider.name} API key.`, "success");
        void this.refreshProviders();
        return;
      }
      case "connectors":
        return this.#connectors();
      case "usage":
        return this.#usage();
      case "clear":
        return this.#clear();
      case "help":
        return this.#help();
      case "quit":
        return this.quit();
    }
  }

  async #switchAgent(agent: Agent) {
    const threadId = this.current.threadId;
    if (!threadId) {
      this.current.agentId = agent.id;
      this.sync();
      return this.flash(`Talking to @${agent.handle}`, "success");
    }
    if (this.state.thread?.agentId === agent.id) return this.flash(`Already talking to @${agent.handle}`);
    const thread = await this.client.updateThread(threadId, { agentId: agent.id });
    this.#onEvent({ type: "thread.updated", thread });
    this.current.agentId = agent.id;
    this.notice(`Switched this thread to ${agent.avatar} @${agent.handle}`, "success");
  }

  async #setModel(arg: string) {
    const agent = this.currentAgent();
    if (!agent) throw new Error("No agent selected.");
    const providers = await this.#ensureProviders();
    if (!arg) {
      const items = this.#modelItems(providers);
      if (items.length === 0) throw new Error("No providers are configured. Try /login or /providers.");
      const current = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : undefined;
      return this.#picker(`Model for @${agent.handle}`, items, (value) => this.guard(this.#setModel(value)), { selected: current, placeholder: "Search models…" });
    }
    const slash = arg.indexOf("/");
    if (slash <= 0) throw new Error("Usage: /model <provider>/<model>");
    const providerId = arg.slice(0, slash);
    const modelId = arg.slice(slash + 1);
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) throw new Error(`Unknown provider “${providerId}”.`);
    if (!provider.models.some((m) => m.id === modelId)) throw new Error(`${provider.name} has no model “${modelId}”.`);
    if (!provider.configured) this.notice(`${provider.name} is not configured yet — /login ${provider.id} or /key ${provider.id} <key>`, "warn");
    await this.client.updateAgent(agent.id, { model: { provider: providerId, modelId } });
    this.notice(`@${agent.handle} now runs on ${providerId}/${modelId}`, "success");
  }

  // ── overlays ────────────────────────────────────────────────────────────

  openOverlay(panel: Component, title: string, kind: OverlayKind, options: { hint?: string | (() => string); width?: number } = {}) {
    this.closeOverlay();
    const frame = new Frame(panel, { title, hint: options.hint });
    const columns = this.tui.terminal.columns;
    const handle = this.tui.showOverlay(frame, {
      width: Math.max(20, Math.min(options.width ?? 78, columns - 2)),
      maxHeight: Math.max(5, this.tui.terminal.rows - 2),
      anchor: "center",
    });
    this.overlay = { handle, kind, panel };
    this.tui.requestRender();
  }

  closeOverlay() {
    if (!this.overlay) return;
    this.overlay.handle.hide();
    this.overlay = undefined;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  #pickerRows() {
    return Math.max(3, Math.min(14, this.tui.terminal.rows - 10));
  }

  #picker(title: string, items: PickerItem[], onSelect: (value: string) => void, options: { selected?: string; placeholder?: string; emptyText?: string } = {}) {
    const picker = new Picker(items, { ...options, maxVisible: this.#pickerRows() });
    picker.onCancel = () => this.closeOverlay();
    picker.onSelect = (value) => {
      this.closeOverlay();
      onSelect(value);
    };
    this.openOverlay(picker, title, "picker", { hint: "↑↓ move · enter choose · esc close" });
  }

  #threadPicker() {
    const items: PickerItem[] = [
      { value: "__new__", label: `${c.accent("✦")} New conversation`, description: "ctrl+n", search: "new conversation" },
      ...this.threads.map((t) => {
        const agent = this.agentById(t.agentId);
        const marks = `${t.busy ? " ⠿" : ""}${this.unread.has(t.id) ? " ●" : ""}`;
        return {
          value: t.id,
          label: `${sourceIcon(t.source)} ${oneLine(t.title) || "Untitled"}${marks}`,
          description: `${agent ? `@${agent.handle}` : "?"} · ${SOURCE_LABEL[t.source]}${t.location ? ` ${t.location}` : ""} · ${relTime(t.updatedAt)}`,
          search: `${t.title} ${agent?.handle ?? ""} ${t.source} ${t.location ?? ""} ${t.preview}`,
        };
      }),
    ];
    this.#picker(
      "Threads",
      items,
      (value) => (value === "__new__" ? this.newDraft(this.current.agentId ?? undefined) : this.openThread(value)),
      { selected: this.current.threadId ?? "__new__", placeholder: "Search threads…" },
    );
  }

  #agentPicker(mode: "new" | "switch") {
    if (this.agents.length === 0) return this.notice("No agents yet — create one in the web GUI.", "warn");
    const items: PickerItem[] = this.agents.map((a) => ({
      value: a.id,
      label: `${agentColor(a.color)(a.avatar)} @${a.handle}${a.isDefault ? c.dim(" ★") : ""}`,
      description: `${a.name} · ${a.model ? `${a.model.provider}/${a.model.modelId}` : "no model"}${a.description ? ` — ${oneLine(a.description)}` : ""}`,
      search: `${a.handle} ${a.name} ${a.description}`,
    }));
    this.#picker(
      mode === "new" ? "Start a chat with…" : "Switch this thread to…",
      items,
      (id) => {
        const agent = this.agentById(id);
        if (!agent) return;
        if (mode === "new") this.newDraft(agent.id);
        else this.guard(this.#switchAgent(agent));
      },
      { selected: this.currentAgent()?.id, placeholder: "Search agents…" },
    );
  }

  async #providerPicker(oauthOnly = false) {
    const providers = sortProviders((await this.#ensureProviders()).filter((p) => p.id !== "demo" && (!oauthOnly || p.oauth)));
    const items: PickerItem[] = providers.map((p) => {
      const how = [p.oauth ? p.oauth.label : null, p.apiKey ? "API key" : null].filter(Boolean).join(" · ");
      const state = p.configured ? `✓ ${p.configured.type === "oauth" ? "signed in" : "key set"}${p.configured.source ? ` (${p.configured.source})` : ""}` : "";
      return {
        value: p.id,
        label: `${p.configured ? c.green("✓") : " "} ${p.name}`,
        description: [state, how, `${p.models.length} models`].filter(Boolean).join(" · "),
        search: `${p.id} ${p.name} ${how}`,
      };
    });
    const configured = providers.filter((p) => p.configured).length;
    this.#picker(
      oauthOnly ? "Sign in with…" : `Providers · ${configured} configured`,
      items,
      (id) => {
        const provider = providers.find((p) => p.id === id);
        if (!provider) return;
        if (provider.oauth) this.#login(provider);
        else {
          this.editor.setText(`/key ${provider.id} `);
          this.flash(`Paste your ${provider.name} API key and press enter`);
        }
      },
      { placeholder: "Search providers…" },
    );
  }

  #login(provider: ProviderInfo) {
    const panel = new LoginPanel(this.client, provider);
    panel.openUrl = openBrowser;
    panel.onChange = () => this.tui.requestRender();
    panel.onClose = (signedIn) => {
      this.closeOverlay();
      if (signedIn) {
        this.notice(`Signed in to ${provider.name}. Agents on the demo model switch over automatically.`, "success");
        void this.refreshProviders().then(() => this.#refreshLists());
      }
    };
    this.openOverlay(panel, `Sign in · ${provider.name}`, "login", {
      hint: () => (panel.flow?.status === "done" || panel.flow?.status === "failed" ? "enter close" : "enter submit · esc cancel"),
    });
    void panel.start();
  }

  #info(title: string, kind: OverlayKind, content: (width: number) => string[], width = 78) {
    const panel = new InfoPanel(content, () => Math.max(3, this.tui.terminal.rows - 8));
    panel.onClose = () => this.closeOverlay();
    this.openOverlay(panel, title, kind, { width, hint: () => [panel.scrollHint(), "esc close"].filter(Boolean).join(" · ") });
    return panel;
  }

  #help() {
    const k = (key: string, text: string, w: number) => `  ${c.accent(key.padEnd(w))} ${c.muted(text)}`;
    this.#info(`${BRAND} soloagent ${this.version}`, "info", () => {
      const lines = [bold("Commands")];
      for (const cmd of COMMANDS) lines.push(k(`/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`, cmd.description, 26));
      lines.push("", bold("Keys"));
      const keys: [string, string][] = [
        ["enter", "send — steers the agent while it works"],
        ["shift+enter  alt+enter", "new line"],
        ["↑ ↓", "prompt history"],
        ["esc", "stop the run"],
        ["ctrl+p", "threads from every channel"],
        ["ctrl+n", "new conversation"],
        ["alt+↑  alt+↓", "previous / next thread"],
        ["ctrl+b", "toggle the sidebar"],
        ["ctrl+t", "show or hide thinking"],
        ["ctrl+o", "expand tool output (or click a tool line)"],
        ["pgup pgdn  wheel", "scroll · ctrl+home / ctrl+end jump"],
        ["ctrl+↑  ctrl+↓", "jump between your messages"],
        ["ctrl+shift+f", "search the transcript"],
        ["ctrl+l", "clear the screen"],
        ["ctrl+c ctrl+c", "quit"],
      ];
      for (const [key, text] of keys) lines.push(k(key, text, 26));
      lines.push("", c.dim(`Connected to ${this.conn.url} (${this.conn.embedded ? "embedded local server" : this.conn.mode}). Mouse: drag to select & copy, click links.`));
      return lines;
    });
  }

  async #usage() {
    const summary = await this.client.usage();
    this.#info("Usage", "info", (width) => {
      const line = (label: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }, extra = "") => {
        const nums = `${c.muted(`↑${compact(u.input + u.cacheRead + u.cacheWrite)}`.padStart(8))} ${c.muted(`↓${compact(u.output)}`.padStart(7))} ${bold(money(u.cost).padStart(9))}`;
        const room = Math.max(8, width - visibleWidth(nums) - 2);
        const shown = visibleWidth(label) > room ? `${label.slice(0, room - 1)}…` : label;
        return `${shown}${" ".repeat(Math.max(1, width - visibleWidth(shown) - visibleWidth(nums)))}${nums}${extra}`;
      };
      const lines = [line(bold("Total"), summary.total), ""];
      if (summary.byAgent.length) {
        lines.push(c.dim("BY AGENT"));
        for (const row of [...summary.byAgent].sort((a, b) => b.usage.cost - a.usage.cost)) {
          const agent = this.agentById(row.agentId);
          lines.push(line(`${agent ? agentColor(agent.color)(`${agent.avatar} @${agent.handle}`) : row.agentId} ${c.dim(`${row.threads} threads`)}`, row.usage));
        }
        lines.push("");
      }
      if (summary.byModel.length) {
        lines.push(c.dim("BY MODEL"));
        for (const row of [...summary.byModel].sort((a, b) => b.usage.cost - a.usage.cost)) lines.push(line(row.model, row.usage));
      }
      if (!summary.byAgent.length && !summary.byModel.length) lines.push(c.dim("Nothing used yet."));
      return lines;
    });
  }

  #connectorLines: string[] | undefined;

  async #loadConnectors() {
    const [connectors, kinds] = await Promise.all([this.client.connectors(), this.client.connectorKinds().catch(() => [])]);
    const icon: Record<string, string> = { slack: "#", discord: "◆", telegram: "➤", webhook: "↯" };
    const lines: string[] = [];
    if (connectors.length === 0) {
      lines.push(c.muted("No connectors yet."), "");
      for (const kind of kinds) lines.push(`  ${c.accent(icon[kind.kind] ?? "•")} ${bold(kind.name)} ${c.dim(kind.tagline)}`);
      lines.push("", c.dim("Add one from the web GUI (soloagent token prints its login)."));
    }
    for (const conn of connectors) {
      const status =
        conn.status === "connected" ? c.green("● connected") : conn.status === "starting" ? c.yellow("◌ starting") : conn.status === "error" ? c.red("✗ error") : c.dim("○ stopped");
      const agent = this.agentById(conn.agentId) ?? this.defaultAgent();
      lines.push(`${c.accent(icon[conn.kind] ?? "•")} ${bold(conn.name)} ${c.dim(conn.kind)}  ${status}${conn.enabled ? "" : c.dim(" · disabled")}`);
      const details = [conn.identity, agent ? `answers as @${agent.handle}` : undefined].filter(Boolean).join(" · ");
      if (details) lines.push(`  ${c.muted(details)}`);
      if (conn.statusDetail) lines.push(`  ${conn.status === "error" ? c.red(oneLine(conn.statusDetail)) : c.dim(oneLine(conn.statusDetail))}`);
      lines.push("");
    }
    this.#connectorLines = lines;
    this.tui.requestRender();
  }

  async #connectors() {
    await this.#loadConnectors();
    this.#info("Connectors", "connectors", () => this.#connectorLines ?? []);
  }
}

function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function runTui(conn: Connection, options: TuiOptions): Promise<number> {
  const app = new App(conn, options.version);
  try {
    return await app.start(options);
  } catch (error) {
    await conn.close();
    throw error;
  }
}
