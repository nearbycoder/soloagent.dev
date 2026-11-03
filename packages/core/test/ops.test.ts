import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { compareSemver, parseSemver, type AgentExport } from "@soloagent/client";
import {
  SoloAgent,
  TarError,
  UpdateChecker,
  exportAgents,
  importAgents,
  parseDuration,
  pruneBackups,
  readTar,
  restoreBackup,
  writeBackupFile,
  writeTar,
  type TarEntryInput,
} from "../src/index.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "solo-ops-"));

async function collect(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

/** Re-chunk a buffer into awkward pieces so the reader's buffering is exercised. */
async function* rechunk(buffer: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buffer.length; i += size) yield buffer.subarray(i, i + size);
}

async function open(dir: string, faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false }] })) {
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "t", connectors: false, demo: false, providers: [faux.provider], log: () => {} });
  const agent = solo.agents.list()[0]!;
  solo.agents.update(agent.id, { model: { provider: "faux", modelId: "faux-1" } });
  return { solo, faux, agentId: agent.id };
}

// ───────────────────────────── tar ─────────────────────────────

test("tar round-trips files, directories, symlinks, and long unicode names", async () => {
  const longDir = `${"deep/".repeat(30)}nested`;
  const longName = `${"ü".repeat(120)}.txt`;
  const big = Buffer.alloc(70_001, 7);
  const entries: TarEntryInput[] = [
    { type: "directory", name: "workspaces" },
    { type: "file", name: "workspaces/hello.txt", size: 5, body: Buffer.from("hello"), mode: 0o640, mtime: 1_700_000_000_000 },
    { type: "file", name: "empty", size: 0, body: Buffer.alloc(0) },
    { type: "file", name: `${longDir}/${longName}`, size: big.length, body: rechunk(big, 4096) },
    { type: "symlink", name: "link", linkname: `../${"x".repeat(150)}` },
  ];
  const archive = await collect(writeTar(entries));
  assert.equal(archive.length % 512, 0);

  const seen: { type: string; name: string; data?: Buffer; linkname?: string; mode: number; mtime: number }[] = [];
  for await (const entry of readTar(rechunk(archive, 333))) {
    seen.push({ type: entry.type, name: entry.name, mode: entry.mode, mtime: entry.mtime, linkname: entry.linkname, data: entry.type === "file" ? await collect(entry.body) : undefined });
  }
  assert.deepEqual(
    seen.map((e) => [e.type, e.name]),
    [
      ["directory", "workspaces"],
      ["file", "workspaces/hello.txt"],
      ["file", "empty"],
      ["file", `${longDir}/${longName}`],
      ["symlink", "link"],
    ],
  );
  assert.equal(seen[1]!.data!.toString(), "hello");
  assert.equal(seen[1]!.mode, 0o640);
  assert.equal(seen[1]!.mtime, 1_700_000_000);
  assert.equal(seen[2]!.data!.length, 0);
  assert.ok(seen[3]!.data!.equals(big));
  assert.equal(seen[4]!.linkname, `../${"x".repeat(150)}`);
});

test("tar reader skips unread bodies and rejects corruption", async () => {
  const archive = await collect(
    writeTar([
      { type: "file", name: "a", size: 1000, body: Buffer.alloc(1000, 1) },
      { type: "file", name: "b", size: 3, body: Buffer.from("abc") },
    ]),
  );
  const names: string[] = [];
  let b = "";
  for await (const entry of readTar(rechunk(archive, 100))) {
    names.push(entry.name);
    if (entry.name === "b") b = (await collect(entry.body)).toString();
  }
  assert.deepEqual(names, ["a", "b"]);
  assert.equal(b, "abc");

  const corrupt = Buffer.from(archive);
  corrupt[10] = corrupt[10]! ^ 0xff; // inside the first header's name
  await assert.rejects(async () => {
    for await (const _ of readTar(rechunk(corrupt, 512))) {
      // drain
    }
  }, TarError);
  await assert.rejects(async () => {
    for await (const entry of readTar(rechunk(archive.subarray(0, 900), 512))) await collect(entry.body);
  }, /unexpected end/);
});

