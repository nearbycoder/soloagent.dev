import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SoloAgent, attachmentContent, kindOf } from "../src/index.ts";
import { isPrivateAddress } from "../src/attachments.ts";
import { createApp } from "../../server/src/app.ts";

/** A 1x1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function open(options: { allowPrivateFileUrls?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "solo-files-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false, input: ["text", "image"] }] });
  const solo = await SoloAgent.open({ dataDir: dir, secret: "test", adminToken: "t", connectors: false, demo: false, providers: [faux.provider], log: () => {}, ...options });
  const agent = solo.agents.list()[0]!;
  solo.agents.update(agent.id, { model: { provider: "faux", modelId: "faux-1" } });
  /** Answer once and keep the request context the model saw. */
  const capture = (answer: string) => {
    const seen: { context?: TranscriptContext } = {};
    faux.setResponses([
      (context) => {
        seen.context = context;
        return fauxAssistantMessage([fauxText(answer)]);
      },
    ]);
    return seen;
  };
  return { solo, faux, dir, capture, cleanup: async () => { await solo.close(); rmSync(dir, { recursive: true, force: true }); } };
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };
function lastUserBlocks(context: TranscriptContext | undefined): Block[] {
  const user = [...(context?.messages ?? [])].reverse().find((m) => m.role === "user");
  assert.ok(user, "the request has a user message");
  return typeof user.content === "string" ? [{ type: "text", text: user.content }] : (user.content as Block[]);
}

