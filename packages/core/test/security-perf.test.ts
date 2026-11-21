import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  DownloadError,
  SoloAgent,
  extractVerified,
  htmlToText,
  importAgents,
  isPrivateAddress,
  safeFetch,
  toTelegramHtml,
  writeTar,
  type TarEntryInput,
} from "../src/index.ts";
import { Db } from "../src/db.ts";
import { Sealer } from "../src/secrets.ts";
import { listen } from "./fakes/http.ts";

async function writeTarGz(filePath: string, entries: TarEntryInput[]) {
  await pipeline(Readable.from(writeTar(entries)), createGzip(), createWriteStream(filePath));
}

test("isPrivateAddress: blocks IPv4 private/special ranges and IPv6 SSRF bypass forms", () => {
  const blocked = [
    // IPv4 private, loopback, link-local, CGNAT, reserved, TEST-NET, benchmarking
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    // IPv6 loopback & unspecified (short + expanded + bracketed + zone ID)
    "::",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    // IPv4-mapped IPv6 (dotted AND WHATWG-normalized hex form!)
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:7f00:0001",
    "[::ffff:7f00:1]",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::ffff:10.0.0.1",
    "::ffff:0a00:0001",
    // IPv4-compatible IPv6
    "::127.0.0.1",
    "::7f00:1",
    // NAT64 (RFC 6052 / RFC 8215)
    "64:ff9b::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::10.0.0.1",
    // 6to4 (RFC 3056) & Teredo (RFC 4380)
    "2002:7f00:0001::1",
    "2002:c0a8:0101::1",
    "2001:0000:4136:e378::1",
    // Unique-local, link-local (entire fe80::/10 including febf), site-local, multicast, discard, docs
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "100::1",
    "2001:db8::1",
    // Malformed / unparseable fails closed
    "",
    "not-an-ip",
    "999.999.999.999",
    ":::",
  ];
  for (const addr of blocked) {
    assert.equal(isPrivateAddress(addr), true, `expected ${addr} to be blocked`);
  }

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "2606:2800:220:1:248:1893:25c8:1946",
    "2606:4700:4700::1111",
    "::ffff:93.184.216.34",
    "::ffff:5db8:d822",
  ];
  for (const addr of allowed) {
    assert.equal(isPrivateAddress(addr), false, `expected ${addr} to be allowed`);
  }
});

test("safeFetch: blocks private hosts/schemes/redirects and enforces maxBytes", async () => {
  await assert.rejects(() => safeFetch("file:///etc/passwd"), DownloadError);
  await assert.rejects(() => safeFetch("http://127.0.0.1:1/"), DownloadError);
  await assert.rejects(() => safeFetch("http://[::ffff:127.0.0.1]:1/"), DownloadError);

  const server = await listen(async (req, res) => {
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("a".repeat(2048));
      return;
    }
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    await assert.rejects(() => safeFetch(`http://127.0.0.1:${server.port}/ok`), DownloadError);
    const ok = await safeFetch(`http://127.0.0.1:${server.port}/ok`, { allowPrivate: true, maxBytes: 1024 });
    assert.equal(Buffer.from(ok.bytes).toString("utf8"), "hello");
    await assert.rejects(() => safeFetch(`http://127.0.0.1:${server.port}/big`, { allowPrivate: true, maxBytes: 512 }), DownloadError);
  } finally {
    await server.close();
  }
});

test("Sealer: rejects truncated auth tags, wrong IV lengths, and malformed envelopes", () => {
  const sealer = new Sealer("master-secret");
  const sealed = sealer.seal("top-secret");
  assert.equal(sealer.open(sealed), "top-secret");

  const [v, iv, tag, ct] = sealed.split(".");
  assert.ok(v && iv && tag && ct);
  // Truncated 4-byte auth tag must be rejected.
  const shortTag = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");
  assert.throws(() => sealer.open([v, iv, shortTag, ct].join(".")));
  // Wrong IV length must be rejected.
  const shortIv = Buffer.from(iv, "base64").subarray(0, 8).toString("base64");
  assert.throws(() => sealer.open([v, shortIv, tag, ct].join(".")));
  // Extra segments must be rejected.
  assert.throws(() => sealer.open(`${sealed}.extra`));
  // Tampered ciphertext must be rejected.
  const flipped = Buffer.from(ct, "base64");
  flipped[0] = (flipped[0] ?? 0) ^ 0xff;
  assert.throws(() => sealer.open([v, iv, tag, flipped.toString("base64")].join(".")));
});

