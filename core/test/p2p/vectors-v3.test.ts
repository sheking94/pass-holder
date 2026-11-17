import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seal } from "../../src/cipher.ts";
import { fromHex, utf8 } from "../../src/encoding.ts";
import {
  decryptPayload,
  entryAad,
  MAX_BLOB_BYTES_PER_ROUND,
  MAX_CHANGES_PER_REQUEST,
  MAX_CHANGES_PER_RESPONSE,
  MAX_ENTRY_BLOB_LENGTH,
  parseEntryData,
  parseTombstoneData,
  serializeEntryData,
} from "../../src/p2p/index.ts";

interface Vectors {
  format: string;
  version: number;
  notes: string;
  limits: {
    MAX_ENTRY_BLOB_LENGTH: number;
    MAX_BLOB_BYTES_PER_ROUND: number;
    MAX_CHANGES_PER_REQUEST: number;
    MAX_CHANGES_PER_RESPONSE: number;
  };
  entries: {
    description: string;
    vaultKey: string;
    id: string;
    nonce: string;
    deleted: boolean;
    payload: string;
    parsed: unknown;
    blob: string;
  }[];
  rejected: { description: string; deleted: boolean; payload: string; error: string }[];
  oldPaths: { status: number; body: { error: string } };
}

const v = JSON.parse(
  readFileSync(new URL("../../test-vectors/v3.json", import.meta.url), "utf8"),
) as Vectors;

describe("test-vectors/v3.json", () => {
  it("header and limits", () => {
    expect(v.format).toBe("passholder-test-vectors");
    expect(v.version).toBe(3);
    expect(v.limits).toEqual({
      MAX_ENTRY_BLOB_LENGTH,
      MAX_BLOB_BYTES_PER_ROUND,
      MAX_CHANGES_PER_REQUEST,
      MAX_CHANGES_PER_RESPONSE,
    });
    expect(v.oldPaths).toEqual({ status: 410, body: { error: "update required" } });
  });

  it("covers every entry type, legacy v2 and a tombstone, with distinct nonces", () => {
    const types = new Set(
      v.entries.map((e) => (e.parsed as { type?: string } | null)?.type ?? "tombstone"),
    );
    expect([...types].sort()).toEqual([
      "card",
      "contact",
      "document",
      "login",
      "note",
      "tombstone",
    ]);
    expect(v.entries.some((e) => !e.deleted && !e.payload.startsWith('{"v":3'))).toBe(true);
    expect(new Set(v.entries.map((e) => e.nonce)).size).toBe(v.entries.length);
  });

  for (const e of v.entries) {
    it(`entry: ${e.description}`, async () => {
      const key = fromHex(e.vaultKey);
      const data = e.deleted
        ? parseTombstoneData(JSON.parse(e.payload))
        : parseEntryData(JSON.parse(e.payload));
      if (e.deleted) {
        expect(e.parsed).toBeNull();
        expect(serializeEntryData(data)).toBe(e.payload);
      } else {
        expect(data).toEqual(e.parsed);
        if (e.payload.startsWith('{"v":3')) expect(serializeEntryData(data)).toBe(e.payload);
      }
      // The blob is the seal of the exact payload text.
      expect(await seal(key, utf8(e.payload), entryAad(e.id), fromHex(e.nonce))).toBe(e.blob);
      const opened = await decryptPayload(key, e.id, e.blob);
      expect(e.deleted ? parseTombstoneData(opened) : parseEntryData(opened)).toEqual(data);
    });
  }

  for (const r of v.rejected) {
    it(`rejected: ${r.description}`, () => {
      const value = JSON.parse(r.payload);
      expect(() => (r.deleted ? parseTombstoneData(value) : parseEntryData(value))).toThrow(
        r.error,
      );
    });
  }
});
