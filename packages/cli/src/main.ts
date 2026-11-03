#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { SoloApiError } from "@soloagent/client";
import { parseArgs, str, strs, UsageError, type FlagSpec, type Parsed } from "./args.ts";
import type { Connection } from "./connect.ts";
import { err, out, paint } from "./style.ts";

const VERSION = (() => {
  // ../package.json from source, ./package.json beside the published bundle.
  for (const path of ["../package.json", "./package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (pkg.version && pkg.name?.includes("soloagent")) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "0.0.0";
})();

const GLOBAL: FlagSpec = { help: "boolean", version: "boolean", url: "string", token: "string" };

const COMMANDS: Record<string, FlagSpec> = {
  tui: { agent: "string", thread: "string", new: "boolean" },
  serve: { port: "string", data: "string", host: "string" },
  connect: {},
  disconnect: {},
  ask: { agent: "string", thread: "string", json: "boolean", file: "strings" },
  agents: { json: "boolean" },
  threads: { json: "boolean", limit: "string", agent: "string" },
  login: { key: "boolean" },
  token: { data: "string" },
  help: {},
};

function help() {
  const p = paint();
  const cmd = (usage: string, text: string, options?: string) => {
    const pad = " ".repeat(Math.max(2, 30 - usage.length));
    return `    ${p.bold(usage)}${pad}${text}${options ? `\n    ${" ".repeat(30)}${p.dim(options)}` : ""}`;
  };
  out(`
  ${p.accent("✦")} ${p.bold("soloagent")} ${p.dim(VERSION)} — one control plane for all of your AI agents

  ${p.dim("USAGE")}
${cmd("soloagent", "open the terminal UI", "--agent <handle>  --thread <id>  --new")}
${cmd('soloagent ask "<message>"', "ask once, print the answer", '--agent <handle>  --thread <id>  --json  --file <path> (repeatable)   (piped input is appended; "-" reads only stdin)')}
${cmd("soloagent agents", "list agents", "--json")}
${cmd("soloagent threads", "list recent threads", "--limit <n>  --agent <handle>  --json")}
${cmd("soloagent login [provider]", "sign in with a subscription", "--key  save an API key instead")}
${cmd("soloagent serve", "run the server in the foreground", "--port <7420>  --data <dir>  --host <addr>")}
${cmd("soloagent connect <url>", "use a remote server from now on", "--token <token>")}
${cmd("soloagent disconnect", "forget the remote, run locally again")}
${cmd("soloagent token", "print the local admin token (web GUI login)")}

  ${p.dim("CONNECTION")}
    --url/--token, then SOLOAGENT_URL/SOLOAGENT_TOKEN, then ~/.soloagent/config.json.
    With none of them, soloagent runs a private server in-process with ~/.soloagent/data.

  ${p.dim("EXAMPLES")}
    soloagent ask "summarize today's deploys" --agent ops
    git diff | soloagent ask - --agent reviewer --json
    soloagent ask "what's wrong in this screenshot?" --file ./screenshot.png
    soloagent login anthropic
`);
}

async function connection(flags: Parsed["flags"]): Promise<Connection> {
  const { resolveConnection } = await import("./connect.ts");
  return resolveConnection({ url: str(flags.url), token: str(flags.token) });
}

/** Run a command with a connection that is always closed afterwards. */
async function withConnection(flags: Parsed["flags"], run: (c: Connection) => Promise<number | void>): Promise<number> {
  const conn = await connection(flags);
  try {
    return (await run(conn)) ?? 0;
  } finally {
    await conn.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  const name = first && !first.startsWith("-") && first in COMMANDS ? first : first && !first.startsWith("-") ? undefined : "tui";
  if (!name) throw new UsageError(`Unknown command "${first}". Run soloagent --help.`);
  const rest = name === "tui" && first !== "tui" ? argv : argv.slice(1);
  const { positionals, flags } = parseArgs(rest, { ...GLOBAL, ...COMMANDS[name] });

  if (flags.version) {
    out(VERSION);
    return 0;
  }
  if (flags.help || name === "help") {
    help();
    return 0;
  }

  switch (name) {
    case "tui": {
      if (positionals.length) throw new UsageError(`Unexpected argument "${positionals[0]}". Did you mean soloagent ask "${positionals.join(" ")}"?`);
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError("The terminal UI needs an interactive terminal. Use soloagent ask for scripts.");
      const { resolveConnection } = await import("./connect.ts");
      const conn = await resolveConnection({
        url: str(flags.url),
        token: str(flags.token),
        onEmbeddedStart: () => process.stderr.write(`${paint(process.stderr).accent("✦")} starting soloagent…\r`),
      });
      const { runTui } = await import("./tui/app.ts");
      return runTui(conn, { agent: str(flags.agent), thread: str(flags.thread), fresh: flags.new === true, version: VERSION });
    }
    case "serve": {
      const { serve } = await import("./commands/serve.ts");
      await serve({ port: str(flags.port), data: str(flags.data), host: str(flags.host) });
      return 0;
    }
    case "connect": {
      const { connect } = await import("./commands/remote.ts");
      await connect(positionals[0] ?? str(flags.url), str(flags.token));
      return 0;
    }
    case "disconnect": {
      const { disconnect } = await import("./commands/remote.ts");
      await disconnect();
      return 0;
    }
    case "ask": {
      const { ask } = await import("./commands/ask.ts");
      const message = positionals.length > 1 ? positionals.join(" ") : positionals[0];
      return withConnection(flags, (c) => ask(c, message, { agent: str(flags.agent), thread: str(flags.thread), json: flags.json === true, files: strs(flags.file) }));
    }
    case "agents": {
      const { agents } = await import("./commands/list.ts");
      return withConnection(flags, (c) => agents(c, { json: flags.json === true }));
    }
    case "threads": {
      const { threads } = await import("./commands/list.ts");
      return withConnection(flags, (c) => threads(c, { json: flags.json === true, limit: str(flags.limit), agent: str(flags.agent) }));
    }
    case "login": {
      const { login } = await import("./commands/login.ts");
      return withConnection(flags, (c) => login(c, positionals[0], { key: flags.key === true }));
    }
    case "token": {
      const { token } = await import("./commands/token.ts");
      return token({ data: str(flags.data) });
    }
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    // Embedded servers and sockets can keep the loop alive; the command is done.
    process.exit(code);
  },
  (error: unknown) => {
    const p = paint(process.stderr);
    if (error instanceof UsageError) err(`${p.red("✗")} ${error.message}`);
    else if (error instanceof SoloApiError) err(`${p.red("✗")} ${error.message}${error.status === 401 ? p.dim(" — check --token, SOLOAGENT_TOKEN, or run soloagent connect") : ""}`);
    else if (error instanceof Error && /fetch failed|ECONNREFUSED/.test(`${error.message} ${String((error as { cause?: unknown }).cause)}`))
      err(`${p.red("✗")} Could not reach the soloagent server. ${p.dim("Is it running? Check --url or run soloagent disconnect to go local.")}`);
    else err(`${p.red("✗")} ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  },
);
