import { fromBase64, toBase64 } from "../encoding.ts";

export const MAX_FILE_SIZE = 10485760;
export const FILE_CHUNK_SIZE = 262144;
export const MAX_FILE_CHUNKS = 40;
/** Base64 length of one sealed chunk: 4 * ceil((29 + FILE_CHUNK_SIZE) / 3). */
export const MAX_FILE_BLOB_LENGTH = 349564;
/** Limit enforced when adding a file in the UI. */
export const MAX_ATTACHMENTS_PER_ENTRY = 20;
/** Limit enforced by the parser and the merge (an entry can exceed 20 after a merge). */
export const MAX_ATTACHMENTS_PARSED = 40;

/** Lowercase UUID v4, as produced by crypto.randomUUID(). */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const INVALID_ENTRY = "Invalid entry payload";
const SHA256_HEX = /^[0-9a-f]{64}$/;
// Name and MIME lengths are counted in UTF-16 code units, like String.length in TS and Kotlin.
const MAX_NAME_LENGTH = 255;
const MAX_MIME_LENGTH = 127;
// Control characters are exactly what these patterns look for.
/* eslint-disable no-control-regex */
const NAME_FORBIDDEN = /[/\\\u0000-\u001f\u007f-\u009f]/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/* eslint-enable no-control-regex */

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  chunks: number;
  sha256: string;
  key: string;
}

export function chunkCount(size: number): number {
  return Math.ceil(size / FILE_CHUNK_SIZE);
}

/** A copy with the fixed key order shared with the Kotlin core. */
export function attachmentJson(a: Attachment): Attachment {
  return { id: a.id, name: a.name, mime: a.mime, size: a.size, chunks: a.chunks, sha256: a.sha256, key: a.key };
}

export function canAddAttachment(count: number): boolean {
  return count < MAX_ATTACHMENTS_PER_ENTRY;
}

export function isAttachmentName(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH && !NAME_FORBIDDEN.test(name);
}

/** MIME rule shared by the parser and encryptFile: at most 127 UTF-16 units, no control characters. */
export function isAttachmentMime(mime: string): boolean {
  return mime.length <= MAX_MIME_LENGTH && !CONTROL.test(mime);
}

function fail(): never {
  throw new Error(INVALID_ENTRY);
}

function canonicalKey(key: string): boolean {
  try {
    const bytes = fromBase64(key);
    return bytes.length === 32 && toBase64(bytes) === key;
  } catch {
    return false;
  }
}

function parseAttachment(value: unknown): Attachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const o = value as Record<string, unknown>;
  const keys = ["id", "name", "mime", "size", "chunks", "sha256", "key"];
  const own = Object.keys(o);
  if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(o, k))) fail();
  const { id, name, mime, size, chunks, sha256, key } = o;
  if (typeof id !== "string" || !UUID_V4.test(id)) fail();
  if (typeof name !== "string" || !isAttachmentName(name)) fail();
  if (typeof mime !== "string" || !isAttachmentMime(mime)) fail();
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_FILE_SIZE) fail();
  if (chunks !== chunkCount(size)) fail();
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) fail();
  if (typeof key !== "string" || !canonicalKey(key)) fail();
  return { id, name, mime, size, chunks, sha256, key };
}

/** Validates a non-empty list of up to MAX_ATTACHMENTS_PARSED descriptors with unique ids; throws "Invalid entry payload". */
export function parseAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ATTACHMENTS_PARSED) fail();
  const list = value.map(parseAttachment);
  if (new Set(list.map((a) => a.id)).size !== list.length) fail();
  return list;
}
