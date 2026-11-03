import { fstatSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename } from "node:path";
import type { Agent, AttachmentUpload } from "@soloagent/client";
import type { Connection } from "../connect.ts";
import { err, out, paint } from "../style.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** True when stdin is a pipe or a redirected file, not a terminal or an inherited empty handle. */
function stdinPiped(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isFile();
  } catch {
    return false;
  }
}

export function findAgent(agents: Agent[], ref: string): Agent | undefined {
  const needle = ref.replace(/^@/, "").toLowerCase();
  return agents.find((a) => a.id === ref || a.handle === needle) ?? agents.find((a) => a.name.toLowerCase() === needle);
}

/** Read local files for upload. The server works out the type from the extension. */
export function readAttachments(paths: string[]): AttachmentUpload[] {
  if (paths.length > 10) throw new Error("At most 10 files per message");
  return paths.map((path) => {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new Error(`Cannot read ${path}`);
    }
    if (size > 20 * 1024 * 1024) throw new Error(`${path} is larger than the 20 MB limit`);
    return { name: basename(path), data_base64: readFileSync(path).toString("base64") };
  });
}

export function authorName(): string {
  try {
    return userInfo().username || "You";
  } catch {
    return "You";
  }
}

/** `soloagent ask "<message>"`: print mode for scripts and pipes. Returns the exit code. */
export async function ask(
  connection: Connection,
  message: string | undefined,
  options: { agent?: string; thread?: string; json?: boolean; files?: string[] },
): Promise<number> {
  const p = paint(process.stderr);
  const { client } = connection;
  let text = message;
  if (text === "-" || (text === undefined && !process.stdin.isTTY)) text = await readStdin();
  else if (text !== undefined && stdinPiped()) {
    // `git diff | soloagent ask "Write a commit message"`: the piped text follows the message.
    const piped = (await readStdin()).trim();
    if (piped) text = `${text}\n\n${piped}`;
  }
  const attachments = readAttachments(options.files ?? []);
  if (!text?.trim() && attachments.length === 0) throw new Error('Nothing to ask. Usage: soloagent ask "<message>" (or pipe text with -)');

  let threadId = options.thread;
  let agentId: string | undefined;
  if (options.agent) {
    const agent = findAgent(await client.agents(), options.agent);
    if (!agent) throw new Error(`No agent @${options.agent.replace(/^@/, "")}. Run soloagent agents to list them.`);
    agentId = agent.id;
  }
  if (threadId) {
    if (agentId) await client.updateThread(threadId, { agentId });
  } else {
    threadId = (await client.createThread({ agentId, source: "api" })).id;
  }

  const result = await client.ask(threadId, text ?? "", { source: "api", author: authorName(), ...(attachments.length ? { attachments } : {}) });
  if (options.json) {
    out(JSON.stringify({ threadId, ...result }));
    return result.status === "done" ? 0 : 1;
  }
  if (result.status !== "done") {
    err(`${p.red("✗")} No answer${result.reason ? `: ${result.reason}` : ""}`);
    return 1;
  }
  out((result.answer ?? "").trimEnd());
  if (process.stderr.isTTY) err(p.dim(`\n↳ thread ${threadId} · continue with --thread ${threadId}`));
  return 0;
}
