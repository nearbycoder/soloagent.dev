import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { createGunzip, createGzip } from "node:zlib";
import type { BackupManifest } from "@soloagent/client";
import { readTar, TarError, writeTar, type TarEntryInput } from "./tar.ts";

/**
 * Backups of a whole data directory: consistent snapshots of every top-level SQLite database
 * (`VACUUM INTO` from a separate connection, safe while the server runs), plus every other file and
 * directory (agent workspaces, uploaded files, anything a later version adds), in one `.tar.gz`.
 *
 * Archive layout: `manifest.json` first, then the database snapshots, then the rest of the data
 * directory, and `SHA256SUMS` last (verifiable with `sha256sum -c` after extracting).
 */

export const MANIFEST = "manifest.json";
export const CHECKSUMS = "SHA256SUMS";
export const BACKUPS_DIR = "backups";
/** Written by a running server so restores can refuse to run underneath it. */
export const SERVER_LOCK = ".server.json";

const DB_FILE = /\.(sqlite3?|db)$/;
const DB_SIDECAR = /\.(sqlite3?|db)-(wal|shm|journal)$/;
const TEMP_PREFIXES = [".backup-tmp-", ".restore-"];

export type SecretInfo = { source: "env" | "file"; fingerprint: string };

export type BackupOptions = {
  /** soloagent version written to the manifest. */
  version: string;
  /** Which secret sealed the credentials. Default: detected from SOLOAGENT_SECRET and `<dataDir>/.secret`. */
  secret?: SecretInfo & { value?: string };
  /** Put the secret in use in the archive as `.secret`. Anyone with the archive can then read every credential. */
  includeSecret?: boolean;
  log?: (message: string) => void;
};

/** Short, non-reversible fingerprint used to check a restore runs with the same secret. */
export function secretFingerprint(secret: string): string {
  return createHash("sha256").update(`soloagent-secret-fingerprint\0${secret}`).digest("hex").slice(0, 16);
}

/** The secret a data dir uses when nothing is passed in code: SOLOAGENT_SECRET, else `<dataDir>/.secret`. */
export function detectSecret(dataDir: string): (SecretInfo & { value?: string }) | undefined {
  const env = process.env.SOLOAGENT_SECRET;
  if (env) return { source: "env", fingerprint: secretFingerprint(env), value: env };
  const file = join(dataDir, ".secret");
  if (!existsSync(file)) return undefined;
  const value = readFileSync(file, "utf8").trim();
  return { source: "file", fingerprint: secretFingerprint(value), value };
}

/** `soloagent-backup-2026-11-03T12-00-00Z.tar.gz` */
export function backupFileName(at = new Date()): string {
  return `soloagent-backup-${at.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-")}.tar.gz`;
}

/** Stream a gzipped backup archive of `dataDir`. Destroying the stream cancels the backup and cleans up. */
export function createBackup(dataDir: string, options: BackupOptions): Readable {
  const gzip = createGzip();
  pipeline(Readable.from(writeTar(backupEntries(resolve(dataDir), options))), gzip).catch((error: unknown) => {
    if (!gzip.destroyed) gzip.destroy(error as Error);
  });
  return gzip;
}