test("a file that changes size while archived keeps the archive well-formed", async () => {
  const archive = await collect(writeTar([{ type: "file", name: "grew", size: 4, body: Buffer.from("123456") }, { type: "file", name: "shrank", size: 6, body: Buffer.from("12") }]));
  const out: Record<string, string> = {};
  for await (const entry of readTar(rechunk(archive, 512))) out[entry.name] = (await collect(entry.body)).toString("latin1");
  assert.deepEqual(out, { grew: "1234", shrank: "12\0\0\0\0" });
});

// ───────────────────────────── backup & restore ─────────────────────────────

test("backup then restore into a fresh dir brings back agents, threads, messages, and workspaces", async () => {
  const source = scratch();
  const target = scratch();
  const archive = join(scratch(), "backup.tar.gz");
  try {
    const { solo, faux } = await open(source);
    solo.createAgent({ name: "Coder", handle: "coder", model: { provider: "faux", modelId: "faux-1" } });
    faux.setResponses([fauxAssistantMessage([fauxText("Backed up answer")])]);
    const thread = await solo.createThread({ source: "web", title: "keep me" });
    await (await solo.send(thread.id, { text: "please remember", author: { name: "ann", source: "web" } })).wait();
    mkdirSync(join(source, "workspaces", "coder"), { recursive: true });
    writeFileSync(join(source, "workspaces", "coder", "notes.md"), "# notes\n");
    mkdirSync(join(source, "files"), { recursive: true });
    writeFileSync(join(source, "files", "upload.bin"), Buffer.alloc(2048, 3));
    mkdirSync(join(source, "backups"));
    writeFileSync(join(source, "backups", "old.tar.gz"), "not included");
    writeFileSync(join(source, "plain.db"), "not a database, copied as a file");

    await pipeline(solo.backup(), createWriteStream(archive));
    await solo.close();

    // Inspect the archive: manifest first, checksums last, no secret, no backups/, no WAL files.
    const names: string[] = [];
    let manifest: Record<string, unknown> = {};
    for await (const entry of readTar(createReadStream(archive).pipe(createGunzip()))) {
      names.push(entry.name);
      if (entry.name === "manifest.json") manifest = JSON.parse((await collect(entry.body)).toString());
    }
    assert.equal(names[0], "manifest.json");
    assert.equal(names[names.length - 1], "SHA256SUMS");
    assert.ok(names.includes("soloagent.sqlite") && names.includes("durable.sqlite"));
    assert.ok(names.includes("workspaces/coder/notes.md") && names.includes("files/upload.bin") && names.includes("plain.db"));
    assert.ok(!names.some((n) => n === ".secret" || n.startsWith("backups") || /-(wal|shm)$/.test(n) || n.startsWith(".backup-tmp")), names.join(","));
    assert.equal(manifest.secret, "env");
    assert.equal(manifest.includesSecret, false);
    assert.equal(typeof manifest.hostname, "string");
    assert.deepEqual(manifest.databases, ["soloagent.sqlite", "durable.sqlite"]);

    const result = await restoreBackup(archive, target);
    assert.ok(result.files > 3);
    assert.deepEqual(result.warnings.length, 1, "warns that the backup needs the same SOLOAGENT_SECRET");
    assert.ok(!existsSync(join(target, "manifest.json")) && !existsSync(join(target, "SHA256SUMS")));
    assert.equal(readFileSync(join(target, "workspaces", "coder", "notes.md"), "utf8"), "# notes\n");
    assert.equal(readFileSync(join(target, "plain.db"), "utf8"), "not a database, copied as a file");

    const restored = await open(target);
    try {
      assert.deepEqual(restored.solo.agents.list().map((a) => a.handle).sort(), ["coder", "solo"]);
      const threads = restored.solo.listThreads();
      assert.equal(threads.length, 1);
      assert.equal(threads[0]!.title, "keep me");
      const { messages } = await restored.solo.messages(threads[0]!.id);
      assert.deepEqual(messages.map((m) => m.kind), ["user", "assistant"]);
      assert.equal(messages[1]!.kind === "assistant" && messages[1]!.text, "Backed up answer");
    } finally {
      await restored.solo.close();
    }

    // Refuses to overwrite data without force; force replaces it and keeps backups/.
    await assert.rejects(restoreBackup(archive, target), /already has data/);
    mkdirSync(join(target, "backups"), { recursive: true });
    writeFileSync(join(target, "backups", "keep.tar.gz"), "x");
    writeFileSync(join(target, "stray.txt"), "remove me");
    await restoreBackup(archive, target, { force: true });
    assert.ok(existsSync(join(target, "backups", "keep.tar.gz")));
    assert.ok(!existsSync(join(target, "stray.txt")));
    assert.ok(!(await readdir(target)).some((n) => n.startsWith(".restore-")));
  } finally {
    for (const dir of [source, target]) rmSync(dir, { recursive: true, force: true });
  }
});

