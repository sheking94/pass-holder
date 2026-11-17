import { concatAll, fromBase64, fromUtf8, toBase64, utf8 } from "../encoding.ts";
import { MAX_MESSAGE, type CipherState } from "./noise.ts";
import { GCM_TAG_BYTES } from "../sizes.ts";

/** Noise transport message limit (65535) minus the 16-byte AEAD tag = 65519. */
export const MAX_FRAME_PLAINTEXT = MAX_MESSAGE - GCM_TAG_BYTES;
/** Most frames a 1 MiB body may legitimately carry. */
export const MAX_FRAMES = Math.ceil((1024 * 1024) / MAX_FRAME_PLAINTEXT) + 1;
const NO_AD = new Uint8Array();

/** Serializes a payload to JSON and encrypts it as ordered Noise frames (Base64). Strictly sequential. */
export async function encryptFrames(cipher: CipherState, payload: unknown): Promise<string[]> {
  const bytes = utf8(JSON.stringify(payload));
  const frames: string[] = [];
  for (let i = 0; i < bytes.length; i += MAX_FRAME_PLAINTEXT) {
    frames.push(toBase64(await cipher.encrypt(NO_AD, bytes.subarray(i, i + MAX_FRAME_PLAINTEXT))));
  }
  return frames;
}

/** Decrypts frames in order, concatenates them and parses the JSON. Throws on any failure. */
export async function decryptFrames(cipher: CipherState, frames: string[]): Promise<unknown> {
  const parts: Uint8Array[] = [];
  for (const frame of frames) parts.push(await cipher.decrypt(NO_AD, fromBase64(frame)));
  return JSON.parse(fromUtf8(concatAll(parts)));
}
