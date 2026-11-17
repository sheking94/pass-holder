// A small ZIP writer and reader for the PassHolder archive. Deflate is done by the platform
// (CompressionStream / DecompressionStream "deflate-raw"). No ZIP64, encryption or multi-disk archives.

import { concatAll } from "../encoding.ts";
import { hasErrorCode, PassHolderError } from "../errors.ts";
import { KIB } from "../sizes.ts";

/** Most entries a readable archive may hold. */
const MAX_ZIP_ENTRIES = 5000;
/** Input slice fed to the inflater, so a zip bomb is stopped after a bounded amount of output. */
const INFLATE_SLICE = 16 * KIB;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const VERSION = 20;
/** Fixed parts of the records, without the variable-length name, extra field and comment. */
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  path: string;
  method: typeof METHOD_STORED | typeof METHOD_DEFLATE;
  compressedSize: number;
  size: number;
  crc: number;
  offset: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** True when the bytes start with a ZIP local file header ("PK\3\4"). */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/** Throws code ZIP_INVALID: the archive is damaged or uses a feature this reader does not support. */
function invalid(cause?: unknown): never {
  throw new PassHolderError("ZIP_INVALID", "ZIP archive is damaged or not supported", { cause });
}

const entryTooLarge = () => new PassHolderError("ZIP_ENTRY_TOO_LARGE", "ZIP entry too large");

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const writing = writer.write(bytes as BufferSource).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  await writing;
  return concatAll(chunks);
}

interface Pending {
  name: Uint8Array;
  method: typeof METHOD_STORED | typeof METHOD_DEFLATE;
  crc: number;
  size: number;
  data: Uint8Array;
}

/**
 * Builds an archive in memory. Each local header carries the sizes and CRC (no data descriptor); names are UTF-8
 * with flag bit 11. An entry is deflated, or stored when deflate does not make it smaller.
 */
export class ZipWriter {
  readonly #time: number;
  readonly #date: number;
  readonly #entries: Pending[] = [];

