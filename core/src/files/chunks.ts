import { concat, fromBase64, randomBytes, toBase64, toHex } from "../encoding.ts";
import { open, seal } from "../cipher.ts";
import { FILE_CHUNK_SIZE, MAX_FILE_SIZE, chunkCount, isAttachmentMime, isAttachmentName, type Attachment } from "./attachment.ts";

export const FILE_TOO_LARGE = "File too large";
export const EMPTY_FILE = "Empty file";
export const INVALID_FILE_NAME = "Invalid file name";
export const FILE_CORRUPTED = "File is corrupted";

export interface EncryptedFile {
  attachment: Attachment;
  blobs: string[];
}

/** AAD binding a chunk to its file, position and total count. */
export function fileChunkAad(id: string, index: number, chunks: number): string {
  return `passholder/v3/file/${id}/${index}/${chunks}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

/** `fixed` (id, key, one nonce per chunk) exists only for test vectors; normally everything is random. */
export async function encryptFile(
  bytes: Uint8Array,
  meta: { name: string; mime: string },
  fixed?: { id: string; key: Uint8Array; nonces: Uint8Array[] },
): Promise<EncryptedFile> {
  if (bytes.length === 0) throw new Error(EMPTY_FILE);
  if (bytes.length > MAX_FILE_SIZE) throw new Error(FILE_TOO_LARGE);
  if (!isAttachmentName(meta.name)) throw new Error(INVALID_FILE_NAME);
  const id = fixed?.id ?? crypto.randomUUID();
  const key = fixed?.key ?? randomBytes(32);
  const chunks = chunkCount(bytes.length);
  if (fixed && fixed.nonces.length !== chunks) throw new Error("Nonce count must equal chunk count");
  const blobs: string[] = [];
  for (let i = 0; i < chunks; i++) {
    const part = bytes.subarray(i * FILE_CHUNK_SIZE, (i + 1) * FILE_CHUNK_SIZE);
    blobs.push(await seal(key, part, fileChunkAad(id, i, chunks), fixed?.nonces[i]));
  }
  const attachment: Attachment = {
    id,
    name: meta.name,
    // An unusable MIME type is normalized to "" (application/octet-stream) instead of failing.
    mime: isAttachmentMime(meta.mime) ? meta.mime : "",
    size: bytes.length,
    chunks,
    sha256: await sha256Hex(bytes),
    key: toBase64(key),
  };
  return { attachment, blobs };
}

export async function decryptChunk(a: Attachment, index: number, blob: string): Promise<Uint8Array> {
  if (!Number.isInteger(index) || index < 0 || index >= a.chunks) throw new Error(FILE_CORRUPTED);
  try {
    return await open(fromBase64(a.key), blob, fileChunkAad(a.id, index, a.chunks));
  } catch {
    throw new Error(FILE_CORRUPTED);
  }
}

/** Decrypts all chunks; any mismatch in count, size, SHA-256 or AES-GCM yields FILE_CORRUPTED. */
export async function decryptFile(a: Attachment, blobs: readonly string[]): Promise<Uint8Array> {
  if (blobs.length !== a.chunks || a.chunks !== chunkCount(a.size)) throw new Error(FILE_CORRUPTED);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < blobs.length; i++) {
    const part = await decryptChunk(a, i, blobs[i]!);
    total += part.length;
    // Check the size before assembling so a bogus descriptor cannot force a huge allocation.
    if (total > a.size) throw new Error(FILE_CORRUPTED);
    parts.push(part);
  }
  if (total !== a.size) throw new Error(FILE_CORRUPTED);
  const bytes = concat(...parts);
  if ((await sha256Hex(bytes)) !== a.sha256) throw new Error(FILE_CORRUPTED);
  return bytes;
}
