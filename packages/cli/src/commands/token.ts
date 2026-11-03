import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRuntime, paths } from "../config.ts";
import { err, out, paint } from "../style.ts";

/** `soloagent token`: the local install's admin token, e.g. to sign in to its web GUI. */
export async function token(options: { data?: string }): Promise<number> {
  const p = paint(process.stderr);
  const dataDir = options.data ?? paths.data;
  const file = join(dataDir, "soloagent.sqlite");
  let value: string | undefined;
  if (existsSync(file)) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("admin_token") as { value?: string } | undefined;
      value = row?.value;
    } catch {
      value = undefined;
    } finally {
      db.close();
    }
  }
  if (!value && process.env.SOLOAGENT_TOKEN) value = process.env.SOLOAGENT_TOKEN;
  if (!value) {
    err(`${p.red("✗")} No local install found at ${dataDir}. Run ${p.bold("soloagent")} once to create one.`);
    return 1;
  }
  out(value);
  const runtime = loadRuntime();
  if (process.stderr.isTTY && runtime) err(p.dim(`↳ the local server is running at ${runtime.url}`));
  return 0;
}
