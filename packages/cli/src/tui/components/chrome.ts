import { Editor, type EditorOptions, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { compact, money, oneLine, totalUsage } from "../format.ts";
import type { ViewModel } from "../model.ts";
import { agentColor, bold, BRAND, c, editorTheme, spinnerFrame } from "../theme.ts";
import { fit, spread } from "./util.ts";

const SEP = c.faint(" │ ");

function portOf(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `:${u.port}` : u.host;
  } catch {
    return url;
  }
}

/** ● soloagent │ ✦ Solo @solo · model │ thread title ……… ● local · ⠋ working */
export function renderHeader(vm: ViewModel, width: number, rule: boolean): string[] {
  const agent = vm.currentAgent();
  const thread = vm.currentThread();
  const brand = ` ${BRAND} ${bold("soloagent")}`;

  let agentPart = c.yellow("no agent");
  if (agent) {
    const color = agentColor(agent.color);
    const model = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "no model";
    agentPart = `${color(agent.avatar)} ${color(bold(`@${agent.handle}`))} ${c.dim(model)}`;
  }
  const title = thread ? oneLine(thread.title) : c.dim("new conversation");

  const right: string[] = [];
  if (vm.isBusy()) right.push(`${c.accent(spinnerFrame())} ${c.accentBright("working")}`);
  const where = vm.conn.embedded ? "local" : vm.conn.mode === "local" ? `local ${portOf(vm.conn.url)}` : `remote · ${vm.conn.label}`;
  if (vm.connected) right.push(`${c.green("●")} ${c.muted(where)}`);
  else if (vm.everConnected) right.push(`${c.yellow("◌")} ${c.yellow("reconnecting…")}`);
  else right.push(`${c.dim("◌")} ${c.dim(`connecting to ${where}…`)}`);
  const rightText = `${right.join(c.faint("  ·  "))} `;

  // Drop the least important pieces first on narrow terminals.
  const room = width - visibleWidth(rightText) - 1;
  const candidates = [
    [brand, agentPart, title],
    [brand, agentPart],
    [` ${BRAND}`, agentPart],
    [` ${c.accent(BRAND)}`],
  ];
  let left = candidates[candidates.length - 1]!.join(SEP);
  for (const parts of candidates) {
    const joined = parts.join(SEP);
    const minimum = parts.length === 3 ? visibleWidth(parts.slice(0, 2).join(SEP)) + visibleWidth(SEP) + 8 : visibleWidth(joined);
    if (minimum <= room) {
      left = joined;
      break;
    }
  }
  const lines = [spread(left, rightText, width)];
  if (rule) lines.push(c.faint("─".repeat(width)));
  return lines;
}

/** Key hints on the left, thread token/cost totals on the right. */
export function renderFooter(vm: ViewModel, width: number, overlay: string | undefined): string[] {
  const message = vm.footerMessage();
  const k = (key: string, label: string) => `${c.muted(key)} ${c.dim(label)}`;

  const usage = totalUsage(vm.state.messages);
  let right = "";
  if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
    const agent = vm.currentAgent();
    const model = agent?.model ? vm.providers?.find((p) => p.id === agent.model!.provider)?.models.find((m) => m.id === agent.model!.modelId) : undefined;
    const parts = [`↑${compact(usage.input + usage.cacheRead + usage.cacheWrite)}`, `↓${compact(usage.output)}`];
    if (usage.cost > 0) parts.push(money(usage.cost));
    if (model?.contextWindow && usage.lastContext > 0) parts.push(`${Math.min(100, Math.round((usage.lastContext / model.contextWindow) * 100))}% ctx`);
    right = `${c.dim(parts.join("  "))} `;
  }

  if (message) {
    const tone = message.tone === "error" ? c.red : message.tone === "warn" ? c.yellow : message.tone === "success" ? c.green : c.accentBright;
    return [spread(` ${tone(message.text)}`, right, width)];
  }
  let items: string[];
  if (overlay === "picker") items = [k("type", "to filter"), k("↑↓", "move"), k("enter", "choose"), k("esc", "close")];
  else if (overlay === "login") items = [k("enter", "submit"), k("esc", "cancel sign-in")];
  else if (overlay) items = [k("↑↓ pgup pgdn", "scroll"), k("esc", "close")];
  else if (vm.isBusy()) items = [k("enter", "steer"), k("esc", "stop"), k("ctrl+t", "thinking"), k("ctrl+o", "tool output"), k("ctrl+p", "threads")];
  else items = [k("/", "commands"), k("ctrl+p", "threads"), k("ctrl+b", "sidebar"), k("ctrl+t", "thinking"), k("ctrl+o", "tools"), k("ctrl+c", "quit")];
  // Narrow terminals drop whole hints from the end instead of cutting one in half.
  const room = width - visibleWidth(right) - 2;
  const sep = c.faint(" · ");
  let hints = "";
  for (const item of items) {
    const next = hints ? hints + sep + item : item;
    if (visibleWidth(next) > room) break;
    hints = next;
  }
  return [spread(` ${hints}`, right, width)];
}

/**
 * The prompt editor. Its top border names who you are talking to, and turns into a steering
 * prompt while the agent works.
 */
export class ChatEditor extends Editor {
  readonly vm: ViewModel;
  constructor(tui: TUI, vm: ViewModel, options?: EditorOptions) {
    super(tui, editorTheme, options);
    this.vm = vm;
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);
    const agent = this.vm.currentAgent();
    const busy = this.vm.isBusy();
    const line = busy ? c.yellow : this.borderColor;
    let label: string;
    if (busy) label = `${c.yellow("↳ steer")} ${c.dim("enter to send · esc to stop")}`;
    else if (agent) label = `${agentColor(agent.color)(`${agent.avatar} @${agent.handle}`)}`;
    else label = c.dim("message");
    const text = ` ${label} `;
    const rest = Math.max(0, width - 2 - visibleWidth(text));
    return fit(line("──") + text + line("─".repeat(rest)), width);
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    if (hiddenLineCount > 0) return super.renderBottomBorder(width, hiddenLineCount);
    return (this.vm.isBusy() ? c.yellow : this.borderColor)("─".repeat(Math.max(0, width)));
  }
}
