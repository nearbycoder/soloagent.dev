import { type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, fuzzyFilter } from "@earendil-works/pi-tui";

export type CommandSpec = {
  name: string;
  args?: string;
  description: string;
  aliases?: string[];
  /** Completions for the argument text typed so far. Values are the complete argument. */
  complete?: (arg: string) => AutocompleteItem[] | Promise<AutocompleteItem[]>;
  /** Keep this out of prompt history (it may carry a secret). */
  secret?: boolean;
};

export const COMMANDS: CommandSpec[] = [
  { name: "new", args: "[@agent]", description: "start a new conversation" },
  { name: "agent", args: "<handle>", description: "switch this thread to another agent" },
  { name: "agents", description: "pick an agent and start a chat" },
  { name: "threads", description: "browse conversations from every channel (ctrl+p)" },
  { name: "model", args: "[provider/model]", description: "change the current agent's model" },
  { name: "title", args: "<text>", description: "rename this thread" },
  { name: "reset", description: "give the agent a fresh context in this thread" },
  { name: "stop", description: "stop the current run (esc)" },
  { name: "compact", description: "summarize older messages to free up context" },
  { name: "providers", description: "models and subscriptions, configured or not" },
  { name: "login", args: "<provider>", description: "sign in with a subscription (Claude, ChatGPT, Copilot…)" },
  { name: "key", args: "<provider> <api-key>", description: "save an API key for a provider", secret: true },
  { name: "connectors", description: "Slack, Discord, Telegram and webhook status" },
  { name: "usage", description: "tokens and cost across agents and models" },
  { name: "clear", description: "clear the screen (ctrl+l)" },
  { name: "help", description: "commands and keyboard shortcuts" },
  { name: "quit", description: "exit (ctrl+c twice)", aliases: ["exit", "q"] },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

/** Parse "/name args…" into its parts. */
export function parseCommand(text: string): { name: string; arg: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  return { name: match[1]!.toLowerCase(), arg: (match[2] ?? "").trim() };
}

/**
 * Slash-command autocomplete for the editor. Argument completions return the whole command line
 * as the value, so Enter on a highlighted argument runs the command straight away.
 */
export class SlashAutocomplete implements AutocompleteProvider {
  readonly commands: CommandSpec[];
  constructor(commands: CommandSpec[]) {
    this.commands = commands;
  }

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
    if (cursorLine !== 0) return null;
    const before = (lines[0] ?? "").slice(0, cursorCol);
    const text = before.trimStart();
    if (!text.startsWith("/")) return null;
    const space = text.indexOf(" ");
    // Tab (force) only completes arguments; the name menu opens on its own.
    if (space === -1 && options.force) return null;
    if (space === -1) {
      const query = text.slice(1);
      const matches = query ? fuzzyFilter(this.commands, query, (c) => c.name) : this.commands;
      if (matches.length === 0) return null;
      return {
        prefix: text,
        items: matches.map((c) => ({ value: c.name, label: c.name, description: c.args ? `${c.args}  ${c.description}` : c.description })),
      };
    }
    const name = text.slice(1, space);
    const command = this.commands.find((c) => c.name === name || c.aliases?.includes(name));
    if (!command?.complete) return null;
    const arg = text.slice(space + 1);
    // Only complete the first argument; /key's second argument is the secret.
    if (/\s/.test(arg.trimStart()) && command.name === "key") return null;
    const items = await command.complete(arg);
    if (options.signal.aborted || items.length === 0) return null;
    const head = text.slice(0, space + 1);
    return {
      prefix: text,
      items: items.map((item) => ({ ...item, value: `${head}${item.value}` })),
    };
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol - prefix.length);
    const after = line.slice(cursorCol);
    const isName = !prefix.includes(" ");
    const insert = isName ? `/${item.value} ` : item.value;
    const next = [...lines];
    next[cursorLine] = `${before}${insert}${after}`;
    return { lines: next, cursorLine, cursorCol: before.length + insert.length };
  }

  /** Tab completes command arguments ("/agent <tab>"); there is no file completion. */
  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return cursorLine === 0 && this.argumentCommand(lines[0] ?? "", cursorCol) !== undefined;
  }

  /** The command whose argument the cursor is in, if it has completions. */
  argumentCommand(line: string, cursorCol: number): CommandSpec | undefined {
    const match = /^\s*\/(\S+) /.exec(line.slice(0, cursorCol));
    if (!match) return undefined;
    const name = match[1]!.toLowerCase();
    const command = this.commands.find((c) => c.name === name || c.aliases?.includes(name));
    return command?.complete ? command : undefined;
  }
}
