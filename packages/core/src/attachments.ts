import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, join } from "node:path";
import type { ImageContent, Message as PiMessage, TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_IMAGE_LIMITS, type ImageLimits, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import type { Attachment } from "@soloagent/client";
import type { Db } from "./db.ts";

/**
 * Files and images people share with agents: limits, kinds, a content-addressed store on disk, safe downloads,
 * and the helper that turns attachments into model content.
 */

/** A file as a connector or the API hands it in: its bytes, or a URL to download them from. */
export type InboundAttachment = { name: string; mimeType: string; size: number; data?: Uint8Array; url?: string };

export const ATTACHMENT_LIMITS = {
  /** Largest file accepted, downloaded, or stored. */
  maxFileBytes: 20 * 1024 * 1024,
  /** Files per message; the rest are noted and dropped. */
  maxFiles: 10,
  /** Text inlined per text-like file. */
  maxTextBytes: 100 * 1024,
  /** Text inlined across all files of one message. */
  maxTotalTextBytes: 200 * 1024,
  downloadTimeoutMs: 30_000,
} as const;

export type AttachmentKind = "image" | "text" | "pdf" | "other";

/** Formats every provider takes inline. Others go through the image processor when there is one. */
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".ndjson": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".log": "text/plain",
  ".zip": "application/zip",
};

/** Extensions read as text whatever their declared type: config, code, and data formats. */
const TEXT_EXTENSIONS = new Set(
  (
    ".txt .md .markdown .rst .adoc .csv .tsv .json .jsonl .ndjson .yaml .yml .toml .ini .cfg .conf .env .xml .html .htm .css .scss .sass .less " +
    ".svg .log .diff .patch .sql .graphql .gql .proto .js .mjs .cjs .jsx .ts .mts .cts .tsx .py .rb .go .rs .java .kt .kts .scala .swift .c .h .cc .cpp " +
    ".hpp .cs .fs .php .pl .lua .r .jl .dart .ex .exs .erl .hs .ml .clj .vue .svelte .astro .sh .bash .zsh .fish .ps1 .bat .tf .hcl .nix .gradle .properties .tex .bib"
  ).split(" "),
);
const TEXT_NAMES = new Set(["dockerfile", "makefile", "readme", "license", "procfile", "gemfile", "rakefile", ".gitignore", ".dockerignore", ".editorconfig"]);
const TEXT_MIMES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/x-sh",
  "application/x-shellscript",
  "application/sql",
  "application/graphql",
  "application/x-httpd-php",
  "application/csv",
  "image/svg+xml",
]);

/** The declared type, or one guessed from the extension when it is missing or generic. Lowercase, without parameters. */
export function normalizeMime(name: string, mimeType: string | undefined): string {
  const declared = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== "binary/octet-stream") return declared === "image/jpg" ? "image/jpeg" : declared;
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? (declared || "application/octet-stream");
}

