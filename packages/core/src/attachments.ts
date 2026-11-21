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
  maxRedirects?: number;
  /** Allow loopback and private network addresses. Off by default: webhook callers must not reach internal services. */
  allowPrivate?: boolean;
};

export type SafeFetchResult = {
  status: number;
  ok: boolean;
  contentType: string;
  bytes: Uint8Array;
  truncated: boolean;
};

/**
 * Fetch an HTTP(S) resource with SSRF protection, manual redirect validation, timeout, and a strict byte cap.
 * Unlike `download()`, returns non-2xx responses (and truncated bodies when `truncate` is set) for tools like `web_fetch`.
 */
export async function safeFetch(url: string, options: DownloadOptions & { truncate?: boolean } = {}): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? ATTACHMENT_LIMITS.maxFileBytes;
  const maxHops = Math.max(0, options.maxRedirects ?? 3) + 1;
  const signal = AbortSignal.timeout(options.timeoutMs ?? ATTACHMENT_LIMITS.downloadTimeoutMs);
  const initialOrigin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      throw new DownloadError("invalid URL");
    }
  })();
  let current = url;
  try {
    for (let hop = 0; hop < maxHops; hop++) {
      const parsed = new URL(current);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new DownloadError("only http and https URLs are supported");
      if (!options.allowPrivate) await assertPublicHost(parsed.hostname);
      const sameOrigin = hop === 0 || initialOrigin === parsed.origin;
      const response = await fetch(parsed, { headers: sameOrigin ? options.headers : undefined, redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        current = new URL(response.headers.get("location")!, parsed).toString();
        await response.body?.cancel().catch(() => {});
        continue;
      }
      if (!options.truncate) {
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > maxBytes) {
          await response.body?.cancel().catch(() => {});
          throw new DownloadError(`larger than the ${formatBytes(maxBytes)} limit`);
        }
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            if (total + value.byteLength > maxBytes) {
              if (options.truncate) {
                const room = maxBytes - total;
                if (room > 0) chunks.push(value.subarray(0, room));
                total = maxBytes;
                truncated = true;
                await reader.cancel().catch(() => {});
                break;
              }
              await reader.cancel().catch(() => {});
              throw new DownloadError(`larger than the ${formatBytes(maxBytes)} limit`);
            }
            total += value.byteLength;
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      return {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") ?? "",
        bytes: Buffer.concat(chunks),
        truncated,
      };
    }
    throw new DownloadError("too many redirects");
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") throw new DownloadError("the download timed out");
    throw new DownloadError("the download failed");
  }
}

/**
 * Download a file with a size cap and a timeout. Redirects are followed by hand (at most 3) so every hop is checked;
 * error messages never include the URL, which may carry a token (Telegram's file URLs do).
 */
export async function download(url: string, options: DownloadOptions = {}): Promise<Uint8Array> {
  const result = await safeFetch(url, options);
  if (!result.ok) throw new DownloadError(`the server answered ${result.status}`);
  return result.bytes;
}

export async function assertPublicHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((all) => all.map((a) => a.address), () => [] as string[]);
  if (addresses.length === 0) throw new DownloadError("the host could not be resolved");
  if (addresses.some(isPrivateAddress)) throw new DownloadError("private network addresses are not allowed");
}

function isPrivateIpv4Octets(a: number, b: number, c: number, d: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local / cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return a === 255 && b === 255 && c === 255 && d === 255;
}

/** Parse a canonical or compressed IPv6 address (including mixed IPv4 tail) into eight 16-bit groups. */
function parseIpv6(raw: string): number[] | undefined {
  const addr = raw.split("%")[0]!.toLowerCase();
  const doubleColon = addr.indexOf("::");
  if (doubleColon !== -1 && addr.indexOf("::", doubleColon + 1) !== -1) return undefined;

  const parseSide = (part: string): number[] | undefined => {
    if (!part) return [];
    const tokens = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.includes(".")) {
        if (i !== tokens.length - 1) return undefined;
        const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(t);
        if (!m) return undefined;
        const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
        if (octets.some((o) => o > 255)) return undefined;
        out.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(t)) return undefined;
        out.push(parseInt(t, 16));
      }
    }
    return out;
  };

  if (doubleColon === -1) {
    const groups = parseSide(addr);
    return groups && groups.length === 8 ? groups : undefined;
  }
  const left = parseSide(addr.slice(0, doubleColon));
  const right = parseSide(addr.slice(doubleColon + 2));
  if (!left || !right || left.length + right.length >= 8) return undefined;
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export function isPrivateAddress(address: string): boolean {
  const clean = address.trim().replace(/^\[|\]$/g, "");
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(clean);
  if (v4) {
    const [a, b, c, d] = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    return isPrivateIpv4Octets(a, b, c, d);
  }
  const g = parseIpv6(clean);
  if (!g) return true; // conservatively reject unparseable addresses
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const zeroHead5 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // Unspecified ::, loopback ::1, and deprecated IPv4-compatible ::/96
  if (zeroHead5 && g5 === 0) return true;
  // IPv4-mapped ::ffff:0:0/96 (both dotted ::ffff:127.0.0.1 and hex ::ffff:7f00:1)
  if (zeroHead5 && g5 === 0xffff) return isPrivateIpv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff);
  // IPv4-translated ::ffff:0:0:0/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return isPrivateIpv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff);
  // NAT64 well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (g0 === 0x0064 && g1 === 0xff9b) {
    if (g2 === 1) return true;
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff);
  }
  // 6to4 2002::/16 (embeds IPv4 in g1, g2)
  if (g0 === 0x2002) return isPrivateIpv4Octets(g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff);
  // Discard 100::/64, Teredo 2001::/32, documentation 2001:db8::/32
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8)) return true;
  // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}
