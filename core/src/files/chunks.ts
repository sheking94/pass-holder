import { concat, fromBase64, randomBytes, toBase64, toHex } from "../encoding.ts";
import { open, sealWithNonce } from "../cipher.ts";
import { PassHolderError } from "../errors.ts";
import {
  FILE_CHUNK_SIZE,
  MAX_FILE_SIZE,
  chunkCount,
  isAttachmentMime,
  isAttachmentName,
  type Attachment,
} from "./attachment.ts";
import { GCM_NONCE_BYTES, KEY_BYTES } from "../sizes.ts";

/** A file whose chunks do not match its descriptor (count, size, SHA-256 or AES-GCM). */
const corrupted = (cause?: unknown) =>
  new PassHolderError("FILE_CORRUPTED", "File is corrupted", { cause });

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

/** Id, key and one nonce per chunk of a file being encrypted. */
export interface FileSecrets {
  id: string;
  key: Uint8Array;
  nonces: Uint8Array[];
}

/** Encrypts a file with a random id, key and nonces. */
export async function encryptFile(
  bytes: Uint8Array,
  meta: { name: string; mime: string },
): Promise<EncryptedFile> {
  checkFileInput(bytes, meta.name);
  const chunks = chunkCount(bytes.length);
  const nonces = Array.from({ length: chunks }, () => randomBytes(GCM_NONCE_BYTES));
  return buildEncryptedFile(bytes, meta, {
    id: crypto.randomUUID(),
    key: randomBytes(KEY_BYTES),
    nonces,
  });
}

/**
 * `encryptFile` with fixed secrets, ONLY for test vectors and their generators. Never call it in production code:
 * reusing a nonce with the same key breaks AES-GCM (confidentiality and authenticity are lost).
 */
export async function encryptFileFixed(
  bytes: Uint8Array,
  meta: { name: string; mime: string },
  secrets: FileSecrets,
): Promise<EncryptedFile> {
  checkFileInput(bytes, meta.name);
  if (secrets.nonces.length !== chunkCount(bytes.length))
    throw new Error("Nonce count must equal chunk count");
  return buildEncryptedFile(bytes, meta, secrets);
}

function checkFileInput(bytes: Uint8Array, name: string): void {
  if (bytes.length === 0) throw new PassHolderError("FILE_EMPTY", "Empty file");
  if (bytes.length > MAX_FILE_SIZE) throw new PassHolderError("FILE_TOO_LARGE", "File too large");
  if (!isAttachmentName(name)) throw new PassHolderError("FILE_INVALID_NAME", "Invalid file name");
}

/** One chunk per nonce; the caller checked the input and the nonce count. */
async function buildEncryptedFile(
  bytes: Uint8Array,
  meta: { name: string; mime: string },
  { id, key, nonces }: FileSecrets,
): Promise<EncryptedFile> {
  const chunks = nonces.length;
  const blobs: string[] = [];
  for (let i = 0; i < chunks; i++) {
    const part = bytes.subarray(i * FILE_CHUNK_SIZE, (i + 1) * FILE_CHUNK_SIZE);
    blobs.push(await sealWithNonce(key, part, fileChunkAad(id, i, chunks), nonces[i]!));
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

export async function decryptChunk(
  a: Attachment,
  index: number,
  blob: string,
): Promise<Uint8Array> {
  if (!Number.isInteger(index) || index < 0 || index >= a.chunks) throw corrupted();
  try {
    return await open(fromBase64(a.key), blob, fileChunkAad(a.id, index, a.chunks));
  } catch (error) {
    throw corrupted(error);
  }
}

/** Decrypts all chunks; any mismatch in count, size, SHA-256 or AES-GCM throws code FILE_CORRUPTED. */
export async function decryptFile(a: Attachment, blobs: readonly string[]): Promise<Uint8Array> {
  if (blobs.length !== a.chunks || a.chunks !== chunkCount(a.size)) throw corrupted();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < blobs.length; i++) {
    const part = await decryptChunk(a, i, blobs[i]!);
    total += part.length;
    // Check the size before assembling so a bogus descriptor cannot force a huge allocation.
    if (total > a.size) throw corrupted();
    parts.push(part);
  }
  if (total !== a.size) throw corrupted();
  const bytes = concat(...parts);
  if ((await sha256Hex(bytes)) !== a.sha256) throw corrupted();
  return bytes;
}