export function kindOf(name: string, mimeType: string): AttachmentKind {
  const mime = normalizeMime(name, mimeType);
  const ext = extname(name).toLowerCase();
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image";
  if (mime.startsWith("text/") || TEXT_MIMES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
  if (TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(name.toLowerCase())) return "text";
  return "other";
}

/** Text when the bytes are valid UTF-8 without NUL bytes: for files of unknown type such as `Makefile.local`. */
function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 104.8576)) / 10} MB`;
}

/** File names are user input: no paths, no control characters, a sane length. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 180);
  return clean && clean !== "." && clean !== ".." ? clean : "file";
}

// ───────────────────────────── model content ─────────────────────────────

export type AttachmentFile = { name: string; mimeType: string; bytes: Uint8Array; sha256?: string };

export type AttachmentContentOptions = {
  /** Resizes and converts images. Without one, PNG, JPEG, GIF, and WebP within the limits pass through unchanged. */
  images?: ImageProcessor;
  limits?: ImageLimits;
  maxTextBytes?: number;
  maxTotalTextBytes?: number;
  /** Where a file was saved for the agent's tools, e.g. "attachments/report.pdf" in its workspace. */
  savedAs?: (file: AttachmentFile) => string | undefined;
};

/**
 * Model content for attached files: images as image blocks (resized to the limits), text-like files inlined as fenced
 * text with their name (capped, with a note when cut), and a note with name, type, and size for everything else.
 * PDFs get a note too: text extraction would need a PDF parser, and the agent's workspace tools can do it instead.
 */
export async function attachmentContent(files: AttachmentFile[], options: AttachmentContentOptions = {}): Promise<(TextContent | ImageContent)[]> {
  const limits = options.limits ?? DEFAULT_IMAGE_LIMITS;
  const maxText = options.maxTextBytes ?? ATTACHMENT_LIMITS.maxTextBytes;
  let textBudget = options.maxTotalTextBytes ?? ATTACHMENT_LIMITS.maxTotalTextBytes;
  const blocks: (TextContent | ImageContent)[] = [];
  const text = (value: string) => blocks.push({ type: "text", text: value });

  for (const file of files) {
    const name = safeName(file.name);
    const mime = normalizeMime(name, file.mimeType);
    const size = file.bytes.byteLength;
    const label = `${name} (${mime}, ${formatBytes(size)})`;
    const saved = options.savedAs?.(file);
    const savedNote = saved ? ` Saved to \`${saved}\` in your workspace.` : "";
    let kind = kindOf(name, mime);
    if (kind === "other" && (mime === "application/octet-stream" || mime === "") && looksLikeText(file.bytes)) kind = "text";

    if (kind === "image") {
      const prepared = await prepareImage(file.bytes, mime, limits, options.images);
      if (!prepared) {
        text(`[attached: ${label}: this image format or size is not supported]${savedNote}`);
        continue;
      }
      const resized = prepared.resized ? `, resized from ${prepared.resized.from.width}x${prepared.resized.from.height} to ${prepared.resized.to.width}x${prepared.resized.to.height}` : "";
      text(`[image: ${label}${resized}]`);
      blocks.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
      continue;
    }

    if (kind === "text") {
      const budget = Math.max(0, Math.min(maxText, textBudget));
      if (budget === 0) {
        text(`[attached: ${label}: not inlined, the message's text limit is used up]${savedNote}`);
        continue;
      }
      const cut = size > budget;
      const body = new TextDecoder("utf-8").decode(cut ? cutUtf8(file.bytes, budget) : file.bytes);
      textBudget -= Math.min(size, budget);
      const fence = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
      const note = cut ? `\n[truncated: showing the first ${formatBytes(budget)} of ${formatBytes(size)}]${savedNote}` : "";
      text(`${name}:\n${fence}${fenceLang(name)}\n${body}${body.endsWith("\n") ? "" : "\n"}${fence}${note}`);
      continue;
    }

    if (kind === "pdf") {
      text(`[attached: ${label}: PDF text extraction is not supported]${savedNote}`);
      continue;
    }
    text(`[attached: ${label}]${savedNote}`);
  }
  return blocks;
}

async function prepareImage(bytes: Uint8Array, mimeType: string, limits: ImageLimits, processor: ImageProcessor | undefined) {
  if (processor) {
    try {
      // A copy: the Node processor transfers the buffer to its worker, which pooled Buffers cannot be.
      const prepared = await processor.prepare(new Uint8Array(bytes), mimeType, limits);
      if (prepared) return prepared;
    } catch {
      // fall through to the pass-through check
    }
  }
  if (!INLINE_IMAGES.has(mimeType) || Math.ceil(bytes.byteLength / 3) * 4 > limits.maxBytes) return undefined;
  return { data: Buffer.from(bytes).toString("base64"), mimeType, resized: undefined };
}

/** The longest prefix of at most `max` bytes that ends on a character boundary. */
function cutUtf8(bytes: Uint8Array, max: number): Uint8Array {
  let end = Math.min(max, bytes.byteLength);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

function longestRun(text: string, char: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === char ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

function fenceLang(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9+#-]{1,12}$/.test(ext) ? ext : "";
}

// ───────────────────────────── storage ─────────────────────────────

/**
 * Original files on disk under `<dataDir>/files/<sha256>`, content-addressed so the same file shared twice is
 * stored once. The `files` table keeps the name and type the dashboard serves them with.
 */
export class FileStore {
  readonly dir: string;
  #db: Db;

  constructor(dir: string, db: Db) {
    this.dir = dir;
    this.#db = db;
    mkdirSync(dir, { recursive: true });
  }

  put(bytes: Uint8Array, meta: { name: string; mimeType: string }): Attachment {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(this.dir, sha256);
    if (!existsSync(path)) {
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, path);
    }
    const name = safeName(meta.name);
    const mimeType = normalizeMime(name, meta.mimeType);
    this.#db.run("INSERT OR IGNORE INTO files (sha256, name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?)", sha256, name, mimeType, bytes.byteLength, Date.now());
    return { name, mimeType, size: bytes.byteLength, sha256 };
  }

  get(sha256: string): (Attachment & { path: string }) | undefined {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;
    const row = this.#db.get<{ name: string; mime_type: string; size: number }>("SELECT name, mime_type, size FROM files WHERE sha256 = ?", sha256);
    const path = join(this.dir, sha256);
    if (!row || !existsSync(path)) return undefined;
    return { name: row.name, mimeType: row.mime_type, size: row.size, sha256, path };
  }

  async read(sha256: string): Promise<Uint8Array | undefined> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;
    return readFile(join(this.dir, sha256)).catch(() => undefined);
  }
}

