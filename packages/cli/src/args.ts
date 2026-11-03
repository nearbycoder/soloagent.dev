/** Dependency-free argument parsing: `--flag value`, `--flag=value`, booleans, `--` and short aliases. */

/** "strings": a repeatable string flag, collected as an array. */
export type FlagKind = "boolean" | "string" | "strings";
export type FlagSpec = Record<string, FlagKind>;
export type Parsed = { positionals: string[]; flags: Record<string, string | boolean | string[] | undefined> };

export class UsageError extends Error {}

const ALIASES: Record<string, string> = { h: "help", v: "version", a: "agent", t: "thread", p: "port", j: "json" };

export function parseArgs(argv: string[], spec: FlagSpec): Parsed {
  const positionals: string[] = [];
  const flags: Parsed["flags"] = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    // A lone "-" is a positional (stdin).
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      inline = eq === -1 ? undefined : arg.slice(eq + 1);
    } else {
      const short = arg.slice(1);
      name = ALIASES[short] ?? short;
    }
    if (name.startsWith("no-") && spec[name.slice(3)] === "boolean") {
      flags[name.slice(3)] = false;
      continue;
    }
    const kind = spec[name];
    if (!kind) throw new UsageError(`Unknown option ${arg}`);
    if (kind === "boolean") {
      if (inline !== undefined && !/^(true|false|1|0)$/.test(inline)) throw new UsageError(`${arg} does not take a value`);
      flags[name] = inline === undefined ? true : inline === "true" || inline === "1";
      continue;
    }
    const set = (value: string) => {
      if (kind === "strings") flags[name] = [...((flags[name] as string[] | undefined) ?? []), value];
      else flags[name] = value;
    };
    if (inline !== undefined) {
      set(inline);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-")) throw new UsageError(`${arg} needs a value`);
    set(next);
    i++;
  }
  return { positionals, flags };
}

export const str = (value: string | boolean | string[] | undefined): string | undefined => (typeof value === "string" ? value : undefined);
export const strs = (value: string | boolean | string[] | undefined): string[] => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []);
