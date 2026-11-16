// Generates test-vectors/files/files.json (file attachments). The Kotlin core must reproduce these values exactly.
// All randomness is replaced by fixed ids, keys, nonces and times, so two runs give an identical file.
// Run: npm run gen-vectors-files -w core
import { mkdirSync, writeFileSync } from "node:fs";
import { seal } from "../src/cipher.ts";
import { fromHex, toBase64, toHex, utf8 } from "../src/encoding.ts";
import {
  encryptFile,
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
} from "../src/files/index.ts";
import {
  entryAadV2,
  parseEntryData,
  serializeEntryData,
  type EntryDataV3,
  type Hlc,
} from "../src/p2p/index.ts";

const vaultKey = "5f9d1c3a7b2e4d6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
const nonceOf = (n: number) =>
  Array.from({ length: 12 }, (_, i) =>
    ((n * 16 + i + 1) & 0xff).toString(16).padStart(2, "0"),
  ).join("");
const keyOf = (n: number) =>
  Array.from({ length: 32 }, (_, i) => ((n * 32 + i) & 0xff).toString(16).padStart(2, "0")).join(
    "",
  );
const fileId = (n: number) =>
  `7c9e6679-7425-40de-944b-e07fc1f904${n.toString(16).padStart(2, "0")}`;
const entryId = (n: number) =>
  `3f2a8c1e-6b4d-4e9a-9c7f-1a2b3c4d5f${n.toString(16).padStart(2, "0")}`;
const hlc = (ms: number, c: number, d: string): Hlc => ({ ms, c, d });
const PATTERN = "byte[i] = (i * 31 + 7) & 0xff";

// --- files ---

async function fileVector(
  n: number,
  description: string,
  name: string,
  mime: string,
  bytes: Uint8Array,
  inline: boolean,
) {
  const id = fileId(n);
  const key = keyOf(n);
  const count = Math.ceil(bytes.length / FILE_CHUNK_SIZE);
  // File n uses nonces 2n+1.. (one per chunk; nonceOf wraps after 16); entries use 1 and 2, so all nonces differ.
  const nonces = Array.from({ length: count }, (_, i) => nonceOf(2 * n + 1 + i));
  const enc = await encryptFile(
    bytes,
    { name, mime },
    { id, key: fromHex(key), nonces: nonces.map(fromHex) },
  );
  return {
    description,
    id,
    key,
    nonces,
    name,
    mime,
    size: bytes.length,
    ...(inline ? { content: toHex(bytes) } : { contentRule: PATTERN }),
    aads: enc.blobs.map((_, i) => fileChunkAad(id, i, count)),
    attachment: enc.attachment,
    blobSha256: await Promise.all(enc.blobs.map((b) => sha256Hex(utf8(b)))),
    ...(inline ? { blobs: enc.blobs } : {}),
    lastBlob: enc.blobs.at(-1)!,
  };
}

const bigSize = FILE_CHUNK_SIZE + 1000;
const files = [
  await fileVector(
    1,
    "5-byte file, one chunk, full blobs",
    "notatka żółć.txt",
    "text/plain",
    utf8("Hello"),
    true,
  ),
  await fileVector(
    2,
    `${bigSize}-byte file, two chunks, content by rule`,
    "skan dowodu.jpg",
    "image/jpeg",
    Uint8Array.from({ length: bigSize }, (_, i) => (i * 31 + 7) & 0xff),
    false,
  ),
];
const [small, big] = files.map((f) => f.attachment) as [Attachment, Attachment];

// --- entries ---

const canon = (d: EntryDataV3) => JSON.parse(serializeEntryData(d)) as EntryDataV3;
const docEntry = (name: string, note: string, attachments: Attachment[], h: Hlc): EntryDataV3 =>
  canon({
    v: 3,
    type: "document",
    name,
    note,
    fields: {
      kind: "id_card",
      number: "ABC123456",
      fullName: "Jan Kowalski",
      issueDate: "2021-01-02",
      expiryDate: "2031-01-01",
      issuer: "Prezydent Miasta",
    },
    custom: [],
    attachments,
    hlc: h,
  } as EntryDataV3);

