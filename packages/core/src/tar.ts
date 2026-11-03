/**
 * A small streaming tar (ustar + PAX long names) writer and reader. Enough for soloagent's own
 * backups: regular files, directories, and symlinks. Gzip is applied by the caller with node:zlib.
 */

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const MAX_OCTAL_SIZE = 8 ** 11 - 1;

export type TarEntryInput =
  | { type: "file"; name: string; size: number; mode?: number; mtime?: number; body: Buffer | AsyncIterable<Buffer> }
  | { type: "directory"; name: string; mode?: number; mtime?: number }
  | { type: "symlink"; name: string; linkname: string; mode?: number; mtime?: number };

export type TarEntry = {
  type: "file" | "directory" | "symlink" | "other";
  name: string;
  size: number;
  mode: number;
  /** Seconds since the epoch. */
  mtime: number;
  linkname: string;
  /** The file's bytes. Read it before asking for the next entry, or it is skipped. */
  body: AsyncIterable<Buffer>;
};

export class TarError extends Error {}

// ───────────────────────────── writer ─────────────────────────────

/** Serialize entries to tar bytes, ending with the two zero blocks. */
export async function* writeTar(entries: AsyncIterable<TarEntryInput> | Iterable<TarEntryInput>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    const name = entry.type === "directory" && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
    const linkname = entry.type === "symlink" ? entry.linkname : "";
    const size = entry.type === "file" ? entry.size : 0;
    const mtime = Math.floor((entry.mtime ?? Date.now()) / 1000);
    const mode = entry.mode ?? (entry.type === "directory" ? 0o755 : entry.type === "symlink" ? 0o777 : 0o644);

    const split = splitName(name);
    const pax: Record<string, string> = {};
    if (!split) pax.path = name;
    if (Buffer.byteLength(linkname) > 100) pax.linkpath = linkname;
    if (Object.keys(pax).length) {
      const body = paxRecords(pax);
      yield header({ name: "PaxHeader", prefix: "", size: body.length, mode: 0o644, mtime, type: "x", linkname: "" });
      yield* padded(body);
    }
    const flag = entry.type === "file" ? "0" : entry.type === "directory" ? "5" : "2";
    yield header({
      name: split?.name ?? truncateUtf8(name, 100),
      prefix: split?.prefix ?? "",
      size,
      mode,
      mtime,
      type: flag,
      linkname: pax.linkpath ? truncateUtf8(linkname, 100) : linkname,
    });
    if (entry.type !== "file") continue;

    // Files can change while they are read; write exactly `size` bytes either way.
    let written = 0;
    const body = Buffer.isBuffer(entry.body) ? [entry.body] : entry.body;
    for await (const chunk of body) {
      if (written >= size) break;
      const part = chunk.length > size - written ? chunk.subarray(0, size - written) : chunk;
      written += part.length;
      yield part;
    }
    if (written < size) {
      // The file shrank; fill with zeros so the archive stays well-formed.
      let missing = size - written;
      while (missing > 0) {
        const n = Math.min(missing, 64 * 1024);
        yield Buffer.alloc(n);
        missing -= n;
      }
    }
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  yield ZERO_BLOCK;
  yield ZERO_BLOCK;
}

function* padded(body: Buffer): Generator<Buffer> {
  yield body;
  const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
  if (pad) yield Buffer.alloc(pad);
}

function paxRecords(records: Record<string, string>): Buffer {
  let out = "";
  for (const [key, value] of Object.entries(records)) {
    const tail = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(tail) + 1;
    while (String(length).length + Buffer.byteLength(tail) !== length) length = String(length).length + Buffer.byteLength(tail);
    out += `${length}${tail}`;
  }
  return Buffer.from(out, "utf8");
}

/** Fit a path in ustar's 100-byte name plus 155-byte prefix, split at a slash. */
function splitName(name: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest.length > 0) return { name: rest, prefix };
  }
  return undefined;
}

function truncateUtf8(value: string, bytes: number): string {
  let out = value;
  while (Buffer.byteLength(out) > bytes) out = out.slice(0, -1);
  return out;
}

function header(h: { name: string; prefix: string; size: number; mode: number; mtime: number; type: string; linkname: string }): Buffer {
  const buf = Buffer.alloc(BLOCK);
  buf.write(h.name, 0, 100, "utf8");
  writeOctal(buf, h.mode & 0o7777, 100, 8);
  writeOctal(buf, 0, 108, 8);
  writeOctal(buf, 0, 116, 8);
  if (h.size > MAX_OCTAL_SIZE) writeBase256(buf, h.size, 124, 12);
  else writeOctal(buf, h.size, 124, 12);
  writeOctal(buf, h.mtime, 136, 12);
  buf.fill(0x20, 148, 156);
  buf.write(h.type, 156, 1, "ascii");
  buf.write(h.linkname, 157, 100, "utf8");
  buf.write("ustar\u000000", 257, 8, "ascii");
  buf.write(h.prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i]!;
  buf.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, 8, "ascii");
  return buf;
}

function writeOctal(buf: Buffer, value: number, offset: number, length: number) {
  buf.write(`${Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0")}\u0000`, offset, length, "ascii");
}

