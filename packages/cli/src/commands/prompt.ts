import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export type Choice = { value: string; label: string; description?: string };

/** Arrow-key picker on the main screen (pi-tui SelectList). Falls back to a numbered prompt. */
export async function choose(title: string, choices: Choice[]): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return chooseNumbered(title, choices);
  const { ProcessTerminal, SelectList, Text, TuiMainScreen, Spacer } = await import("@earendil-works/pi-tui");
  const { c, bold, selectListTheme, BRAND } = await import("../tui/theme.ts");
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const list = new SelectList(choices, Math.min(12, Math.max(4, terminal.rows - 6)), selectListTheme, { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 28 });
  tui.addChild(new Text(`${c.accent(BRAND)} ${bold(title)}`, 1, 0));
  tui.addChild(new Spacer(1));
  tui.addChild(list);
  tui.addChild(new Text(c.dim("↑↓ move · enter select · esc cancel"), 1, 0));
  tui.setFocus(list);
  tui.setClearOnShrink(true);
  return new Promise((resolve) => {
    const finish = (value: string | undefined) => {
      // Collapse the list into a one-line summary of the choice.
      const picked = choices.find((c) => c.value === value);
      tui.clear();
      tui.addChild(new Text(`${c.accent(BRAND)} ${bold(title)} ${picked ? picked.label.trim() : c.dim("cancelled")}`, 1, 0));
      tui.renderNow(true);
      tui.stop();
      resolve(value);
    };
    list.onSelect = (item) => finish(item.value);
    list.onCancel = () => finish(undefined);
    tui.start();
  });
}

async function chooseNumbered(title: string, choices: Choice[]): Promise<string | undefined> {
  process.stderr.write(`${title}\n`);
  choices.forEach((choice, i) => process.stderr.write(`  ${String(i + 1).padStart(2)}. ${choice.label}${choice.description ? ` — ${choice.description}` : ""}\n`));
  const answer = await ask(`Choose 1-${choices.length}: `);
  const index = Number(answer) - 1;
  return choices[index]?.value ?? choices.find((c) => c.value === answer.trim())?.value;
}

/** Read one line from the terminal. Rejects with an AbortError when `signal` fires. */
export async function ask(question: string, signal?: AbortSignal): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: Boolean(process.stdin.isTTY) });
  try {
    return await rl.question(question, signal ? { signal } : {});
  } finally {
    rl.close();
  }
}

/** Read a secret without echoing it. */
export async function askSecret(question: string, signal?: AbortSignal): Promise<string> {
  process.stderr.write(question);
  let muted = true;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  try {
    const value = await rl.question("", signal ? { signal } : {});
    muted = false;
    process.stderr.write("\n");
    return value;
  } finally {
    rl.close();
  }
}

/** Best-effort: open a URL in the user's browser. Never throws. */
export function openBrowser(url: string): boolean {
  if (process.env.SOLOAGENT_NO_BROWSER) return false;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