test("restore verifies the archive before touching the data dir", async () => {
  const source = scratch();
  const target = scratch();
  const dir = scratch();
  try {
    const { solo } = await open(source);
    await solo.close();
    const archive = join(dir, "b.tar.gz");
    await writeBackupFile(source, archive, { version: "0.0.0-test", includeSecret: true, secret: { source: "file", fingerprint: "f", value: "s3cret" } });

    // Truncated archive.
    const bytes = readFileSync(archive);
    writeFileSync(join(dir, "cut.tar.gz"), bytes.subarray(0, Math.floor(bytes.length / 2)));
    writeFileSync(join(target, "precious.txt"), "keep");
    await assert.rejects(restoreBackup(join(dir, "cut.tar.gz"), target, { force: true }), /Corrupt archive|unexpected end/i);
    assert.equal(readFileSync(join(target, "precious.txt"), "utf8"), "keep");
    assert.deepEqual((await readdir(target)).sort(), ["precious.txt"]);

    // Not a backup at all.
    writeFileSync(join(dir, "junk.tar.gz"), "hello");
    await assert.rejects(restoreBackup(join(dir, "junk.tar.gz"), scratch()), /Corrupt archive|incorrect header/i);

    // --include-secret restores .secret.
    const fresh = scratch();
    const result = await restoreBackup(archive, fresh);
    assert.equal(readFileSync(join(fresh, ".secret"), "utf8"), "s3cret");
    assert.equal(result.manifest.includesSecret, true);
    rmSync(fresh, { recursive: true, force: true });
  } finally {
    for (const d of [source, target, dir]) rmSync(d, { recursive: true, force: true });
  }
});

