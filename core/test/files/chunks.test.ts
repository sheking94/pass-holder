import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "../../src/encoding.ts";
import {
  FILE_CHUNK_SIZE,
  MAX_FILE_SIZE,
  decryptChunk,
  decryptFile,
  encryptFile,
  fileChunkAad,
  sha256Hex,
} from "../../src/files/index.ts";

const meta = { name: "a.bin", mime: "application/octet-stream" };

function sample(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
}

describe("fileChunkAad", () => {
  it("builds the chunk AAD", () => {
    expect(fileChunkAad("x", 1, 3)).toBe("passholder/v3/file/x/1/3");
  });
});

describe("encryptFile / decryptFile", () => {
  it("splits into chunks and round-trips", async () => {
    const bytes = sample(FILE_CHUNK_SIZE * 2 + 5);
    const { attachment, blobs } = await encryptFile(bytes, meta);
    expect(blobs).toHaveLength(3);
    expect(attachment.chunks).toBe(3);
    expect(attachment.size).toBe(bytes.length);
    expect(attachment.sha256).toBe(await sha256Hex(bytes));
    expect((await decryptChunk(attachment, 2, blobs[2]!)).length).toBe(5);
    expect(await decryptFile(attachment, blobs)).toEqual(bytes);
  });

  it("uses one chunk for exactly FILE_CHUNK_SIZE bytes", async () => {
    const { attachment, blobs } = await encryptFile(sample(FILE_CHUNK_SIZE), meta);
    expect(blobs).toHaveLength(1);
    expect(attachment.chunks).toBe(1);
  });

  it("rejects empty, too large and badly named files", async () => {
    await expect(encryptFile(new Uint8Array(0), meta)).rejects.toThrow("Empty file");
    await expect(encryptFile(new Uint8Array(MAX_FILE_SIZE + 1), meta)).rejects.toThrow("File too large");
    await expect(encryptFile(sample(3), { name: "a/b", mime: "" })).rejects.toThrow("Invalid file name");
  });

  it("is deterministic with fixed id, key and nonces", async () => {
    const bytes = sample(FILE_CHUNK_SIZE + 1);
    const fixed = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      key: new Uint8Array(32).fill(9),
      nonces: [new Uint8Array(12).fill(1), new Uint8Array(12).fill(2)],
    };
    const a = await encryptFile(bytes, meta, fixed);
    const b = await encryptFile(bytes, meta, fixed);
    expect(a).toEqual(b);
    expect(a.attachment.id).toBe(fixed.id);
    expect(a.attachment.key).toBe(toBase64(fixed.key));
  });

  it("normalizes an invalid MIME type to an empty string", async () => {
    expect((await encryptFile(sample(3), { name: "a", mime: "a".repeat(128) })).attachment.mime).toBe("");
    expect((await encryptFile(sample(3), { name: "a", mime: "text/\u0007x" })).attachment.mime).toBe("");
    expect((await encryptFile(sample(3), { name: "a", mime: "a".repeat(127) })).attachment.mime).toBe("a".repeat(127));
  });

  it("rejects a fixed nonce list of the wrong length", async () => {
    const fixed = { id: "123e4567-e89b-42d3-a456-426614174000", key: new Uint8Array(32), nonces: [new Uint8Array(12)] };
    await expect(encryptFile(sample(FILE_CHUNK_SIZE + 1), meta, fixed)).rejects.toThrow("Nonce count");
  });

  it("detects tampering", async () => {
    const { attachment, blobs } = await encryptFile(sample(FILE_CHUNK_SIZE * 2 + 5), meta);
    // Same key, different id: only the AAD differs.
    const other = await encryptFile(sample(FILE_CHUNK_SIZE * 2 + 5), meta, {
      id: "123e4567-e89b-42d3-a456-426614174000",
      key: fromBase64(attachment.key),
      nonces: [1, 2, 3].map((n) => new Uint8Array(12).fill(n)),
    });
    const bad = "File is corrupted";
    await expect(decryptFile(attachment, [blobs[1]!, blobs[0]!, blobs[2]!])).rejects.toThrow(bad);
    await expect(decryptFile(attachment, blobs.slice(0, 2))).rejects.toThrow(bad);
    await expect(decryptFile(attachment, [blobs[0]!, blobs[1]!, other.blobs[2]!])).rejects.toThrow(bad);
    await expect(decryptFile({ ...attachment, sha256: "0".repeat(64) }, blobs)).rejects.toThrow(bad);
    await expect(decryptFile({ ...attachment, size: attachment.size - 1 }, blobs)).rejects.toThrow(bad);
    // Same key, id and index, but a different chunk count n in the AAD.
    await expect(decryptChunk({ ...attachment, chunks: 4 }, 0, blobs[0]!)).rejects.toThrow(bad);
    await expect(decryptChunk(attachment, 3, blobs[0]!)).rejects.toThrow(bad);
  });
});