/** Write a backup to a file atomically (via `<file>.partial`). */
export async function writeBackupFile(dataDir: string, file: string, options: BackupOptions): Promise<void> {
  const partial = `${file}.partial`;
  await mkdir(dirname(resolve(file)), { recursive: true });
  try {
    await pipeline(createBackup(dataDir, options), createWriteStream(partial, { mode: 0o600 }));
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function* backupEntries(dataDir: string, options: BackupOptions): AsyncGenerator<TarEntryInput> {
  const log = options.log ?? (() => {});
  const secret = options.secret ?? detectSecret(dataDir);
  const sums: string[] = [];
  const temp = join(dataDir, `.backup-tmp-${randomBytes(6).toString("hex")}`);
  await mkdir(temp, { recursive: true });
  try {
    // soloagent.sqlite first: threads point at Pi Durable conversations, so taking the durable
    // snapshot second can only add an orphan conversation, never lose one a thread refers to.
    const names = (await readdir(dataDir)).filter((n) => DB_FILE.test(n)).sort((a, b) => (a === "soloagent.sqlite" ? -1 : b === "soloagent.sqlite" ? 1 : a.localeCompare(b)));
    const databases: string[] = [];
    for (const name of names) {
      const info = await stat(join(dataDir, name)).catch(() => undefined);
      if (!info?.isFile() || !(await isSqlite(join(dataDir, name)))) continue;
      snapshotDatabase(join(dataDir, name), join(temp, name));
      databases.push(name);
    }

    const manifest: BackupManifest = {
      format: "soloagent-backup",
      formatVersion: 1,
      version: options.version,
      createdAt: Date.now(),
      hostname: hostname(),
      secret: secret?.source ?? "file",
      secretFingerprint: secret?.fingerprint ?? "",
      includesSecret: Boolean(options.includeSecret && secret?.value),
      databases,
    };
    yield fileEntry(MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), sums);

    for (const name of databases) {
      const path = join(temp, name);
      const info = await stat(path);
      yield hashedFile(name, path, info, sums);
      await unlink(path).catch(() => {});
    }

    if (manifest.includesSecret) yield { ...fileEntry(".secret", Buffer.from(secret!.value!), sums), mode: 0o600 };

    yield* walk(dataDir, "", sums, log, new Set(databases));
    yield fileEntry(CHECKSUMS, Buffer.from(sums.join("")), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** A consistent copy of a live WAL database, taken through its own connection. */
function snapshotDatabase(source: string, target: string) {
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA busy_timeout = 15000");
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}

async function isSqlite(path: string): Promise<boolean> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    return header.toString("latin1") === "SQLite format 3\0";
  } finally {
    await handle.close();
  }
}

/** Top-level names that are never copied as plain files: snapshotted databases, their WAL files, and our own state. */
function skipTopLevel(name: string, databases: Set<string>): boolean {
  return (
    name === BACKUPS_DIR ||
    name === ".secret" ||
    name === SERVER_LOCK ||
    databases.has(name) ||
    DB_SIDECAR.test(name) ||
    TEMP_PREFIXES.some((p) => name.startsWith(p))
  );
}

async function* walk(root: string, rel: string, sums: string[], log: (message: string) => void, databases: Set<string>): AsyncGenerator<TarEntryInput> {
  let names: string[];
  try {
    names = (await readdir(join(root, rel))).sort();
  } catch (error) {
    log(`backup: skipped ${rel || "."}: ${(error as Error).message}`);
    return;
  }
  for (const name of names) {
    if (!rel && skipTopLevel(name, databases)) continue;
    const relPath = rel ? `${rel}/${name}` : name;
    const full = join(root, rel, name);
    let info: Stats;
    try {
      info = await lstat(full);
    } catch {
      continue; // vanished while walking
    }
    if (info.isSymbolicLink()) {
      const linkname = await readlink(full).catch(() => undefined);
      if (linkname !== undefined) yield { type: "symlink", name: relPath, linkname, mtime: info.mtimeMs };
    } else if (info.isDirectory()) {
      yield { type: "directory", name: relPath, mode: info.mode, mtime: info.mtimeMs };
      yield* walk(root, relPath, sums, log, databases);
    } else if (info.isFile()) {
      yield hashedFile(relPath, full, info, sums);
    }
  }
}

function fileEntry(name: string, body: Buffer, sums: string[]): TarEntryInput {
  sums.push(`${createHash("sha256").update(body).digest("hex")}  ${name}\n`);
  return { type: "file", name, size: body.length, body, mode: 0o644 };
}

/** A file streamed from disk, hashed as it goes into the archive (exactly `size` bytes). */
function hashedFile(name: string, path: string, info: Stats, sums: string[]): TarEntryInput {
  const size = info.size;
  async function* body() {
    const hash = createHash("sha256");
    let written = 0;
    try {
      for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
        const part = chunk.length > size - written ? chunk.subarray(0, size - written) : chunk;
        hash.update(part);
        written += part.length;
        yield part;
        if (written >= size) break;
      }
    } catch {
      // unreadable or vanished mid-read: zero-filled below, still listed with its real hash
    }
    for (let missing = size - written; missing > 0; ) {
      const n = Math.min(missing, 64 * 1024);
      const zeros = Buffer.alloc(n);
      hash.update(zeros);
      missing -= n;
      yield zeros;
    }
    sums.push(`${hash.digest("hex")}  ${name}\n`);
  }
  return { type: "file", name, size, mode: info.mode, mtime: info.mtimeMs, body: body() };
}

// ───────────────────────────── restore ─────────────────────────────

export type RestoreOptions = {
  /** Replace a data dir that already has data. `backups/` is kept, and `.secret` when the archive has none. */
  force?: boolean;
  log?: (message: string) => void;
};

export type RestoreResult = { manifest: BackupManifest; files: number; warnings: string[] };

/** Is there anything in `dataDir` besides scheduled backups? */
export async function hasData(dataDir: string): Promise<boolean> {
  const names = await readdir(dataDir).catch(() => [] as string[]);
  return names.some((n) => n !== BACKUPS_DIR);
}

/**
 * Restore an archive into `dataDir`. Everything is extracted to a staging directory and verified
 * (manifest, tar checksums, gzip CRC, SHA256SUMS, `PRAGMA integrity_check`) before the data dir is touched.
 * The server must not be running on `dataDir`; the CLI checks that before calling this.
 */
export async function restoreBackup(archive: string | AsyncIterable<Buffer>, dataDir: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const target = resolve(dataDir);
  if ((await hasData(target)) && !options.force) throw new Error(`${target} already has data. Use --force to replace it.`);
  await mkdir(target, { recursive: true });
  const staging = join(target, `.restore-${randomBytes(6).toString("hex")}`);
  await mkdir(staging);
  try {
    const { manifest, files } = await extractVerified(archive, staging);
    const warnings = secretWarnings(manifest, target, staging);

    // Swap: clear the old data (keeping scheduled backups, and the old .secret if the archive has none),
    // then move the verified files into place.
    for (const name of await readdir(target)) {
      if (join(target, name) === staging || name === BACKUPS_DIR) continue;
      if (name === ".secret" && !manifest.includesSecret) continue;
      await rm(join(target, name), { recursive: true, force: true });
    }
    for (const name of await readdir(staging)) {
      if (name === MANIFEST || name === CHECKSUMS) continue;
      if (name === BACKUPS_DIR && existsSync(join(target, BACKUPS_DIR))) continue;
      await rename(join(staging, name), join(target, name));
    }
    return { manifest, files, warnings };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Read and fully verify an archive into `dir` without touching anything else. */
export async function extractVerified(archive: string | AsyncIterable<Buffer>, dir: string): Promise<{ manifest: BackupManifest; files: number }> {
  const source = typeof archive === "string" ? createReadStream(archive) : Readable.from(archive);
  const gunzip = createGunzip();
  const piping = pipeline(source, gunzip).catch(() => {
    // surfaces through the tar reader
  });

  const hashes = new Map<string, string>();
  const links: { path: string; linkname: string }[] = [];
  const kept = new Map<string, string>();
  try {
    for await (const entry of readTar(gunzip)) {
      const rel = safeRelative(entry.name);
      const path = join(dir, ...rel.split("/"));
      if (entry.type === "directory") {
        await mkdir(path, { recursive: true });
      } else if (entry.type === "symlink") {
        links.push({ path, linkname: entry.linkname });
      } else if (entry.type === "file") {
        await mkdir(dirname(path), { recursive: true });
        const hash = createHash("sha256");
        const keep = rel === MANIFEST || rel === CHECKSUMS;
        const chunks: Buffer[] = [];
        await pipeline(
          (async function* () {
            for await (const chunk of entry.body) {
              hash.update(chunk);
              if (keep) chunks.push(chunk);
              yield chunk;
            }
          })(),
          createWriteStream(path, { mode: entry.mode & 0o777 || 0o644 }),
        );
        hashes.set(rel, hash.digest("hex"));
        if (keep) kept.set(rel, Buffer.concat(chunks).toString("utf8"));
      }
    }
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    if (error instanceof TarError) throw error;
    const message = (error as Error).message;
    throw new Error(/incorrect|unexpected end|header check|invalid/i.test(message) ? `Corrupt archive: ${message}` : message);
  }
  await piping;

  const manifestText = kept.get(MANIFEST);
  if (!manifestText) throw new Error("Not a soloagent backup: manifest.json is missing");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestText) as BackupManifest;
  } catch {
    throw new Error("Not a soloagent backup: manifest.json is not valid JSON");
  }
  if (manifest.format !== "soloagent-backup") throw new Error("Not a soloagent backup: unknown manifest format");
  if (manifest.formatVersion > 1) throw new Error(`This backup was made by a newer soloagent (${manifest.version}); upgrade before restoring it`);

  const checksums = kept.get(CHECKSUMS);
  if (checksums === undefined) throw new Error("Corrupt archive: SHA256SUMS is missing (was the backup cut short?)");
  const listed = new Map<string, string>();
  for (const line of checksums.split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match) listed.set(match[2]!, match[1]!);
  }
  for (const [name, expected] of listed) {
    const actual = hashes.get(name);
    if (!actual) throw new Error(`Corrupt archive: ${name} is missing`);
    if (actual !== expected) throw new Error(`Corrupt archive: checksum mismatch for ${name}`);
  }
  for (const name of hashes.keys()) {
    if (name !== CHECKSUMS && !listed.has(name)) throw new Error(`Corrupt archive: ${name} is not in SHA256SUMS`);
  }

  for (const name of manifest.databases ?? []) {
    const path = join(dir, name);
    if (!existsSync(path)) throw new Error(`Corrupt archive: database ${name} is missing`);
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
      if (rows[0]?.integrity_check !== "ok") throw new Error(`Database ${name} failed its integrity check: ${rows.map((r) => r.integrity_check).join("; ")}`);
    } finally {
      db.close();
    }
  }

  // Symlinks last, so no file above could have been written through one.
  for (const link of links) {
    await mkdir(dirname(link.path), { recursive: true });
    await symlink(link.linkname, link.path).catch(() => {});
  }
  return { manifest, files: hashes.size - 2 };
}