test("backing up while a run is in progress does not crash and the run still finishes", async () => {
  const dir = scratch();
  const out = scratch();
  try {
    const { solo, faux } = await open(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    faux.setResponses([
      async () => {
        started();
        await gate;
        return fauxAssistantMessage([fauxText("done after backup")]);
      },
    ]);
    const thread = await solo.createThread({ source: "web" });
    const sent = await solo.send(thread.id, { text: "long task", author: { name: "ann", source: "web" } });
    await running;
    // Two backups at once, mid-run, plus writes in between.
    const a = writeBackupFile(dir, join(out, "a.tar.gz"), { version: "test" });
    solo.createAgent({ name: "During", handle: "during" });
    const b = writeBackupFile(dir, join(out, "b.tar.gz"), { version: "test" });
    await Promise.all([a, b]);
    release();
    assert.deepEqual(await sent.wait(), { status: "done", answer: "done after backup" });
    await solo.close();

    const restored = scratch();
    await restoreBackup(join(out, "b.tar.gz"), restored);
    const reopened = await open(restored);
    try {
      assert.ok(reopened.solo.agents.get("during"));
      assert.equal(reopened.solo.listThreads().length, 1);
    } finally {
      await reopened.solo.close();
      rmSync(restored, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("scheduled backup helpers: durations and pruning", async () => {
  assert.equal(parseDuration("24h"), 86_400_000);
  assert.equal(parseDuration("6h"), 21_600_000);
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration("12"), 43_200_000);
  assert.equal(parseDuration("0h"), undefined);
  assert.equal(parseDuration("soon"), undefined);
  assert.equal(parseDuration(undefined), undefined);

  const dir = scratch();
  try {
    for (let i = 1; i <= 5; i++) writeFileSync(join(dir, `soloagent-backup-2026-01-0${i}T00-00-00Z.tar.gz`), String(i));
    writeFileSync(join(dir, "unrelated.txt"), "keep");
    const removed = await pruneBackups(dir, 2);
    assert.equal(removed.length, 3);
    assert.deepEqual((await readdir(dir)).sort(), ["soloagent-backup-2026-01-04T00-00-00Z.tar.gz", "soloagent-backup-2026-01-05T00-00-00Z.tar.gz", "unrelated.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────── export / import ─────────────────────────────

test("agent export carries full stored data without ids, and import merges by handle", async () => {
  const a = scratch();
  const b = scratch();
  try {
    const one = await open(a);
    const coder = one.solo.createAgent({ name: "Coder", handle: "coder", instructions: "Write code.", skills: ["memory", "workspace"] });
    // A field this workstream doesn't know about still travels.
    one.solo.agents.update(coder.id, { budget: { monthlyUsd: 5 } } as never);
    const exported: AgentExport = JSON.parse(JSON.stringify(exportAgents(one.solo, "9.9.9")));
    await one.solo.close();
    assert.equal(exported.version, "9.9.9");
    assert.ok(exported.agents.every((agent) => !("id" in agent)));
    assert.deepEqual((exported.agents.find((x) => x.handle === "coder") as Record<string, unknown>).budget, { monthlyUsd: 5 });

    const two = await open(b);
    const solo = two.solo;
    solo.createAgent({ name: "Old coder", handle: "coder", instructions: "Old.", description: "kept" });
    const defaultBefore = solo.agents.default()!.handle;

    // Dry run: nothing changes.
    const preview = importAgents(solo, { agents: exported.agents, mode: "merge" }, { dryRun: true });
    assert.equal(preview.dryRun, true);
    const coderItem = preview.items.find((i) => i.handle === "coder")!;
    assert.equal(coderItem.action, "update");
    assert.ok(coderItem.fields.includes("instructions") && coderItem.fields.includes("budget") && coderItem.fields.includes("name"));
    assert.equal(solo.agents.get("coder")!.instructions, "Old.");

    // skip-existing leaves existing handles alone.
    const skipped = importAgents(solo, { agents: exported.agents, mode: "skip-existing" });
    assert.deepEqual(skipped.items.map((i) => [i.handle, i.action]).sort(), [["coder", "skip"], ["solo", "skip"]]);
    assert.equal(solo.agents.get("coder")!.instructions, "Old.");

    // merge overwrites imported fields, keeps the ones the file leaves out, and keeps the local id.
    const idBefore = solo.agents.get("coder")!.id;
    const partial = exported.agents.map((x) => (x.handle === "coder" ? { handle: "coder", instructions: "Write code.", budget: { monthlyUsd: 5 } } : x));
    const merged = importAgents(solo, { agents: [...partial, { name: "Brand New", handle: "fresh", isDefault: true, extra: [1, 2] }], mode: "merge" });
    const after = solo.agents.get("coder")! as unknown as Record<string, unknown>;
    assert.equal(after.id, idBefore);
    assert.equal(after.instructions, "Write code.");
    assert.equal(after.description, "kept");
    assert.deepEqual(after.budget, { monthlyUsd: 5 });
    const fresh = solo.agents.get("fresh")! as unknown as Record<string, unknown>;
    assert.equal(fresh.name, "Brand New");
    assert.deepEqual(fresh.extra, [1, 2]);
    assert.equal(fresh.isDefault, false, "import never changes the default agent");
    assert.equal(solo.agents.default()!.handle, defaultBefore);
    assert.deepEqual(merged.items.find((i) => i.handle === "fresh")!.action, "create");
    assert.equal(merged.items.find((i) => i.handle === "solo")!.action, "unchanged");

    // Importing the same thing again changes nothing.
    const again = importAgents(solo, { agents: partial, mode: "merge" });
    assert.ok(again.items.every((i) => i.action === "unchanged"));

    assert.throws(() => importAgents(solo, { agents: "nope" }), /must be an array/);
    assert.throws(() => importAgents(solo, { agents: [{}] }), /handle or a name/);
    assert.throws(() => importAgents(solo, { agents: [], mode: "replace" }), /mode/);
    await solo.close();
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// ───────────────────────────── versions ─────────────────────────────

test("semver comparison follows precedence rules", () => {
  assert.equal(compareSemver("0.1.1", "0.1.2"), -1);
  assert.equal(compareSemver("0.2.0", "0.1.9"), 1);
  assert.equal(compareSemver("v1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("0.10.0", "0.9.0"), 1, "numeric, not lexical");
  assert.equal(compareSemver("1.0.0-beta.2", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0-beta.10", "1.0.0-beta.2"), 1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareSemver("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareSemver("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(compareSemver("garbage", "0.0.1"), -1);
  assert.equal(parseSemver("1.2"), undefined);
  assert.deepEqual(parseSemver("v2.3.4-rc.1"), { major: 2, minor: 3, patch: 4, prerelease: ["rc", 1] });
});

test("update checker uses an injected fetch, caches in settings, and never throws", async () => {
  const store = new Map<string, string>();
  const settings = { setting: (k: string) => store.get(k), setSetting: (k: string, v: string) => void store.set(k, v) };
  const calls: string[] = [];
  let reply: () => Response = () => Response.json({ tag_name: "v0.1.2", html_url: "https://github.com/nearbycoder/soloagent.dev/releases/tag/v0.1.2" });
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    return reply();
  }) as unknown as typeof fetch;

  const checker = new UpdateChecker({ current: "0.1.1", settings, fetch: fakeFetch, enabled: true });
  assert.deepEqual(checker.info(), { current: "0.1.1", latest: undefined, url: undefined, updateAvailable: false, checkedAt: undefined, enabled: true });
  const info = await checker.check();
  assert.equal(calls[0], "https://api.github.com/repos/nearbycoder/soloagent.dev/releases/latest");
  assert.equal(info.latest, "0.1.2");
  assert.equal(info.updateAvailable, true);
  assert.equal(info.url, "https://github.com/nearbycoder/soloagent.dev/releases/tag/v0.1.2");

  // A later failure keeps the cached answer; a new checker reads it from settings.
  reply = () => new Response("rate limited", { status: 403 });
  const again = await checker.check();
  assert.equal(again.latest, "0.1.2");
  const fresh = new UpdateChecker({ current: "0.1.2", settings, fetch: fakeFetch, enabled: true });
  assert.equal(fresh.info().latest, "0.1.2");
  assert.equal(fresh.info().updateAvailable, false, "already on the latest");

  // Network errors and junk tags are swallowed.
  reply = () => {
    throw new TypeError("fetch failed");
  };
  await checker.check();
  reply = () => Response.json({ tag_name: "nightly" });
  await checker.check();
  assert.equal(checker.info().latest, "0.1.2");

  // Disabled: no network at all.
  const before = calls.length;
  const off = new UpdateChecker({ current: "0.1.1", settings: { setting: () => undefined, setSetting: () => {} }, fetch: fakeFetch, enabled: false });
  off.start();
  await off.check();
  assert.equal(calls.length, before);
  assert.equal(off.info().enabled, false);
});