test("attachmentContent: images become image blocks, text is fenced and capped, PDFs and others get notes", async () => {
  const csv = Buffer.from("id,name\n" + Array.from({ length: 2000 }, (_, i) => `${i},row ${i}`).join("\n"));
  const blocks = await attachmentContent(
    [
      { name: "dot.png", mimeType: "image/png", bytes: PNG },
      { name: "notes.md", mimeType: "", bytes: Buffer.from("# Title\n```js\nx\n```\n") },
      { name: "big.csv", mimeType: "text/csv", bytes: csv },
      { name: "report.pdf", mimeType: "application/pdf", bytes: Buffer.alloc(2048) },
      { name: "archive.zip", mimeType: "application/zip", bytes: Buffer.alloc(10) },
    ],
    { maxTextBytes: 1000 },
  );
  const image = blocks.find((b) => b.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, PNG.toString("base64"));
  const texts = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  assert.ok(texts.some((t) => t.startsWith("[image: dot.png (image/png, 70 B)]")));
  // Markdown with a fence inside is wrapped in a longer fence.
  const md = texts.find((t) => t.startsWith("notes.md:"))!;
  assert.match(md, /^notes\.md:\n````md\n# Title\n```js\nx\n```\n````$/);
  const big = texts.find((t) => t.startsWith("big.csv:"))!;
  assert.ok(big.includes("[truncated: showing the first 1000 B of"));
  assert.ok(big.length < 1200);
  assert.ok(texts.includes("[attached: report.pdf (application/pdf, 2 KB): PDF text extraction is not supported]"));
  assert.ok(texts.includes("[attached: archive.zip (application/zip, 10 B)]"));
});

test("attachmentContent: the total text budget and unsupported images", async () => {
  const kb = Buffer.alloc(80 * 1024, "a");
  const blocks = await attachmentContent([
    { name: "a.txt", mimeType: "text/plain", bytes: kb },
    { name: "b.txt", mimeType: "text/plain", bytes: kb },
    { name: "c.txt", mimeType: "text/plain", bytes: kb },
    { name: "photo.heic", mimeType: "image/heic", bytes: Buffer.from("not really heic") },
  ]);
  const texts = blocks.map((b) => (b as { text: string }).text);
  assert.ok(!texts[0]!.includes("truncated"));
  assert.ok(texts[2]!.includes("[truncated: showing the first 40 KB of 80 KB]"));
  assert.equal(texts[3], "[attached: photo.heic (image/heic, 15 B): this image format or size is not supported]");
  assert.equal(kindOf("main.rs", ""), "text");
  assert.equal(kindOf("Dockerfile", "application/octet-stream"), "text");
  assert.equal(kindOf("x.svg", "image/svg+xml"), "text");
  assert.equal(kindOf("scan.pdf", "application/octet-stream"), "pdf");
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
});

test("attachmentContent: with the Photon processor, BMP is converted to PNG", async () => {
  const { createNodePhotonImages } = await import("@earendil-works/pi-durable/images/node");
  const bmp = Buffer.from("424d3a0000000000000036000000280000000100000001000000010018000000000004000000130b0000130b00000000000000000000ff000000", "hex");
  const blocks = await attachmentContent([{ name: "dot.bmp", mimeType: "image/bmp", bytes: bmp }], { images: await createNodePhotonImages() });
  assert.equal(blocks[1]?.type === "image" && blocks[1].mimeType, "image/png");
});

test("an image sent through SoloAgent.send reaches the model as an image block and is stored on disk", async () => {
  const { solo, capture, dir, cleanup } = await open();
  try {
    const seen = capture("A tiny dot.");
    const thread = await solo.createThread({ source: "web" });
    const sent = await solo.send(thread.id, {
      text: "what is this? [solo:file 0000000000000000000000000000000000000000000000000000000000000000 image/png]",
      author: { name: "ann", source: "web" },
      attachments: [{ name: "dot.png", mimeType: "image/png", size: PNG.byteLength, data: PNG }],
    });
    assert.deepEqual(await sent.wait(), { status: "done", answer: "A tiny dot." });
    const blocks = lastUserBlocks(seen.context);
    assert.deepEqual(blocks[0], { type: "text", text: "what is this?" }, "markers people type are removed");
    const image = blocks.find((b) => b.type === "image");
    assert.equal(image?.mimeType, "image/png");
    assert.equal(image?.data, PNG.toString("base64"));
    assert.ok(!blocks.some((b) => b.text?.includes("[solo:file")), "markers never reach the model");

    // The transcript carries metadata only; the bytes live in <dataDir>/files/<sha256>.
    const { messages } = await solo.messages(thread.id);
    const user = messages.find((m) => m.kind === "user");
    assert.ok(user?.kind === "user" && user.attachments?.length === 1);
    const ref = user.attachments[0]!;
    assert.deepEqual({ name: ref.name, mimeType: ref.mimeType, size: ref.size }, { name: "dot.png", mimeType: "image/png", size: PNG.byteLength });
    assert.ok(existsSync(join(dir, "files", ref.sha256)));
    const row = solo.db.get<{ conversation_id: number }>("SELECT conversation_id FROM threads WHERE id = ?", thread.id)!;
    const conversation = await solo.harness.conversation(row.conversation_id as never, BACKGROUND_CONTEXT);
    const durable = JSON.stringify((await conversation!.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items);
    assert.ok(durable.includes("[solo:file "));
    assert.ok(!durable.includes(PNG.toString("base64")), "durable storage holds a marker, not the image");

    // A second request in the same thread still sees the image.
    const again = capture("Still a dot.");
    await (await solo.send(thread.id, { text: "and now?", author: { name: "ann", source: "web" } })).wait();
    const first = again.context!.messages.find((m) => m.role === "user")!;
    assert.ok(Array.isArray(first.content) && first.content.some((b) => b.type === "image"));
  } finally {
    await cleanup();
  }
});

test("webhook attachments: base64 and URL files end to end, private URLs blocked by default", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/csv" });
    res.end("a,b\n1,2\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/data.csv`;
  try {
    await webhookRoundTrip(url);
  } finally {
    server.close();
  }
});

async function webhookRoundTrip(url: string) {
  const { solo, capture, cleanup } = await open({ allowPrivateFileUrls: true });
  try {
    const app = createApp({ solo });
    const hook = solo.connectors.create({ kind: "webhook", config: { secret: "s3cret" } });
    await new Promise((r) => setTimeout(r, 50));
    const seen = capture("Got both.");
    const response = await app.request(`/api/hooks/${hook.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-solo-secret": "s3cret" },
      body: JSON.stringify({
        thread: "ci",
        user: "ci-bot",
        attachments: [
          { name: "build.log", mimeType: "text/plain", data_base64: Buffer.from("step 1 ok\nstep 2 failed").toString("base64") },
          { name: "data.csv", url },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { answer?: string }).answer, "Got both.");
    const text = lastUserBlocks(seen.context).map((b) => b.text ?? "").join("\n");
    assert.ok(text.startsWith("[ci-bot] shared:"));
    assert.ok(text.includes("build.log:\n```log\nstep 1 ok\nstep 2 failed\n```"));
    assert.ok(text.includes("data.csv:\n```csv\na,b\n1,2\n```"));
    const thread = solo.listThreads({ source: "webhook" })[0]!;
    assert.equal(thread.title, "Webhook · build.log, data.csv");
    const { messages } = await solo.messages(thread.id);
    const user = messages.find((m) => m.kind === "user");
    assert.deepEqual(user?.kind === "user" && user.attachments?.map((a) => a.name), ["build.log", "data.csv"]);

    // Bad input is refused.
    const bad = await app.request(`/api/hooks/${hook.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-solo-secret": "s3cret" },
      body: JSON.stringify({ attachments: [{ name: "x" }] }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await cleanup();
  }

  // Without the opt-in, a URL on the local network is never fetched.
  const locked = await open();
  try {
    const hook = locked.solo.connectors.create({ kind: "webhook", config: { secret: "s3cret" } });
    await new Promise((r) => setTimeout(r, 50));
    const seen = locked.capture("ok");
    await locked.solo.receiveWebhook(hook.id, "s3cret", { text: "look", attachments: [{ name: "data.csv", url }] });
    const text = lastUserBlocks(seen.context).map((b) => b.text ?? "").join("\n");
    assert.ok(text.includes("[attached: data.csv: could not be read (private network addresses are not allowed)]"));
  } finally {
    await locked.cleanup();
  }
}

test("GET /api/files/:sha256 needs auth and serves the file with its type and name", async () => {
  const { solo, cleanup } = await open();
  try {
    const app = createApp({ solo });
    const png = solo.files.put(PNG, { name: "dot.png", mimeType: "image/png" });
    const html = solo.files.put(Buffer.from("<script>alert(1)</script>"), { name: "evil.html", mimeType: "text/html" });

    assert.equal((await app.request(`/api/files/${png.sha256}`)).status, 401);
    assert.equal((await app.request(`/api/files/${png.sha256}`, { headers: { authorization: "Bearer wrong" } })).status, 401);

    const ok = await app.request(`/api/files/${png.sha256}`, { headers: { authorization: "Bearer t" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("content-disposition"), `inline; filename="dot.png"; filename*=UTF-8''dot.png`);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);

    const download = await app.request(`/api/files/${html.sha256}`, { headers: { authorization: "Bearer t" } });
    assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    await download.arrayBuffer();

    assert.equal((await app.request(`/api/files/${"0".repeat(64)}`, { headers: { authorization: "Bearer t" } })).status, 404);
    assert.equal((await app.request(`/api/files/..%2Fsoloagent.sqlite`, { headers: { authorization: "Bearer t" } })).status, 404);
  } finally {
    await cleanup();
  }
});