test("extractVerified: rejects escaping symlinks and path-traversing manifest databases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "solo-backup-sec-"));
  const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
  try {
    const manifestBuf = Buffer.from(
      JSON.stringify({
        format: "soloagent-backup",
        formatVersion: 1,
        version: "0.2.1",
        createdAt: Date.now(),
        host: "test",
        databases: ["soloagent.sqlite"],
        includesSecret: false,
        secretFingerprint: "0000000000000000",
      }),
    );
    const dbBuf = Buffer.from("dummy");
    const checksums = Buffer.from(`${sha(manifestBuf)}  manifest.json\n${sha(dbBuf)}  soloagent.sqlite\n`);

    // Archive 1: symlink pointing outside extraction root
    const symlinkArchive = join(dir, "symlink.tar.gz");
    await writeTarGz(symlinkArchive, [
      { type: "file", name: "manifest.json", size: manifestBuf.length, body: manifestBuf },
      { type: "file", name: "soloagent.sqlite", size: dbBuf.length, body: dbBuf },
      { type: "symlink", name: "workspaces/escape", linkname: "../../../../etc/passwd" },
      { type: "file", name: "SHA256SUMS", size: checksums.length, body: checksums },
    ]);
    await assert.rejects(() => extractVerified(symlinkArchive, join(dir, "out1")), /unsafe symlink/i);

    // Archive 2: manifest.databases attempts traversal
    const badManifest = Buffer.from(
      JSON.stringify({
        format: "soloagent-backup",
        formatVersion: 1,
        version: "0.2.1",
        createdAt: Date.now(),
        host: "test",
        databases: ["../outside.sqlite"],
        includesSecret: false,
        secretFingerprint: "0000000000000000",
      }),
    );
    const badChecksums = Buffer.from(`${sha(badManifest)}  manifest.json\n`);
    const badDbArchive = join(dir, "baddb.tar.gz");
    await writeTarGz(badDbArchive, [
      { type: "file", name: "manifest.json", size: badManifest.length, body: badManifest },
      { type: "file", name: "SHA256SUMS", size: badChecksums.length, body: badChecksums },
    ]);
    await assert.rejects(() => extractVerified(badDbArchive, join(dir, "out2")), /unsafe path/i);

    // Archive 3: manifest.databases attempts nested subdirectory path
    const nestedManifest = Buffer.from(
      JSON.stringify({
        format: "soloagent-backup",
        formatVersion: 1,
        version: "0.2.1",
        createdAt: Date.now(),
        host: "test",
        databases: ["sub/nested.sqlite"],
        includesSecret: false,
        secretFingerprint: "0000000000000000",
      }),
    );
    const nestedChecksums = Buffer.from(`${sha(nestedManifest)}  manifest.json\n`);
    const nestedDbArchive = join(dir, "nesteddb.tar.gz");
    await writeTarGz(nestedDbArchive, [
      { type: "file", name: "manifest.json", size: nestedManifest.length, body: nestedManifest },
      { type: "file", name: "SHA256SUMS", size: nestedChecksums.length, body: nestedChecksums },
    ]);
    await assert.rejects(() => extractVerified(nestedDbArchive, join(dir, "out3")), /unsafe database/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Db: applies SQLite pragmas, prepared-statement caching, and 060_indexes migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "solo-db-perf-"));
  const db = new Db(join(dir, "test.sqlite"));
  try {
    const busy = db.get<{ timeout: number }>("PRAGMA busy_timeout");
    assert.ok((busy?.timeout ?? 0) >= 5000);
    const indexes = new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name));
    for (const expected of ["admissions_at", "activity_type_at", "threads_agent_updated", "threads_source_updated", "schedules_at"]) {
      assert.ok(indexes.has(expected), `missing index ${expected}`);
    }
    // Exercise statement cache across repeated queries.
    for (let i = 0; i < 20; i++) {
      db.setSetting("k", `v${i}`);
      assert.equal(db.setting("k"), `v${i}`);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("htmlToText, toTelegramHtml, and importAgents harden entity decoding, escaping, and prototype keys", async () => {
  // High/invalid numeric entities must not throw RangeError; valid hex entities decode cleanly.
  assert.doesNotThrow(() => htmlToText("<p>&#99999999; &#xdeadbeef; &#x2605;</p>"));
  assert.ok(htmlToText("<p>&#x2605;</p>").includes("★"));

  // Quotes are escaped in Telegram HTML.
  assert.ok(toTelegramHtml('say "hi"').includes("&quot;hi&quot;"));

  // Prototype-pollution keys in imported agent records must be ignored.
  const dir = mkdtempSync(join(tmpdir(), "solo-proto-"));
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "t", connectors: false, demo: false, log: () => {} });
  try {
    const payload = JSON.parse('{"format":1,"agents":[{"name":"Safe","handle":"safe","__proto__":{"polluted":true},"constructor":{"polluted":true}}]}');
    const result = importAgents(solo, payload);
    assert.equal(result.items[0]?.action, "create");
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  } finally {
    await solo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
