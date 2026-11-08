import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromBase64, fromHex, toHex, utf8 } from "../../src/encoding.ts";
import {
  CipherState,
  compareHlc,
  decryptPayloadV2,
  encryptPayloadV2,
  entryAadV2,
  MAX_CHANGES_PER_REQUEST,
  MAX_CHANGES_PER_RESPONSE,
  MAX_FRAMES,
  MAX_FRAME_PLAINTEXT,
  openPairingMessage,
  parseEntryData,
  pairingAad,
  pairingKey,
  sealPairingMessage,
  type Hlc,
  type PairingKind,
  type PairingRole,
  type TombstoneDataV2,
} from "../../src/p2p/index.ts";
import { encryptFrames } from "../../src/p2p/frames.ts";

/** The v2 live entry content, still present in v2.json as the old format a v3 reader must accept. */
interface LegacyEntryData {
  name: string;
  username: string;
  password: string;
  hlc: Hlc;
}

interface Vectors {
  hlcCompare: { description: string; a: Hlc; b: Hlc; expected: -1 | 0 | 1 }[];
  entryPayload: {
    description: string;
    vaultKey: string;
    id: string;
    aad: string;
    data: LegacyEntryData | TombstoneDataV2;
    nonce: string;
    blob: string;
  }[];
  pairingKey: { description: string; isk: string; key: string }[];
  cpace: { file: string };
  noiseKk: { file: string };
  pairingMessage: {
    description: string;
    key: string;
    kind: PairingKind;
    from: PairingRole;
    value: unknown;
    aad: string;
    nonce: string;
    blob: string;
  }[];
  paging: { MAX_CHANGES_PER_REQUEST: number; MAX_CHANGES_PER_RESPONSE: number };
  frames: {
    MAX_FRAME_PLAINTEXT: number;
    MAX_FRAMES: number;
    cipherKey: string;
    payloadChar: string;
    payloadStringLength: number;
    plaintextLength: number;
    chunkLengths: number[];
  };
}

const dir = new URL("../../test-vectors/", import.meta.url);
const v = JSON.parse(readFileSync(new URL("v2.json", dir), "utf8")) as Vectors;

describe("test vectors v2", () => {
  for (const c of v.hlcCompare) {
    it(`hlcCompare: ${c.description}`, () => {
      expect(compareHlc(c.a, c.b)).toBe(c.expected);
      expect(compareHlc(c.b, c.a)).toBe(-c.expected === 0 ? 0 : -c.expected);
    });
  }

  for (const e of v.entryPayload) {
    it(`entryPayload: ${e.description}`, async () => {
      const key = fromHex(e.vaultKey);
      expect(entryAadV2(e.id)).toBe(e.aad);
      expect(await decryptPayloadV2(key, e.id, e.blob)).toEqual(e.data);
      if ("name" in e.data) {
        // Old v2 content: not written any more, but read as a login.
        const parsed = parseEntryData(await decryptPayloadV2(key, e.id, e.blob));
        expect(parsed).toMatchObject({
          v: 3, type: "login", name: e.data.name, note: "",
          fields: { username: e.data.username, password: e.data.password, totp: "", urls: [], androidApps: [] },
          custom: [], hlc: e.data.hlc,
        });
      } else {
        expect(await encryptPayloadV2(key, e.id, e.data, fromHex(e.nonce))).toBe(e.blob);
      }
    });
  }

  for (const p of v.pairingKey) {
    it(`pairingKey: ${p.description}`, () => {
      expect(toHex(pairingKey(fromHex(p.isk)))).toBe(p.key);
    });
  }

  for (const ref of [v.cpace, v.noiseKk]) {
    it(`reference file exists: ${ref.file}`, () => {
      expect(JSON.parse(readFileSync(new URL(ref.file, dir), "utf8"))).toBeTypeOf("object");
    });
  }

  for (const m of v.pairingMessage) {
    it(`pairingMessage: ${m.description}`, async () => {
      const key = fromHex(m.key);
      expect(pairingAad(m.kind, m.from)).toBe(m.aad);
      expect(await sealPairingMessage(key, m.kind, m.from, m.value as never, fromHex(m.nonce))).toBe(m.blob);
      expect(await openPairingMessage(key, m.kind, m.from, m.blob)).toEqual(m.value);
    });
  }

  it("paging: constants", () => {
    expect(v.paging).toEqual({ MAX_CHANGES_PER_REQUEST, MAX_CHANGES_PER_RESPONSE });
    expect(v.paging.MAX_CHANGES_PER_REQUEST).toBe(500);
    expect(v.paging.MAX_CHANGES_PER_RESPONSE).toBe(500);
  });

  it("frames: constants and chunking", async () => {
    expect(v.frames.MAX_FRAME_PLAINTEXT).toBe(MAX_FRAME_PLAINTEXT);
    expect(v.frames.MAX_FRAMES).toBe(MAX_FRAMES);
    const payload = v.frames.payloadChar.repeat(v.frames.payloadStringLength);
    expect(utf8(JSON.stringify(payload)).length).toBe(v.frames.plaintextLength);
    const frames = await encryptFrames(new CipherState(fromHex(v.frames.cipherKey)), payload);
    expect(frames.map((f) => fromBase64(f).length - 16)).toEqual(v.frames.chunkLengths);
  });
});