function safeRelative(name: string): string {
  const normalized = posix.normalize(name.replace(/\\/g, "/")).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("\0") || /^[a-zA-Z]:/.test(normalized))
    throw new TarError(`Unsafe path in archive: ${name}`);
  return normalized;
}

function secretWarnings(manifest: BackupManifest, target: string, staging: string): string[] {
  const warnings: string[] = [];
  if (manifest.includesSecret) {
    warnings.push("The backup included the credentials secret (.secret); it has been restored.");
    return warnings;
  }
  const env = process.env.SOLOAGENT_SECRET;
  const existingFile = existsSync(join(target, ".secret")) && !existsSync(join(staging, ".secret")) ? readFileSync(join(target, ".secret"), "utf8").trim() : undefined;
  const current = env ?? existingFile;
  if (manifest.secret === "env") {
    if (!env) warnings.push("This backup's credentials were sealed with SOLOAGENT_SECRET. Start the server with the same SOLOAGENT_SECRET, or provider logins and connector tokens will not open.");
    else if (manifest.secretFingerprint && secretFingerprint(env) !== manifest.secretFingerprint)
      warnings.push("SOLOAGENT_SECRET differs from the one this backup was made with. Provider logins and connector tokens will not open until you use the original value.");
  } else if (!current) {
    warnings.push("This backup does not include .secret. Copy the original data dir's .secret file into place (or set SOLOAGENT_SECRET to its contents) before starting, or provider logins and connector tokens will not open.");
  } else if (manifest.secretFingerprint && secretFingerprint(current) !== manifest.secretFingerprint) {
    warnings.push("The secret in use differs from the one this backup was made with. Provider logins and connector tokens will not open until you restore the original .secret or SOLOAGENT_SECRET.");
  }
  return warnings;
}


