import type { Component } from "@earendil-works/pi-tui";
import type { ViewModel } from "../model.ts";
import { agentColor, blend, bold, c, fg, palette } from "../theme.ts";
import { center, fitAll, wrapWith } from "./util.ts";

/** "soloagent" in a three-row half-block font. */
const FONT: Record<string, [string, string, string]> = {
  s: ["▄▀▀▀", " ▀▀▄", "▀▀▀ "],
  o: ["▄▀▀▄", "█  █", "▀▄▄▀"],
  l: ["█   ", "█   ", "▀▀▀▀"],
  a: ["▄▀▀▄", "█▀▀█", "▀  ▀"],
  g: ["▄▀▀▀", "█ ▀█", "▀▄▄▀"],
  e: ["█▀▀▀", "█▀▀ ", "▀▀▀▀"],
  n: ["█▄ █", "█ ▀█", "▀  ▀"],
  t: ["▀█▀", " █ ", " ▀ "],
};

function wordmark(): string[] {
  const rows = ["", "", ""];
  const letters = [..."soloagent"];
  letters.forEach((ch, i) => {
    const glyph = FONT[ch]!;
    for (let r = 0; r < 3; r++) rows[r] += glyph[r] + (i < letters.length - 1 ? " " : "");
  });
  const width = rows[0]!.length;
  // Violet gradient, column by column.
  return rows.map((row) =>
    [...row]
      .map((ch, x) => (ch === " " ? ch : fg(blend(palette.accentSoft, palette.accentDeep, x / Math.max(1, width - 1)))(ch)))
      .join(""),
  );
}

const MARK = wordmark();
const MARK_WIDTH = 43;

/** The empty-thread screen: wordmark, who you are talking to, and a few tips. */
export class Welcome implements Component {
  readonly vm: ViewModel;
  constructor(vm: ViewModel) {
    this.vm = vm;
  }

  render(width: number): string[] {
    const vm = this.vm;
    const agent = vm.agentById(vm.current.agentId);
    const rows = vm.tui.terminal.rows;
    // The transcript area: rows minus header, editor, and footer.
    const available = rows - (rows >= 22 ? 2 : 1) - 3 - 1;

    const big = width >= MARK_WIDTH + 4 ? [...MARK.map((row) => center(row, width)), "", center(c.muted("one control plane for all of your agents"), width)] : undefined;
    const small = [center(`${c.accent("✦")} ${bold("soloagent")}  ${c.muted("all of your agents, one place")}`, width)];

    const who: string[] = [];
    if (agent) {
      const color = agentColor(agent.color);
      const model = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "no model yet";
      who.push(center(`${c.dim("talking to")} ${color(`${agent.avatar} ${agent.name}`)} ${c.dim(`@${agent.handle} · ${model}`)}`, width));
    } else {
      who.push(center(c.yellow("No agents yet — create one in the web GUI"), width));
    }

    const tipWidth = Math.min(width - 4, 64);
    const left = " ".repeat(Math.max(0, Math.floor((width - tipWidth) / 2)));
    const tipRows: [string, string][] = [
      ["enter", "send · shift+enter or alt+enter for a new line"],
      ["/", "commands — /agents, /threads, /providers, /help"],
      ["ctrl+p", "jump to any thread, from Slack, Discord, the web…"],
      ["ctrl+b", "toggle the thread sidebar"],
    ];
    const tips = tipRows.map(([key, text]) => `${left}${c.accent(key.padStart(8))}  ${c.muted(text)}`);

    const hint: string[] = [];
    if (vm.providers && !vm.hasRealProvider()) {
      const note = wrapWith(
        "Only the built-in demo model is set up. Run /login anthropic to use your Claude Pro/Max subscription — or /login openai, /login github-copilot, /providers for 30+ more.",
        tipWidth - 2,
        "",
        c.yellow,
      );
      hint.push(...note.map((l, i) => left + (i === 0 ? `${c.yellow("✦")} ${l}` : `  ${l}`)));
    }

    // Largest layout that fits without scrolling; the hint always stays.
    const variants = [
      [...(big ?? small), "", ...who, "", ...tips, ...(hint.length ? ["", ...hint] : [])],
      [...small, "", ...who, "", ...tips, ...(hint.length ? ["", ...hint] : [])],
      [...small, ...who, "", ...(hint.length ? hint : tips.slice(0, 2))],
      [...small, ...hint],
    ];
    const lines = variants.find((v) => v.length + 1 <= available) ?? variants[variants.length - 1]!;
    // Sit a little above the middle.
    const top = Math.max(1, Math.floor((available - lines.length) / 3));
    return fitAll([...Array.from({ length: top }, () => ""), ...lines], width);
  }

  invalidate(): void {}
}
