import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sealWithNonce } from "../../src/cipher.ts";
import { fromHex, utf8 } from "../../src/encoding.ts";
import {
  decryptFile,
  encryptFileFixed,
  fileChunkAad,
  FILE_CHUNK_SIZE,
  MAX_ATTACHMENTS_PARSED,
  MAX_ATTACHMENTS_PER_ENTRY,
  MAX_FILE_BLOB_LENGTH,
  MAX_FILE_CHUNKS,
  MAX_FILE_SIZE,
  MemoryFileStore,
  mergeAttachments,
  ORPHAN_FILE_AGE_MS,
  orphanFileIds,
  processP2pFile,
  sha256Hex,
  type Attachment,
} from "../../src/files/index.ts";
import { entryAad, parseEntryData, serializeEntryData, type Hlc } from "../../src/p2p/index.ts";

interface Expand {
  field: string;
  repeat: string;
  count: number;
}
interface HostStep {
  description: string;
  request: unknown;
  expand?: Expand;
  status: number;
  body: unknown;
}
interface Vectors {
  format: string;
  name: string;
  version: number;
  notes: string;
  limits: Record<string, number>;
  files: {
    description: string;
    id: string;
    key: string;
    nonces: string[];
    name: string;
    mime: string;
    size: number;
    content?: string;
    contentRule?: string;
    aads: string[];
    attachment: Attachment;
    blobSha256: string[];
    blobs?: string[];
    lastBlob: string;
  }[];
  entries: {
    description: string;
    vaultKey: string;
    id: string;
    nonce: string;
    payload: string;
    canonicalPayload?: string;
    parsed: unknown;
    blob: string;
    merge?: { winner: string; loser: string; hlc: Hlc };
  }[];
  rejected: { description: string; payload: string; error: string }[];
  merge: {
    description: string;
    winner: Attachment[] | null;
    loser: Attachment[] | null;
    expected: Attachment[];
  }[];
  host: {
    epoch: string;
    now: number;
    steps: HostStep[];
    storage: { description: string; capacity: number; steps: HostStep[] };
    orphan: {
      description: string;
      files: { id: string; createdAt: number; used: boolean }[];
      cases: { now: number; expected: string[] }[];
    };
  };
}

const v = JSON.parse(
  readFileSync(new URL("../../test-vectors/files/files.json", import.meta.url), "utf8"),
) as Vectors;

const patternBytes = (size: number) =>
  Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff);
const expand = (step: HostStep): unknown =>
  step.expand
    ? {
        ...(step.request as object),
        [step.expand.field]:
          step.expand.field === "ids"
            ? Array.from({ length: step.expand.count }, () => step.expand!.repeat)
            : step.expand.repeat.repeat(step.expand.count),
      }
    : step.request;

function runSteps(store: MemoryFileStore, steps: HostStep[]) {
  for (const s of steps) {
    expect(processP2pFile(store, v.host.epoch, expand(s), v.host.now), s.description).toEqual({
      status: s.status,
      body: s.body,
    });
  }
}

describe("test-vectors/files/files.json", () => {
  it("header and limits", () => {
    expect(v.format).toBe("passholder-test-vectors");
    expect(v.name).toBe("files");
    expect(v.version).toBe(1);
    expect(v.limits).toEqual({
      MAX_FILE_SIZE,
      FILE_CHUNK_SIZE,
      MAX_FILE_CHUNKS,
      MAX_FILE_BLOB_LENGTH,
      MAX_ATTACHMENTS_PER_ENTRY,
      MAX_ATTACHMENTS_PARSED,
      ORPHAN_FILE_AGE_MS,
    });
  });

  it("uses distinct nonces and covers a one-chunk and a two-chunk file", () => {
    const nonces = [...v.files.flatMap((f) => f.nonces), ...v.entries.map((e) => e.nonce)];
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(v.files.map((f) => f.attachment.chunks)).toEqual([1, 2]);
  });

  for (const f of v.files) {
    it(`file: ${f.description}`, async () => {
      const bytes = f.content !== undefined ? fromHex(f.content) : patternBytes(f.size);
      if (f.content === undefined) expect(f.contentRule).toBe("byte[i] = (i * 31 + 7) & 0xff");
      expect(bytes.length).toBe(f.size);
      const enc = await encryptFileFixed(
        bytes,
        { name: f.name, mime: f.mime },
        {
          id: f.id,
          key: fromHex(f.key),
          nonces: f.nonces.map(fromHex),
        },
      );
      expect(enc.attachment).toEqual(f.attachment);
      expect(f.aads).toEqual(enc.blobs.map((_, i) => fileChunkAad(f.id, i, enc.blobs.length)));
      expect(await Promise.all(enc.blobs.map((b) => sha256Hex(utf8(b))))).toEqual(f.blobSha256);
      if (f.blobs) expect(enc.blobs).toEqual(f.blobs);
      expect(enc.blobs.at(-1)).toBe(f.lastBlob);
      expect(await decryptFile(f.attachment, enc.blobs)).toEqual(bytes);
    });
  }

  for (const e of v.entries) {
    it(`entry: ${e.description}`, async () => {
      const data = parseEntryData(JSON.parse(e.payload));
      expect(data).toEqual(e.parsed);
      expect(serializeEntryData(data)).toBe(e.canonicalPayload ?? e.payload);
      expect(
        await sealWithNonce(fromHex(e.vaultKey), utf8(e.payload), entryAad(e.id), fromHex(e.nonce)),
      ).toBe(e.blob);
      if (e.merge) {
        const winner = parseEntryData(JSON.parse(e.merge.winner));
        const loser = parseEntryData(JSON.parse(e.merge.loser));
        const merged = {
          ...winner,
          attachments: mergeAttachments(winner.attachments, loser.attachments),
          hlc: e.merge.hlc,
        };
        expect(serializeEntryData(merged)).toBe(e.canonicalPayload ?? e.payload);
      }
    });
  }

  for (const r of v.rejected) {
    it(`rejected: ${r.description}`, () => {
      expect(r.error).toBe("Invalid entry payload");
      expect(() => parseEntryData(JSON.parse(r.payload))).toThrow(r.error);
    });
  }

  for (const m of v.merge) {
    it(`merge: ${m.description}`, () => {
      expect(mergeAttachments(m.winner ?? undefined, m.loser ?? undefined)).toEqual(m.expected);
    });
  }

  it("host: sequence on one store", () => {
    runSteps(new MemoryFileStore(), v.host.steps);
  });

  it("host: insufficient storage", () => {
    runSteps(new MemoryFileStore(v.host.storage.capacity), v.host.storage.steps);
  });

  it("host: orphan files", () => {
    const store = new MemoryFileStore();
    for (const f of v.host.orphan.files)
      store.put({ id: f.id, index: 0, chunks: 1, blob: "AAAA" }, f.createdAt);
    const used = new Set(v.host.orphan.files.filter((f) => f.used).map((f) => f.id));
    for (const c of v.host.orphan.cases)
      expect(orphanFileIds(store, used, c.now).sort(), String(c.now)).toEqual(c.expected);
  });
});