// ───────────────────────────── scheduled backups ─────────────────────────────

/** "24h", "6h", "30m", "1d", "1w", "90s" → milliseconds. Undefined when unparseable or zero. */
export function parseDuration(input: string | undefined): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?\s*$/i.exec(input ?? "");
  if (!match) return undefined;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[(match[2] ?? "h").toLowerCase() as "s"];
  const ms = Number(match[1]) * unit;
  return ms > 0 ? ms : undefined;
}

const SCHEDULED = /^soloagent-backup-.*\.tar\.gz$/;

/** Delete all but the newest `keep` archives in `dir`. Returns the deleted file names. */
export async function pruneBackups(dir: string, keep: number): Promise<string[]> {
  const files = await listBackups(dir);
  const doomed = files.slice(Math.max(0, keep));
  for (const file of doomed) await rm(join(dir, file.name), { force: true });
  return doomed.map((f) => f.name);
}

/** Scheduled archives in `dir`, newest first. */
export async function listBackups(dir: string): Promise<{ name: string; mtimeMs: number; size: number }[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => SCHEDULED.test(n));
  const files = await Promise.all(names.map(async (name) => ({ name, ...(await stat(join(dir, name)).then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }))) })));
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

export type ScheduleOptions = BackupOptions & {
  intervalMs: number;
  keep: number;
  /** Delay before the first backup when none is due yet. Default 30s, to stay out of startup's way. */
  initialDelayMs?: number;
};

/**
 * Write `<dataDir>/backups/soloagent-backup-*.tar.gz` every `intervalMs`, keeping the newest `keep`.
 * The first one runs when the newest existing archive is older than the interval. Returns stop().
 */
export function scheduleBackups(dataDir: string, options: ScheduleOptions): () => void {
  const log = options.log ?? (() => {});
  const dir = join(dataDir, BACKUPS_DIR);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const MAX_TIMER = 2 ** 31 - 1;

  const arm = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => void run(), Math.min(MAX_TIMER, Math.max(0, delay)));
    timer.unref?.();
  };
  const run = async () => {
    const newest = (await listBackups(dir))[0];
    const due = newest ? newest.mtimeMs + options.intervalMs - Date.now() : 0;
    // Long intervals overflow setTimeout; re-check rather than firing early.
    if (due > 60_000) return arm(due);
    const file = join(dir, backupFileName());
    try {
      await writeBackupFile(dataDir, file, { ...options, includeSecret: false });
      const removed = await pruneBackups(dir, options.keep);
      log(`backup: wrote ${file}${removed.length ? ` (pruned ${removed.length})` : ""}`);
    } catch (error) {
      log(`backup failed: ${(error as Error).message}`);
    }
    arm(options.intervalMs);
  };

  void listBackups(dir).then((files) => {
    const newest = files[0];
    const due = newest ? newest.mtimeMs + options.intervalMs - Date.now() : 0;
    arm(Math.max(due, options.initialDelayMs ?? 30_000));
  });
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
