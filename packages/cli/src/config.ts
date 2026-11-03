import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Saved remote connection, written by `soloagent connect`. */
export type SavedConfig = { url?: string; token?: string };

/** A soloagent server started from this machine (`soloagent serve` or an embedded TUI). */
export type LocalRuntime = { url: string; token: string; pid: number; dataDir: string; startedAt: number };

/** Root of everything the CLI keeps on disk. Override with SOLOAGENT_HOME. */
export function soloHome(): string {
  return process.env.SOLOAGENT_HOME || join(homedir(), ".soloagent");
}

export const paths = {
  get config() {
    return join(soloHome(), "config.json");
  },
  get data() {
    return join(soloHome(), "data");
  },
  get runtime() {
    return join(soloHome(), "runtime.json");
  },
  get log() {
    return join(soloHome(), "soloagent.log");
  },
  get history() {
    return join(soloHome(), "history.json");
  },
};

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writePrivateJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // not fatal on filesystems without modes
  }
}

export function loadConfig(): SavedConfig {
  return readJson<SavedConfig>(paths.config) ?? {};
}

export function saveConfig(config: SavedConfig) {
  writePrivateJson(paths.config, config);
}

/** Forget the saved remote. Returns whether there was one. */
export function clearConfig(): boolean {
  const existed = existsSync(paths.config);
  rmSync(paths.config, { force: true });
  return existed;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The local server another soloagent process is running, if it is still alive. */
export function loadRuntime(): LocalRuntime | undefined {
  const runtime = readJson<LocalRuntime>(paths.runtime);
  if (!runtime?.url || !runtime.token || !runtime.pid) return undefined;
  if (runtime.pid !== process.pid && !pidAlive(runtime.pid)) return undefined;
  return runtime;
}

export function saveRuntime(runtime: LocalRuntime) {
  writePrivateJson(paths.runtime, runtime);
}

export function clearRuntime() {
  if (readJson<LocalRuntime>(paths.runtime)?.pid === process.pid) rmSync(paths.runtime, { force: true });
}

/** Prompt history for the TUI editor, newest last. */
export function loadHistory(): string[] {
  const history = readJson<string[]>(paths.history);
  return Array.isArray(history) ? history.filter((h) => typeof h === "string").slice(-200) : [];
}

export function saveHistory(history: string[]) {
  try {
    writePrivateJson(paths.history, history.slice(-200));
  } catch {
    // history is a convenience
  }
}