  /** The time is written from the date's UTC fields, so the same date gives the same bytes in every time zone. */
  constructor(date: Date = new Date()) {
    this.#time =
      (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    this.#date =
      (Math.max(0, date.getUTCFullYear() - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate();
  }

  /** Adds an entry after the ones added so far, or before all of them with `first`. */
  async add(path: string, bytes: Uint8Array, options: { first?: boolean } = {}): Promise<void> {
    const deflated = bytes.length === 0 ? bytes : await deflateRaw(bytes);
    const stored = deflated.length >= bytes.length;
    const entry: Pending = {
      name: new TextEncoder().encode(path),
      method: stored ? METHOD_STORED : METHOD_DEFLATE,
      crc: crc32(bytes),
      size: bytes.length,
      // A copy, so the caller may zero its plaintext as soon as add resolves.
      data: stored ? bytes.slice() : deflated,
    };
    if (options.first) this.#entries.unshift(entry);
    else this.#entries.push(entry);
  }

  /** The archive as parts for `new Blob(parts)`. */
  finish(): Uint8Array[] {
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    // Values the reader takes for ZIP64 markers (0xFFFF, 0xFFFFFFFF) are never written.
    const tooLarge = (): never => {
      throw new PassHolderError("ZIP_WRITE_TOO_LARGE", "ZIP too large");
    };
    if (this.#entries.length >= 0xffff) tooLarge();
    let offset = 0;
    for (const e of this.#entries) {
      if (offset >= 0xffffffff || e.size >= 0xffffffff || e.data.length >= 0xffffffff) tooLarge();
      const local = new Uint8Array(LOCAL_HEADER_SIZE + e.name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, LOCAL_SIG, true);
      this.#common(lv, 4, e);
      local.set(e.name, LOCAL_HEADER_SIZE);
      const record = new Uint8Array(CENTRAL_HEADER_SIZE + e.name.length);
      const cv = new DataView(record.buffer);
      cv.setUint32(0, CENTRAL_SIG, true);
      cv.setUint16(4, VERSION, true);
      this.#common(cv, 6, e);
      cv.setUint32(42, offset, true);
      record.set(e.name, CENTRAL_HEADER_SIZE);
      parts.push(local, e.data);
      central.push(record);
      offset += local.length + e.data.length;
    }
    const centralSize = central.reduce((n, c) => n + c.length, 0);
    if (offset >= 0xffffffff || centralSize >= 0xffffffff || offset + centralSize >= 0xffffffff)
      tooLarge();
    const end = new Uint8Array(END_RECORD_SIZE);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, END_SIG, true);
    ev.setUint16(8, this.#entries.length, true);
    ev.setUint16(10, this.#entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return [...parts, ...central, end];
  }

  /** Fields shared by the local and the central header, from "version needed" to the extra field length. */
  #common(v: DataView, at: number, e: Pending): void {
    v.setUint16(at, VERSION, true);
    v.setUint16(at + 2, FLAG_UTF8, true);
    v.setUint16(at + 4, e.method, true);
    v.setUint16(at + 6, this.#time, true);
    v.setUint16(at + 8, this.#date, true);
    v.setUint32(at + 10, e.crc, true);
    v.setUint32(at + 14, e.data.length, true);
    v.setUint32(at + 18, e.size, true);
    v.setUint16(at + 22, e.name.length, true);
    v.setUint16(at + 24, 0, true);
  }
}

function findEnd(bytes: Uint8Array, v: DataView): number {
  const last = bytes.length - END_RECORD_SIZE;
  for (let at = last; at >= 0 && at >= last - 0xffff; at--) {
    if (
      v.getUint32(at, true) === END_SIG &&
      at + END_RECORD_SIZE + v.getUint16(at + 20, true) === bytes.length
    )
      return at;
  }
  return invalid();
}

/**
 * Reads the central directory, which holds the sizes and CRC even for entries written with a data descriptor.
 * Throws code ZIP_INVALID for ZIP64, encryption, a method other than stored/deflate, several disks, a repeated name,
 * more than 5000 entries or broken structure.
 */
export function readZipIndex(bytes: Uint8Array): ZipEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(bytes, v);
  if (
    end >= ZIP64_LOCATOR_SIZE &&
    v.getUint32(end - ZIP64_LOCATOR_SIZE, true) === ZIP64_LOCATOR_SIG
  )
    invalid();
  const count = v.getUint16(end + 10, true);
  const size = v.getUint32(end + 12, true);
  const start = v.getUint32(end + 16, true);
  if (
    v.getUint16(end + 4, true) !== 0 ||
    v.getUint16(end + 6, true) !== 0 ||
    v.getUint16(end + 8, true) !== count
  )
    invalid();
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff || count > MAX_ZIP_ENTRIES)
    invalid();
  if (start + size > end) invalid();
  const names = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_HEADER_SIZE > start + size || v.getUint32(at, true) !== CENTRAL_SIG) invalid();
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const compressedSize = v.getUint32(at + 20, true);
    const entrySize = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const next =
      at +
      CENTRAL_HEADER_SIZE +
      nameLength +
      v.getUint16(at + 30, true) +
      v.getUint16(at + 32, true);
    const offset = v.getUint32(at + 42, true);
    if (
      flags & FLAG_ENCRYPTED ||
      (method !== METHOD_STORED && method !== METHOD_DEFLATE) ||
      v.getUint16(at + 34, true) !== 0
    )
      invalid();
    if (compressedSize === 0xffffffff || entrySize === 0xffffffff || offset === 0xffffffff)
      invalid();
    if (next > start + size || offset + LOCAL_HEADER_SIZE > start) invalid();
    let path: string;
    try {
      path = decoder.decode(
        bytes.subarray(at + CENTRAL_HEADER_SIZE, at + CENTRAL_HEADER_SIZE + nameLength),
      );
    } catch {
      return invalid();
    }
    if (names.has(path)) invalid();
    names.add(path);
    entries.push({ path, method, compressedSize, size: entrySize, crc, offset });
    at = next;
  }
  return entries;
}

/**
 * The entry's bytes, checked against the central directory's size and CRC (code ZIP_INVALID). Throws code ZIP_ENTRY_TOO_LARGE
 * when the declared size or the inflated output passes `maxSize`; inflating stops as soon as it does.
 */
export async function readZipEntry(
  bytes: Uint8Array,
  e: ZipEntry,
  maxSize: number,
): Promise<Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (e.offset + LOCAL_HEADER_SIZE > bytes.length || v.getUint32(e.offset, true) !== LOCAL_SIG)
    invalid();
  const dataStart =
    e.offset +
    LOCAL_HEADER_SIZE +
    v.getUint16(e.offset + 26, true) +
    v.getUint16(e.offset + 28, true);
  const dataEnd = dataStart + e.compressedSize;
  if (dataEnd > bytes.length) invalid();
  if (e.size > maxSize) throw entryTooLarge();
  const data = bytes.subarray(dataStart, dataEnd);
  let out: Uint8Array;
  if (e.method === METHOD_STORED) {
    if (e.compressedSize !== e.size) invalid();
    out = data.slice();
  } else {
    out = await inflateRaw(data, maxSize);
  }
  if (out.length !== e.size || crc32(out) !== e.crc) invalid();
  return out;
}

async function inflateRaw(data: Uint8Array, maxSize: number): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const writing = (async () => {
    for (let at = 0; at < data.length; at += INFLATE_SLICE) {
      await writer.write(
        data.subarray(at, Math.min(data.length, at + INFLATE_SLICE)) as BufferSource,
      );
    }
    await writer.close();
  })();
  writing.catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      total += r.value.length;
      if (total > maxSize) {
        await reader.cancel().catch(() => {});
        throw entryTooLarge();
      }
      chunks.push(r.value);
    }
    await writing;
  } catch (error) {
    if (hasErrorCode(error, "ZIP_ENTRY_TOO_LARGE")) throw error;
    invalid(error);
  }
  return concatAll(chunks);
}
