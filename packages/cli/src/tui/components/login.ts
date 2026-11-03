import {
  type Component,
  type Focusable,
  getCapabilities,
  getKeybindings,
  hyperlink,
  Input,
  matchesKey,
  SelectList,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { LoginFlowState, ProviderInfo, SoloClient } from "@soloagent/client";
import { bold, c, selectListTheme, spinnerFrame } from "../theme.ts";
import { fitAll, sanitize, wrapWith } from "./util.ts";

/**
 * In-TUI subscription sign-in: shows the auth URL and device code, answers the flow's prompts,
 * and streams its log from `login.updated` events.
 */
export class LoginPanel implements Component, Focusable {
  readonly client: SoloClient;
  readonly provider: ProviderInfo;
  flow: LoginFlowState | undefined;
  error: string | undefined;
  readonly input: Input;
  #select: SelectList | undefined;
  #promptKey: string | undefined;
  #focused = false;
  #seen = new Set<string>();
  #opened = new Set<string>();
  #submitting = false;
  onClose?: (signedIn: boolean) => void;
  onChange?: () => void;
  openUrl?: (url: string) => boolean;

  constructor(client: SoloClient, provider: ProviderInfo) {
    this.client = client;
    this.provider = provider;
    this.input = new Input({ prompt: c.accent("› "), placeholder: "", placeholderStyle: c.dim });
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

  async start() {
    try {
      this.update(await this.client.startLogin(this.provider.id, "oauth"));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.onChange?.();
    }
  }

  get active() {
    return this.flow?.status === "running" || this.flow?.status === "waiting";
  }

  /** Apply a flow snapshot (from the start call, an answer, or a `login.updated` event). */
  update(flow: LoginFlowState) {
    if (this.flow && flow.id !== this.flow.id) return;
    this.flow = flow;
    for (const url of [flow.authUrl?.url, flow.deviceCode?.verificationUri]) {
      if (url && !this.#seen.has(url)) {
        this.#seen.add(url);
        if (this.openUrl?.(url)) this.#opened.add(url);
      }
    }
    const key = flow.status === "waiting" && flow.prompt ? `${flow.prompt.type}:${flow.prompt.message}` : undefined;
    if (key !== this.#promptKey) {
      this.#promptKey = key;
      this.input.setValue("");
      this.#select = undefined;
      if (flow.prompt?.type === "select") {
        this.#select = new SelectList(
          (flow.prompt.options ?? []).map((o) => ({ value: o.id, label: o.label, description: o.description })),
          6,
          selectListTheme,
        );
        this.#select.onSelect = (item) => void this.#answer(item.value);
      }
    }
    this.onChange?.();
  }

  async #answer(value: string) {
    if (!this.flow || this.#submitting) return;
    this.#submitting = true;
    try {
      this.update(await this.client.answerLogin(this.flow.id, value));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.#submitting = false;
      this.onChange?.();
    }
  }

  async cancel() {
    if (this.flow && this.active) await this.client.cancelLogin(this.flow.id).catch(() => {});
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    const status = this.flow?.status;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      void this.cancel();
      this.onClose?.(status === "done");
      return;
    }
    if (status === "done" || status === "failed" || status === "cancelled" || (!this.flow && this.error)) {
      if (kb.matches(data, "tui.select.confirm")) this.onClose?.(status === "done");
      return;
    }
    if (this.#select) {
      this.#select.handleInput(data);
      return;
    }
    if (this.flow?.status === "waiting" && this.flow.prompt) {
      if (kb.matches(data, "tui.input.submit")) {
        // Blank is a valid answer for some prompts ("blank for github.com").
        const value = this.input.getValue().trim();
        if (value || this.flow.prompt.type === "text") void this.#answer(value);
        return;
      }
      this.input.handleInput(data);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return event.type === "wheel" ? { handled: true } : undefined;
  }

  render(width: number): string[] {
    const flow = this.flow;
    const lines: string[] = [];
    const links = getCapabilities().hyperlinks;
    const link = (text: string, url: string) => (links ? hyperlink(text, url) : text);

    if (!flow) {
      if (this.error) lines.push(...wrapWith(`✗ ${this.error}`, width, "", c.red), "", c.dim("enter or esc to close"));
      else lines.push(`${c.accent(spinnerFrame())} ${c.muted(`Starting sign-in with ${this.provider.oauth?.label ?? this.provider.name}…`)}`);
      return fitAll(lines, width);
    }

    const status =
      flow.status === "done"
        ? c.green("✓ Signed in")
        : flow.status === "failed"
          ? c.red("✗ Sign-in failed")
          : flow.status === "cancelled"
            ? c.dim("Cancelled")
            : flow.status === "waiting"
              ? `${c.accent("●")} ${c.accentBright("Waiting for you")}`
              : `${c.accent(spinnerFrame())} ${c.muted("Working…")}`;
    lines.push(`${status}  ${c.dim(this.provider.oauth?.label ?? this.provider.name)}`);
    lines.push("");

    if (flow.authUrl && flow.status !== "done") {
      lines.push(c.muted(this.#opened.has(flow.authUrl.url) ? "Opened in your browser. If it did not open, visit:" : "Open this link to sign in:"));
      const url = flow.authUrl.url;
      for (let i = 0; i < url.length; i += width) lines.push(link(c.cyan(url.slice(i, i + width)), url));
      if (flow.authUrl.instructions) lines.push(...wrapWith(sanitize(flow.authUrl.instructions), width, "", c.dim));
      lines.push("");
    }

    if (flow.deviceCode && flow.status !== "done") {
      lines.push(`${c.muted("Enter this code at")} ${link(c.cyan(flow.deviceCode.verificationUri), flow.deviceCode.verificationUri)}`);
      lines.push("");
      lines.push(`    ${bold(c.accentBright(flow.deviceCode.userCode.split("").join(" ")))}`);
      lines.push("");
    }

    if (flow.status === "waiting" && flow.prompt) {
      const message = flow.prompt.type === "manual_code" ? flow.prompt.message || "Paste the code or redirect URL" : flow.prompt.message;
      lines.push(...wrapWith(sanitize(message), width, "", bold));
      if (this.#select) lines.push(...this.#select.render(width));
      else {
        lines.push(...this.input.render(width));
        if (flow.prompt.type === "secret") lines.push(c.yellow("  this value is shown as you type"));
        else if (flow.prompt.placeholder) lines.push(c.dim(`  ${flow.prompt.placeholder}`));
      }
      lines.push("");
    }

    if (flow.status === "failed" && flow.error) lines.push(...wrapWith(sanitize(flow.error), width, "", c.red), "");
    if (flow.status === "done") lines.push(c.muted(`Your agents can now run on ${this.provider.name}.`), "");

    // The URL and code are shown above; skip their log lines.
    const log = flow.log
      .filter((e) => e.message !== flow.authUrl?.instructions && !(flow.deviceCode && e.message.includes(flow.deviceCode.userCode)))
      .slice(-5);
    for (const entry of log) lines.push(...wrapWith(`· ${sanitize(entry.message)}`, width, "", c.dim));
    if (this.error) lines.push(...wrapWith(`✗ ${this.error}`, width, "", c.red));
    return fitAll(lines, width);
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