// Entries 1-2 use nonceOf(n); the accepted-descriptor entries use nonces with a 0xee prefix, so no nonce repeats.
const extraNonce = (n: number) => `ee${n.toString(16).padStart(2, "0")}${"00".repeat(10)}`;
// `rawPayload` replaces the stored text (e.g. a number written as 1.0); `payload` is then the raw text and
// `canonicalPayload` what serializeEntryData gives for the parsed value.
async function entry(
  n: number,
  description: string,
  data: EntryDataV3,
  merge?: { winner: string; loser: string; hlc: Hlc },
  opts: { nonce?: string; rawPayload?: string } = {},
) {
  const id = entryId(n);
  const nonce = opts.nonce ?? nonceOf(n);
  const canonical = serializeEntryData(data);
  const payload = opts.rawPayload ?? canonical;
  if (serializeEntryData(parseEntryData(JSON.parse(payload))) !== canonical)
    throw new Error(`parse mismatch: ${description}`);
  if (JSON.stringify(parseEntryData(JSON.parse(payload))) !== JSON.stringify(data))
    throw new Error(`parsed mismatch: ${description}`);
  return {
    description,
    vaultKey,
    id,
    nonce,
    payload,
    ...(opts.rawPayload !== undefined ? { canonicalPayload: canonical } : {}),
    parsed: data,
    blob: await seal(fromHex(vaultKey), utf8(payload), entryAadV2(id), fromHex(nonce)),
    ...(merge ? { merge } : {}),
  };
}

// Conflict on entry 2: the winner (higher HLC) has only the big file, the loser has both. The merging device
// stores {...winner, attachments: mergeAttachments(winner, loser), hlc: its next clock tick}.
const winner = docEntry("Dowód osobisty", "zwycięzca", [big], hlc(1793404800500, 0, "device-a"));
const loser = docEntry("Dowód", "przegrany", [small, big], hlc(1793404800400, 3, "device-b"));
const mergeHlc = hlc(1793404800600, 0, "device-c");
const merged = canon({
  ...winner,
  attachments: mergeAttachments(winner.attachments, loser.attachments),
  hlc: mergeHlc,
});

const INVALID_ENTRY = "Invalid entry payload";
const KEY = toBase64(new Uint8Array(32).fill(7));
const SHA = "a".repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const att = (n = 1, over: Partial<Attachment> = {}): Attachment => ({
  id: uuid(n),
  name: "a.txt",
  mime: "text/plain",
  size: 10,
  chunks: 1,
  sha256: SHA,
  key: KEY,
  ...over,
});
const base = canon({
  v: 3,
  type: "login",
  name: "n",
  note: "",
  fields: { username: "", password: "", totp: "", urls: [], androidApps: [] },
  custom: [],
  hlc: hlc(5, 1, "dev"),
} as EntryDataV3);
// attachments sits between custom and hlc, as in a real payload.
const withAtt = (attachments: unknown) => {
  const { hlc: h, ...rest } = base;
  return JSON.stringify({ ...rest, attachments, hlc: h });
};
const withAttData = (attachments: Attachment[]) => canon({ ...base, attachments } as EntryDataV3);
const entries = [
  await entry(
    1,
    "document with two attachments",
    docEntry("Dowód osobisty", "przód i tył", [small, big], hlc(1793404800000, 1, "device-a")),
  ),
  await entry(
    2,
    "entry after an attachment merge (winner's list, then the loser's missing ids)",
    merged,
    {
      winner: serializeEntryData(winner),
      loser: serializeEntryData(loser),
      hlc: mergeHlc,
    },
  ),
  await entry(
    3,
    "40 descriptors (MAX_ATTACHMENTS_PARSED)",
    withAttData(Array.from({ length: 40 }, (_, i) => att(i + 1))),
    undefined,
    { nonce: extraNonce(3) },
  ),
  await entry(
    4,
    "name of exactly 255 UTF-16 units containing a surrogate pair (U+1F600)",
    withAttData([att(1, { name: "\u{1F600}" + "a".repeat(253) })]),
    undefined,
    { nonce: extraNonce(4) },
  ),
  await entry(
    5,
    "empty mime and a mime of 127 characters",
    withAttData([att(1, { mime: "" }), att(2, { mime: "m".repeat(127) })]),
    undefined,
    { nonce: extraNonce(5) },
  ),
  await entry(
    6,
    "name containing U+00A0 (not a forbidden character)",
    withAttData([att(1, { name: "a\u00a0b.txt" })]),
    undefined,
    { nonce: extraNonce(6) },
  ),
  await entry(
    7,
    "size 10485760 (MAX_FILE_SIZE) with chunks 40",
    withAttData([att(1, { size: 10485760, chunks: 40 })]),
    undefined,
    { nonce: extraNonce(7) },
  ),
  await entry(
    8,
    "size written as 1.0 in the payload text: accepted as the integer 1 (payload is the raw text, canonicalPayload the canonical form)",
    withAttData([att(1, { size: 1, chunks: 1 })]),
    undefined,
    {
      nonce: extraNonce(8),
      rawPayload: serializeEntryData(withAttData([att(1, { size: 1, chunks: 1 })])).replace(
        '"size":1,',
        '"size":1.0,',
      ),
    },
  ),
];

