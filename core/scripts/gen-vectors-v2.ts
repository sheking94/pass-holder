// Generates test-vectors/v2.json (P2P core). Every client (TypeScript, Kotlin) must reproduce these values exactly.
// All randomness is replaced by fixed keys and nonces. cpace and noiseKk only point at their own vector files.
// Run: npm run gen-vectors-v2 -w core
import { writeFileSync } from "node:fs";
import { seal } from "../src/cipher.ts";
import { fromBase64, fromHex, toHex, utf8 } from "../src/encoding.ts";
import {
  CipherState,
  compareHlc,
  encryptPayloadV2,
  entryAadV2,
  MAX_CHANGES_PER_REQUEST,
  MAX_CHANGES_PER_RESPONSE,
  MAX_FRAMES,
  MAX_FRAME_PLAINTEXT,
  pairingAad,
  pairingKey,
  sealPairingMessage,
  type Hlc,
  type PairingKind,
  type PairingRole,
  type TombstoneDataV2,
} from "../src/p2p/index.ts";
import { encryptFrames } from "../src/p2p/frames.ts";

const hlc = (ms: number, c: number, d: string): Hlc => ({ ms, c, d });

// Expected results are written by hand, not computed, so the vector can disagree with a broken compareHlc.
function hlcCase(description: string, a: Hlc, b: Hlc, expected: -1 | 0 | 1) {
  if (compareHlc(a, b) !== expected) throw new Error(`compareHlc disagrees with the expected result: ${description}`);
  return { description, a, b, expected };
}

const hlcCompare = [
  hlcCase("ms decides", hlc(1000, 9, "z"), hlc(1001, 0, "a"), -1),
  hlcCase("counter decides when ms is equal", hlc(1000, 1, "z"), hlc(1000, 2, "a"), -1),
  hlcCase("device id decides when ms and counter are equal", hlc(1000, 3, "device-a"), hlc(1000, 3, "device-b"), -1),
  hlcCase("equal clocks", hlc(1000, 3, "device-a"), hlc(1000, 3, "device-a"), 0),
  hlcCase(
    "d compared by UTF-16 code units, not code points: U+1F600 (surrogate D83D) sorts before U+FF5E",
    hlc(1000, 0, "\u{1F600}"),
    hlc(1000, 0, "～"),
    -1,
  ),
];

const vaultKey = "5f9d1c3a7b2e4d6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
const entryId = "3f2a8c1e-6b4d-4e9a-9c7f-1a2b3c4d5e6f";

// The old v2 live entry content (no "v"): kept as a vector so readers keep accepting it.
interface LegacyEntryData {
  name: string;
  username: string;
  password: string;
  hlc: Hlc;
}

async function entryVector(description: string, data: LegacyEntryData | TombstoneDataV2, nonceHex: string) {
  return {
    description,
    vaultKey,
    id: entryId,
    aad: entryAadV2(entryId),
    data,
    nonce: nonceHex,
    blob: "name" in data
      ? await seal(fromHex(vaultKey), utf8(JSON.stringify(data)), entryAadV2(entryId), fromHex(nonceHex))
      : await encryptPayloadV2(fromHex(vaultKey), entryId, data, fromHex(nonceHex)),
  };
}

const entryPayload = [
  await entryVector(
    "Live entry with non-ASCII text",
    { name: "example.com", username: "jan@example.com", password: "p@ss wörd!", hlc: hlc(1793404800000, 2, "device-a") },
    "0102030405060708090a0b0c",
  ),
  await entryVector("Tombstone", { hlc: hlc(1793404900000, 0, "device-b") }, "0c0b0a090807060504030201"),
];

const isk = "b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447";
const pairingKeys = [
  {
    description: "ISK_IR from the CPace draft vector (cpace-ristretto255.json) -> HKDF-SHA256, info passholder/v2/pair-key",
    isk,
    key: toHex(pairingKey(fromHex(isk))),
  },
];

const pairKey = toHex(pairingKey(fromHex(isk)));

async function pairingVector(
  description: string,
  kind: PairingKind,
  from: PairingRole,
  value: object,
  nonceHex: string,
) {
  return {
    description,
    key: pairKey,
    kind,
    from,
    value,
    aad: pairingAad(kind, from),
    nonce: nonceHex,
    blob: await sealPairingMessage(fromHex(pairKey), kind, from, value as never, fromHex(nonceHex)),
  };
}

const pairingMessage = [
  await pairingVector(
    "Device identity sent by the phone (responder)",
    "identity",
    "responder",
    { deviceId: "phone-1", name: "Pixel", staticPublicKey: "MOAwP9ZBHS+MDni5HyLoyu0PvkhlbPz3Z+SDT3Abj2I=" },
    "a0a1a2a3a4a5a6a7a8a9aaab",
  ),
  await pairingVector(
    "Device identity sent by the extension (initiator)",
    "identity",
    "initiator",
    { deviceId: "ext-1", name: "Chrome", staticPublicKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" },
    "c0c1c2c3c4c5c6c7c8c9cacb",
  ),
  await pairingVector(
    "Vault info sent by the phone (responder)",
    "vault-info",
    "responder",
    {
      epoch: "AAECAwQFBgcICQoLDA0ODw==",
      kdf: { alg: "argon2id", salt: "AAECAwQFBgcICQoLDA0ODw==", memoryKiB: 65536, iterations: 3, parallelism: 4 },
      wrappedVaultKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QA==",
      addresses: ["192.168.1.5:8443"],
    },
    "b0b1b2b3b4b5b6b7b8b9babb",
  ),
];

// A payload whose JSON text is exactly MAX_FRAME_PLAINTEXT + 10 bytes: a string of 65527 ASCII chars plus 2 quotes.
const payloadChar = "a";
const payloadStringLength = MAX_FRAME_PLAINTEXT + 10 - 2;
const cipherKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const frameList = await encryptFrames(new CipherState(fromHex(cipherKey)), payloadChar.repeat(payloadStringLength));
const frames = {
  MAX_FRAME_PLAINTEXT,
  MAX_FRAMES,
  cipherKey,
  payloadChar,
  payloadStringLength,
  plaintextLength: utf8(JSON.stringify(payloadChar.repeat(payloadStringLength))).length,
  chunkLengths: frameList.map((f) => fromBase64(f).length - 16),
};

const out = {
  format: "passholder-test-vectors",
  version: 2,
  hlcCompare,
  entryPayload,
  pairingKey: pairingKeys,
  cpace: { file: "cpace-ristretto255.json" },
  noiseKk: { file: "noise-kk.json" },
  pairingMessage,
  frames,
  paging: { MAX_CHANGES_PER_REQUEST, MAX_CHANGES_PER_RESPONSE },
};
writeFileSync(new URL("../test-vectors/v2.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("Wrote test-vectors/v2.json");
