import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { compareSemver, SoloClient } from "@soloagent/client";
import { UsageError } from "../args.ts";
import { loadConfig, loadRuntime, paths } from "../config.ts";
import { err, paint } from "../style.ts";

type Target = { kind: "remote"; client: SoloClient; label: string } | { kind: "local"; dataDir: string };

/**
 * Where to back up from: --data (a data dir on this machine), then --url / SOLOAGENT_URL / the saved
 * remote, then a local server another soloagent process runs, then ~/.soloagent/data directly.
 * Never starts a server.
 */
async function backupSource(options: { url?: string; token?: string; data?: string }): Promise<Target> {
  if (options.data) return { kind: "local", dataDir: resolve(options.data) };
  const config = loadConfig();
  const url = options.url ?? (process.env.SOLOAGENT_URL || undefined) ?? config.url;
  if (url) {
    const token = options.token ?? (process.env.SOLOAGENT_TOKEN || undefined) ?? (config.url?.replace(/\/+$/, "") === url.replace(/\/+$/, "") ? config.token : undefined);
    return { kind: "remote", client: new SoloClient({ baseUrl: url, token }), label: url };
  }
  const runtime = loadRuntime();
  if (runtime && (await alive(runtime.url))) return { kind: "remote", client: new SoloClient({ baseUrl: runtime.url, token: runtime.token }), label: "the local server" };
  return { kind: "local", dataDir: resolve(process.env.SOLOAGENT_DATA_DIR || paths.data) };
}

async function alive(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** `soloagent backup [--out file|-] [--include-secret] [--data dir]` */
export async function backup(options: { url?: string; token?: string; out?: string; includeSecret?: boolean; data?: string }): Promise<number> {
  const p = paint(process.stderr);
  const { backupFileName, createBackup, VERSION } = await import("@soloagent/core");
  const target = options.out ?? backupFileName();
  const toStdout = target === "-";
  if (toStdout && process.stdout.isTTY) throw new UsageError("Refusing to write a binary archive to the terminal. Pipe it (--out - | aws s3 cp - s3://…) or use --out <file>.");

  if (options.includeSecret) {
    err(`${p.yellow("!")} ${p.bold("--include-secret")}: this archive will contain the key that unseals every provider login and bot token.`);
    err(p.dim("  Anyone with the file can read them. Store it like a password."));
  }

  const source = await backupSource(options);
  let archive: Readable;
  let from: string;
  if (source.kind === "remote") {
    const response = await source.client.backup({ includeSecret: options.includeSecret });
    if (!response.body) throw new Error("The server sent an empty backup");
    archive = Readable.fromWeb(response.body as never);
    from = source.label;
  } else {
    if (!existsSync(join(source.dataDir, "soloagent.sqlite"))) throw new UsageError(`No soloagent data in ${source.dataDir}. Use --data <dir>, or --url for a remote server.`);
    archive = createBackup(source.dataDir, { version: VERSION, includeSecret: options.includeSecret });
    from = source.dataDir;
  }

  if (toStdout) {
    await pipeline(archive, process.stdout);
    err(`${p.green("✓")} Backup of ${from} written to stdout`);
    return 0;
  }
  const file = resolve(target);
  const partial = `${file}.partial`;
  try {
    await pipeline(archive, createWriteStream(partial, { mode: 0o600 }));
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  err(`${p.green("✓")} Backup of ${from} written to ${p.bold(target)} ${p.dim(`(${size(statSync(file).size)})`)}`);
  if (!options.includeSecret) err(p.dim("  Credentials stay sealed; a restore needs the same SOLOAGENT_SECRET or .secret file."));
  return 0;
}

/** `soloagent restore <file|-> [--data dir] [--force]` */
export async function restore(file: string | undefined, options: { data?: string; force?: boolean }): Promise<number> {
  const p = paint(process.stderr);
  if (!file) throw new UsageError("Usage: soloagent restore <backup.tar.gz> [--data <dir>] [--force]  (\"-\" reads stdin)");
  if (file !== "-" && !existsSync(file)) throw new UsageError(`No such file: ${file}`);
  const dataDir = resolve(options.data ?? (process.env.SOLOAGENT_DATA_DIR || paths.data));
  const { restoreBackup, SERVER_LOCK, VERSION } = await import("@soloagent/core");

  const running = await runningServer(dataDir, SERVER_LOCK);
  if (running) throw new UsageError(`A soloagent server is using ${dataDir} (${running}). Stop it before restoring.`);

  const result = await restoreBackup(file === "-" ? process.stdin : file, dataDir, { force: options.force });
  const { manifest } = result;
  err(`${p.green("✓")} Restored ${result.files} files into ${p.bold(dataDir)}`);
  err(p.dim(`  backup of soloagent ${manifest.version} on ${manifest.hostname}, ${new Date(manifest.createdAt).toLocaleString()}`));
  if (compareSemver(manifest.version, VERSION) > 0) err(`${p.yellow("!")} The backup is from a newer soloagent (${manifest.version}) than this one (${VERSION}). Upgrade before starting the server.`);
  for (const warning of result.warnings) err(`${p.yellow("!")} ${warning}`);
  return 0;
}

/** A description of the server using `dataDir`, if one is running. */
async function runningServer(dataDir: string, lockName: string): Promise<string | undefined> {
  const runtime = loadRuntime();
  if (runtime && resolve(runtime.dataDir) === dataDir && (await alive(runtime.url))) return `pid ${runtime.pid}, ${runtime.url}`;
  const lockFile = join(dataDir, lockName);
  if (!existsSync(lockFile)) return undefined;
  let lock: { pid?: number; port?: number; url?: string } = {};
  try {
    lock = JSON.parse(readFileSync(lockFile, "utf8")) as typeof lock;
  } catch {
    return undefined;
  }
  const url = lock.port ? `http://127.0.0.1:${lock.port}` : lock.url;
  if (url && (await alive(url))) return `pid ${lock.pid ?? "?"}, port ${lock.port ?? "?"}`;
  if (lock.pid && pidAlive(lock.pid)) return `pid ${lock.pid}; if that is not soloagent, delete ${lockFile}`;
  return undefined;
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