// --- rejected descriptors (every case of test/files/attachment.test.ts) ---

const { key: _noKey, ...noKey } = att();
// Same 32 bytes as KEY, but the unused low bits of the last Base64 digit are set.
const nonCanonicalKey =
  KEY.slice(0, -2) + String.fromCharCode(KEY.charCodeAt(KEY.length - 2) + 1) + "=";

const rejectedCases: [string, unknown][] = [
  ["empty list", []],
  ["extra descriptor key", [{ ...att(), extra: 1 }]],
  ["missing key", [noKey]],
  ["size 0", [att(1, { size: 0 })]],
  ["size 10485761", [att(1, { size: 10485761 })]],
  ["size 1.5", [att(1, { size: 1.5 })]],
  ["chunks not ceil(size / CHUNK)", [att(1, { size: 262145, chunks: 1 })]],
  ["empty name", [att(1, { name: "" })]],
  ["name of 256 characters", [att(1, { name: "a".repeat(256) })]],
  ["name with slash", [att(1, { name: "a/b" })]],
  ["name with backslash", [att(1, { name: "a\\b" })]],
  ["name with U+0000", [att(1, { name: "a\u0000" })]],
  ["name with U+0085", [att(1, { name: "a\u0085" })]],
  ["mime of 128 characters", [att(1, { mime: "m".repeat(128) })]],
  ["sha256 of 63 characters", [att(1, { sha256: "a".repeat(63) })]],
  ["sha256 uppercase", [att(1, { sha256: "A".repeat(64) })]],
  ["key of 31 bytes", [att(1, { key: toBase64(new Uint8Array(31)) })]],
  ["key not canonical Base64", [att(1, { key: nonCanonicalKey })]],
  ["id uppercase", [att(1, { id: "0000000A-0000-4000-8000-00000000000B" })]],
  ["id not UUID v4", [att(1, { id: "00000000-0000-1000-8000-000000000001" })]],
  ["duplicate id", [att(1), att(1)]],
  ["41 descriptors", Array.from({ length: 41 }, (_, i) => att(i + 1))],
  ["mime with a control character", [att(1, { mime: "text/\nplain" })]],
  ["name with U+007F", [att(1, { name: "a\u007f" })]],
  ["name with U+009F", [att(1, { name: "a\u009f" })]],
  ["attachments is null", null],
  ["attachments is an empty object", {}],
  ["attachments is a string", "x"],
  ["descriptor is a string", ["x"]],
  ["descriptor is null", [null]],
  ["descriptor is an array", [[]]],
  ["size is a string", [att(1, { size: "10" as unknown as number })]],
  ["chunks is a string", [att(1, { chunks: "1" as unknown as number })]],
];

const rejected = rejectedCases.map(([description, attachments]) => {
  const payload = withAtt(attachments);
  let thrown = "";
  try {
    parseEntryData(JSON.parse(payload));
  } catch (e) {
    thrown = (e as Error).message;
  }
  if (thrown !== INVALID_ENTRY) throw new Error(`rejected case "${description}" threw "${thrown}"`);
  return { description, payload, error: INVALID_ENTRY };
});

// --- mergeAttachments ---

const [a1, a2, a3] = [
  att(1, { name: "f1.txt" }),
  att(2, { name: "f2.txt" }),
  att(3, { name: "f3.txt" }),
];
const renamed = att(2, { name: "renamed.txt" });
const merge = [
  {
    description: "winner's list, then the loser's missing ids in the loser's order",
    winner: [a1, a2],
    loser: [a2, a3],
  },
  { description: "missing winner list counts as empty", winner: null, loser: [a3] },
  {
    description: "same id on both sides: the winner's descriptor is kept",
    winner: [renamed],
    loser: [a2, a1],
  },
].map((m) => ({ ...m, expected: mergeAttachments(m.winner ?? undefined, m.loser) }));

// --- host (/p2p/v2/file) ---

const EPOCH = "epoch-1";
const NOW = 1793404800000;
const A = "123e4567-e89b-42d3-a456-426614174000";
const B = "223e4567-e89b-42d3-a456-426614174000";
const C = "323e4567-e89b-42d3-a456-426614174000";
const D = "423e4567-e89b-42d3-a456-426614174000";
const put = (id: string, index: number, chunks: number, blob: string, epoch = EPOCH) => ({
  op: "put",
  epoch,
  id,
  index,
  chunks,
  blob,
});
const get = (id: string, index: number, epoch = EPOCH) => ({ op: "get", epoch, id, index });
const status = (ids: string[], epoch = EPOCH) => ({ op: "status", epoch, ids });