function writeBase256(buf: Buffer, value: number, offset: number, length: number) {
  let v = BigInt(value);
  for (let i = offset + length - 1; i > offset; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  buf[offset] = 0x80;
}

// ───────────────────────────── reader ─────────────────────────────

/** Read tar bytes into entries. Verifies header checksums and fails on truncated archives. */
export async function* readTar(source: AsyncIterable<Buffer | Uint8Array | string>): AsyncGenerator<TarEntry> {
  const bytes = new ByteReader(source[Symbol.asyncIterator]());
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  for (;;) {
    const block = await bytes.takeOrEnd(BLOCK);
    if (!block) return; // tolerate archives without the end-of-archive blocks
    if (block.every((b) => b === 0)) {
      // Read to the end so a gzip layer underneath verifies its checksum.
      await bytes.drain();
      return;
    }
    verifyChecksum(block);

    const type = String.fromCharCode(block[156]!) || "0";
    const size = readNumber(block, 124, 12);
    const ustarName = cString(block, 0, 100);
    const prefix = block.toString("ascii", 257, 262) === "ustar" ? cString(block, 345, 155) : "";
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${ustarName}` : ustarName);
    const linkname = pax.linkpath ?? longLink ?? cString(block, 157, 100);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === "x" || type === "g" || type === "L" || type === "K") {
      const body = await bytes.take(size);
      await bytes.take(padding);
      if (type === "x") pax = { ...pax, ...parsePax(body) };
      else if (type === "L") longName = cString(body, 0, body.length);
      else if (type === "K") longLink = cString(body, 0, body.length);
      continue;
    }
    pax = {};
    longName = undefined;
    longLink = undefined;

    const kind: TarEntry["type"] = type === "0" || type === "\0" || type === "7" ? "file" : type === "5" ? "directory" : type === "2" ? "symlink" : "other";
    const dataSize = kind === "directory" || kind === "symlink" ? 0 : size;
    let consumed = false;
    const body: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: async function* () {
        if (consumed) throw new TarError("Entry body was already read");
        consumed = true;
        yield* bytes.chunks(dataSize);
      },
    };
    yield {
      type: kind,
      name: kind === "directory" ? name.replace(/\/+$/, "") : name,
      size: dataSize,
      mode: readNumber(block, 100, 8),
      mtime: readNumber(block, 136, 12),
      linkname,
      body,
    };
    if (!consumed) {
      consumed = true;
      for await (const _ of bytes.chunks(dataSize)) {
        // skip unread bodies
      }
    }
    await bytes.take((BLOCK - (dataSize % BLOCK)) % BLOCK);
  }
}

function verifyChecksum(block: Buffer) {
  const stored = readNumber(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  if (sum !== stored) throw new TarError("Corrupt archive: tar header checksum mismatch");
}

function readNumber(buf: Buffer, offset: number, length: number): number {
  if (buf[offset]! & 0x80) {
    let v = 0n;
    for (let i = offset + 1; i < offset + length; i++) v = (v << 8n) | BigInt(buf[i]!);
    return Number(v);
  }
  const text = buf.toString("ascii", offset, offset + length).replace(/[\0 ]+$/g, "").trim();
  return text ? parseInt(text, 8) : 0;
}

function cString(buf: Buffer, offset: number, length: number): string {
  const end = buf.indexOf(0, offset);
  return buf.toString("utf8", offset, end === -1 || end > offset + length ? offset + length : end);
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const space = body.indexOf(0x20, i);
    if (space === -1) break;
    const length = Number(body.toString("ascii", i, space));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.toString("utf8", space + 1, i + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

/** Pulls exact byte counts out of an async chunk stream. */
class ByteReader {
  #source: AsyncIterator<Buffer | Uint8Array | string>;
  #buffer: Buffer = Buffer.alloc(0);
  #done = false;

  constructor(source: AsyncIterator<Buffer | Uint8Array | string>) {
    this.#source = source;
  }

  async #pull(): Promise<boolean> {
    if (this.#done) return false;
    const next = await this.#source.next();
    if (next.done) {
      this.#done = true;
      return false;
    }
    const chunk = typeof next.value === "string" ? Buffer.from(next.value) : Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    return true;
  }

  async take(n: number): Promise<Buffer> {
    while (this.#buffer.length < n) if (!(await this.#pull())) throw new TarError("Corrupt archive: unexpected end of data");
    const out = this.#buffer.subarray(0, n);
    this.#buffer = this.#buffer.subarray(n);
    return out;
  }

  /** `n` bytes, or undefined at a clean end of stream. */
  async takeOrEnd(n: number): Promise<Buffer | undefined> {
    while (this.#buffer.length < n) {
      if (!(await this.#pull())) {
        if (this.#buffer.length === 0) return undefined;
        throw new TarError("Corrupt archive: unexpected end of data");
      }
    }
    return this.take(n);
  }

  async drain() {
    this.#buffer = Buffer.alloc(0);
    while (await this.#pull()) this.#buffer = Buffer.alloc(0);
  }

  async *chunks(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.#buffer.length === 0 && !(await this.#pull())) throw new TarError("Corrupt archive: unexpected end of data");
      const part = this.#buffer.subarray(0, Math.min(left, this.#buffer.length));
      this.#buffer = this.#buffer.subarray(part.length);
      left -= part.length;
      yield part;
    }
  }
}