// ───────────────────────────── image markers ─────────────────────────────

/**
 * Pi Durable stores a user message's content, image blocks included, in its SQLite database. To keep that small,
 * soloagent stores the prepared image as a file and puts a marker block in the durable message instead; a
 * `beforeRequest` hook swaps the image back in for every model request. Markers never reach the model, and
 * `stripMarkers` removes look-alikes from what people type, so nobody can pull in a file by its hash.
 */
const MARKER = /^\[solo:file ([0-9a-f]{64}) (image\/[a-z0-9.+-]+)\]$/;
const MARKER_ANYWHERE = /\[solo:file [^\]]*\]/g;

export function stripMarkers(text: string): string {
  return text.replace(MARKER_ANYWHERE, "");
}

/** Replace image blocks with markers, storing each image as a file. */
export function externalizeImages(blocks: (TextContent | ImageContent)[], store: FileStore, name: (index: number) => string): (TextContent | ImageContent)[] {
  let index = 0;
  return blocks.map((block) => {
    if (block.type !== "image") return block;
    const ref = store.put(Buffer.from(block.data, "base64"), { name: name(index++), mimeType: block.mimeType });
    return { type: "text", text: `[solo:file ${ref.sha256} ${block.mimeType}]` };
  });
}

/** Swap markers in user messages back to image blocks, read from the store. */
export async function expandImageMarkers(messages: readonly PiMessage[], store: FileStore): Promise<readonly PiMessage[]> {
  if (!messages.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "text" && b.text.startsWith("[solo:file ")))) return messages;
  return Promise.all(
    messages.map(async (message) => {
      if (message.role !== "user" || !Array.isArray(message.content)) return message;
      const content = await Promise.all(
        message.content.map(async (block): Promise<TextContent | ImageContent> => {
          const match = block.type === "text" ? MARKER.exec(block.text) : null;
          if (!match) return block;
          const bytes = await store.read(match[1]!);
          return bytes ? { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: match[2]! } : { type: "text", text: "(image no longer available)" };
        }),
      );
      return { ...message, content };
    }),
  );
}

// ───────────────────────────── downloads ─────────────────────────────

export class DownloadError extends Error {}

export type DownloadOptions = {
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  /** Allow loopback and private network addresses. Off by default: webhook callers must not reach internal services. */
  allowPrivate?: boolean;
};

/**
 * Download a file with a size cap and a timeout. Redirects are followed by hand (at most 3) so every hop is checked;
 * error messages never include the URL, which may carry a token (Telegram's file URLs do).
 */
export async function download(url: string, options: DownloadOptions = {}): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? ATTACHMENT_LIMITS.maxFileBytes;
  const signal = AbortSignal.timeout(options.timeoutMs ?? ATTACHMENT_LIMITS.downloadTimeoutMs);
  let current = url;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const parsed = new URL(current);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new DownloadError("only http and https URLs are supported");
      if (!options.allowPrivate) await assertPublicHost(parsed.hostname);
      const sameOrigin = hop === 0 || new URL(url).origin === parsed.origin;
      const response = await fetch(parsed, { headers: sameOrigin ? options.headers : undefined, redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        current = new URL(response.headers.get("location")!, parsed).toString();
        await response.body?.cancel().catch(() => {});
        continue;
      }
      if (!response.ok) throw new DownloadError(`the server answered ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new DownloadError(`larger than the ${formatBytes(maxBytes)} limit`);
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body ?? []) {
        total += (chunk as Uint8Array).byteLength;
        if (total > maxBytes) throw new DownloadError(`larger than the ${formatBytes(maxBytes)} limit`);
        chunks.push(chunk as Uint8Array);
      }
      return Buffer.concat(chunks);
    }
    throw new DownloadError("too many redirects");
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") throw new DownloadError("the download timed out");
    throw new DownloadError("the download failed");
  }
}

async function assertPublicHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((all) => all.map((a) => a.address), () => [] as string[]);
  if (addresses.length === 0) throw new DownloadError("the host could not be resolved");
  if (addresses.some(isPrivateAddress)) throw new DownloadError("private network addresses are not allowed");
}

export function isPrivateAddress(address: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("ff");
}