type Expand = { field: "ids" | "blob"; repeat: string; count: number };
type StepIn = [description: string, request: unknown, expand?: Expand];

function steps(store: MemoryFileStore, list: StepIn[]) {
  return list.map(([description, request, expand]) => {
    const full = expand
      ? {
          ...(request as object),
          [expand.field]:
            expand.field === "ids"
              ? Array.from({ length: expand.count }, () => expand.repeat)
              : expand.repeat.repeat(expand.count),
        }
      : request;
    const reply = processP2pFile(store, EPOCH, full, NOW);
    return {
      description,
      request,
      ...(expand ? { expand } : {}),
      status: reply.status,
      body: reply.body,
    };
  });
}

const ok = put(A, 0, 2, "AAAA");
const hostSteps = steps(new MemoryFileStore(), [
  ["status of unknown ids", status([A, B])],
  ["put chunk 0 of 2", put(A, 0, 2, "AAAA")],
  ["status of a partial file", status([A, B])],
  ["put the same chunk again (no change)", put(A, 0, 2, "AAAA")],
  ["put a different blob for a stored chunk", put(A, 0, 2, "BBBB")],
  ["put with another chunk count", put(A, 1, 3, "CCCC")],
  [
    "put with another chunk count and a different blob for a stored chunk: 400 takes precedence over 409",
    put(A, 0, 3, "ZZZZ"),
  ],
  ["put chunk 1 of 2", put(A, 1, 2, "BBBB")],
  ["status of a complete file", status([A])],
  ["status answers a duplicate id once per occurrence", status([A, B, A])],
  ["get a stored chunk", get(A, 0)],
  ["get a chunk of an unknown file", get(B, 0)],
  ["get an index beyond the file's chunk count", get(A, 2)],
  ["status with another epoch", status([A], "other")],
  [
    "malformed request with another epoch: 400 (validation before the epoch check)",
    { ...put(A, -1, 2, "AAAA"), epoch: "other" },
  ],
  ["malformed unknown op with another epoch: 400", { op: "delete", epoch: "other" }],
  ["put with another epoch (nothing stored)", put(C, 0, 1, "AAAA", "other")],
  ["get with another epoch", get(A, 0, "other")],
  ["the put with another epoch stored nothing", status([C])],
  ["malformed: request is null", null],
  ["malformed: request is a string", "x"],
  ["malformed: unknown op", { ...ok, op: "delete" }],
  ["malformed: epoch is a number", { ...ok, epoch: 1 }],
  ["malformed: id not a UUID", { ...ok, id: "not-a-uuid" }],
  ["malformed: id uppercase", { ...ok, id: A.toUpperCase() }],
  ["malformed: index -1", { ...ok, index: -1 }],
  ["malformed: index equal to chunks", { ...ok, index: 2 }],
  ["malformed: index 0.5", { ...ok, index: 0.5 }],
  ["malformed: chunks 0", { ...ok, chunks: 0 }],
  ["malformed: chunks 41", { ...ok, chunks: 41 }],
  [
    "malformed: blob longer than MAX_FILE_BLOB_LENGTH",
    { ...put(D, 0, 1, "") },
    { field: "blob", repeat: "A", count: MAX_FILE_BLOB_LENGTH + 1 },
  ],
  ["malformed: blob is a number", { ...ok, blob: 5 }],
  ["malformed: get with a bad id", get("x", 0)],
  ["malformed: get without index", { op: "get", epoch: EPOCH, id: A }],
  ["malformed: get index 40", get(A, 40)],
  ["malformed: status with 501 ids", status([]), { field: "ids", repeat: A, count: 501 }],
  ["malformed: status with a bad id", status([A, "nope"])],
  ["malformed: status ids not a list", { op: "status", epoch: EPOCH, ids: "x" }],
  ["status with 500 ids (the limit)", status([]), { field: "ids", repeat: A, count: 500 }],
  [
    "put a blob of exactly MAX_FILE_BLOB_LENGTH",
    put(D, 0, 1, ""),
    { field: "blob", repeat: "A", count: MAX_FILE_BLOB_LENGTH },
  ],
]);

