import { fromBase64, toBase64 } from "../encoding.ts";
import { hasExactKeys } from "../strict-json.ts";
import { SEAL_OVERHEAD_BYTES } from "../cipher.ts";
import { KEY_BYTES, KIB, MIB } from "../sizes.ts";

export const MAX_FILE_SIZE = 10 * MIB;
export const FILE_CHUNK_SIZE = 256 * KIB;
export const MAX_FILE_CHUNKS = MAX_FILE_SIZE / FILE_CHUNK_SIZE;
/** Base64 length of one sealed chunk: 4 * ceil((29 + FILE_CHUNK_SIZE) / 3) = 349564. */
export const MAX_FILE_BLOB_LENGTH = 4 * Math.ceil((SEAL_OVERHEAD_BYTES + FILE_CHUNK_SIZE) / 3);
/** Limit enforced when adding a file in the UI. */
export const MAX_ATTACHMENTS_PER_ENTRY = 20;
/** Limit enforced by the parser and the merge (an entry can exceed 20 after a merge). */
export const MAX_ATTACHMENTS_PARSED = 40;

/** Lowercase UUID v4, as produced by crypto.randomUUID(). */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Message of every error the entry and attachment parsers throw (shared with p2p/entry.ts). */
export const INVALID_ENTRY = "Invalid entry payload";
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
  return {
    id: a.id,
    name: a.name,
    mime: a.mime,
    size: a.size,
    chunks: a.chunks,
    sha256: a.sha256,
    key: a.key,
  };
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

/** Throws the parsers' INVALID_ENTRY error (shared with p2p/entry.ts). */
export function invalidEntry(): never {
  throw new Error(INVALID_ENTRY);
}

function canonicalKey(key: string): boolean {
  try {
    const bytes = fromBase64(key);
    return bytes.length === KEY_BYTES && toBase64(bytes) === key;
  } catch {
    return false;
  }
}

const ATTACHMENT_KEYS = ["id", "name", "mime", "size", "chunks", "sha256", "key"];

function parseAttachment(value: unknown): Attachment {
  if (!hasExactKeys(value, ATTACHMENT_KEYS)) invalidEntry();
  const { id, name, mime, size, chunks, sha256, key } = value;
  if (typeof id !== "string" || !UUID_V4.test(id)) invalidEntry();
  if (typeof name !== "string" || !isAttachmentName(name)) invalidEntry();
  if (typeof mime !== "string" || !isAttachmentMime(mime)) invalidEntry();
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_FILE_SIZE)
    invalidEntry();
  if (chunks !== chunkCount(size)) invalidEntry();
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) invalidEntry();
  if (typeof key !== "string" || !canonicalKey(key)) invalidEntry();
  return { id, name, mime, size, chunks, sha256, key };
}

/** Validates a non-empty list of up to MAX_ATTACHMENTS_PARSED descriptors with unique ids; throws "Invalid entry payload". */
export function parseAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ATTACHMENTS_PARSED)
    invalidEntry();
  const list = value.map(parseAttachment);
  if (new Set(list.map((a) => a.id)).size !== list.length) invalidEntry();
  return list;
}