const CAPACITY = 10;
const storageSteps = steps(new MemoryFileStore(CAPACITY), [
  ["put 8 characters", put(A, 0, 2, "AAAAAAAA")],
  ["put 3 more characters (11 > 10): 507, nothing stored", put(A, 1, 2, "BBB")],
  ["the 507 put stored nothing", status([A])],
  ["re-put an identical chunk needs no space", put(A, 0, 2, "AAAAAAAA")],
  ["put 2 characters (exactly fills the store)", put(A, 1, 2, "BB")],
]);

const T0 = 1793404800000;
const orphanFiles = [
  { id: A, createdAt: T0, used: false },
  { id: B, createdAt: T0, used: true },
  { id: C, createdAt: T0 + 2, used: false },
];
const orphanStore = new MemoryFileStore();
for (const f of orphanFiles) orphanStore.put(f.id, 0, 1, "AAAA", f.createdAt);
const orphanUsed = new Set(orphanFiles.filter((f) => f.used).map((f) => f.id));
const orphanCases = [
  T0 + ORPHAN_FILE_AGE_MS,
  T0 + ORPHAN_FILE_AGE_MS + 1,
  T0 + ORPHAN_FILE_AGE_MS + 3,
].map((now) => ({
  now,
  expected: orphanFileIds(orphanStore, orphanUsed, now).sort(),
}));

const out = {
  format: "passholder-test-vectors",
  name: "files",
  version: 1,
  notes:
    "Chunk i of n: blob = seal(fileKey, plaintext[i*CHUNK, (i+1)*CHUNK), aad = passholder/v3/file/<id>/<i>/<n>), same blob format as entries " +
    "(Base64(0x01 || nonce(12) || ciphertext || tag(16)), AES-256-GCM). Keys and nonces are hex. blobSha256 is the SHA-256 (hex) of the UTF-8 " +
    "bytes of each Base64 blob string, not of the decoded bytes. A file with contentRule has no content: generate size bytes with " +
    "byte[i] = (i * 31 + 7) & 0xff. Entry payloads are compact JSON in canonical key order (attachments between custom and hlc, descriptor keys " +
    "id, name, mime, size, chunks, sha256, key). A merged entry is {...winner, attachments: mergeAttachments(winner, loser), hlc: merge.hlc}. " +
    "Host steps run in order against one fresh store with the given epoch and now; storage steps use a separate store of the given capacity " +
    "(sum of stored blob lengths). A step with expand has its request field replaced before sending: ids = count copies of repeat, blob = repeat " +
    "repeated count times. Orphan: each file is one chunk stored at createdAt; expected ids are sorted (order is not significant). " +
    "The host request is the decoded JSON value passed as-is (it may be null, a string or any non-object, which gives 400). Validation comes " +
    "first (400, even with another epoch), then the epoch check (200 {epoch}), then the operation; on put, 400 chunk count mismatch is " +
    "checked before 409 chunk differs. The main host store has unlimited capacity; only the storage steps use a limited one. status answers " +
    "a duplicated id once per occurrence. TS JSON parsing accepts 1.0 as the number 1, so Kotlin must treat 1.0 as the integer 1 for size, " +
    "chunks and index (entry 8 has size written as 1.0 in its raw payload; canonicalPayload is the re-serialized form). A descriptor's sha256 " +
    "is the SHA-256 of the plaintext file (before chunking and encryption). The entry AAD is passholder/v2/entry/<id>, as in v3.json. " +
    "Name and mime lengths count UTF-16 units; a name may contain U+00A0 but no C0 controls, U+007F-U+009F, / or \\.",
  limits: {
    MAX_FILE_SIZE,
    FILE_CHUNK_SIZE,
    MAX_FILE_CHUNKS,
    MAX_FILE_BLOB_LENGTH,
    MAX_ATTACHMENTS_PER_ENTRY,
    MAX_ATTACHMENTS_PARSED,
    ORPHAN_FILE_AGE_MS,
  },
  files,
  entries,
  rejected,
  merge,
  host: {
    epoch: EPOCH,
    now: NOW,
    steps: hostSteps,
    storage: {
      description: `store capacity ${CAPACITY} blob characters`,
      capacity: CAPACITY,
      steps: storageSteps,
    },
    orphan: {
      description: "unused files whose first chunk is older than ORPHAN_FILE_AGE_MS (strictly)",
      files: orphanFiles,
      cases: orphanCases,
    },
  },
};
const dir = new URL("../test-vectors/files/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("files.json", dir), JSON.stringify(out, null, 2) + "\n");
console.log(
  `test-vectors/files/files.json: ${files.length} files, ${entries.length} entries, ${rejected.length} rejected, ` +
    `${merge.length} merge, ${hostSteps.length + storageSteps.length} host steps`,
);
