// Generates test-vectors/v3.json (entry payload v3). Every client (TypeScript, Kotlin) must reproduce these values exactly.
// All randomness is replaced by a fixed key and fixed, distinct nonces.
// Run: npm run gen-vectors-v3 -w core
import { writeFileSync } from "node:fs";
import { seal } from "../src/cipher.ts";
import { fromHex, utf8 } from "../src/encoding.ts";
import {
  entryAad,
  MAX_BLOB_BYTES_PER_ROUND,
  MAX_CHANGES_PER_REQUEST,
  MAX_CHANGES_PER_RESPONSE,
  MAX_ENTRY_BLOB_LENGTH,
  parseEntryData,
  parseTombstoneData,
  serializeEntryData,
  type EntryData,
  type Hlc,
} from "../src/p2p/index.ts";

const hlc = (ms: number, c: number, d: string): Hlc => ({ ms, c, d });

const vaultKey = "5f9d1c3a7b2e4d6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
const idOf = (n: number) => `3f2a8c1e-6b4d-4e9a-9c7f-1a2b3c4d5e${n.toString(16).padStart(2, "0")}`;
const nonceOf = (n: number) =>
  Array.from({ length: 12 }, (_, i) =>
    ((n * 16 + i + 1) & 0xff).toString(16).padStart(2, "0"),
  ).join("");

// Contains JSON-escape-sensitive characters (newline, tab, quote, backslash) and a non-BMP emoji.
const controls = "\r\b\f\u0001\u001f\u007f\u2028\u2029<>&'=";
const trickyNote = 'Linia 1\nLinia\t2 "cudzysłów" i \\ ukośnik; zażółć gęślą jaźń 🙂🔐 ' + controls;

const common = (n: number) => ({
  note: trickyNote,
  custom: [
    { label: 'PIN "awaryjny"', value: "12\\34\n🙂" + controls, hidden: true },
    { label: "Dział", value: "Źródło", hidden: false },
  ],
  hlc: hlc(1793404800000 + n, n, `device-${n}`),
});

const rawLogin: EntryData = {
  v: 3,
  type: "login",
  name: "Poczta żółć 🙂",
  ...common(1),
  fields: {
    username: "jan.kowalski@example.com",
    password: 'p@ss wörd!"\\\t',
    totp: "JBSWY3DPEHPK3PXP",
    urls: ["https://example.com/login", "https://mail.example.org"],
    androidApps: ["com.example.mail", "pl.example.app"],
  },
};
const rawContact: EntryData = {
  v: 3,
  type: "contact",
  name: "Anna Nowak",
  ...common(2),
  fields: {
    firstName: "Anna",
    lastName: "Nowak-Żółkiewska",
    birthDate: "1990-02-03",
    phones: [
      { label: "komórka", value: "+48 600 100 200" },
      { label: "dom", value: "+48 22 123 45 67" },
    ],
    emails: [
      { label: "praca", value: "anna@example.com" },
      { label: "prywatny", value: "anna@example.org" },
    ],
    addresses: [
      {
        label: "dom",
        street: "ul. Łąkowa 5/7",
        postalCode: "00-001",
        city: "Łódź",
        country: "Polska",
      },
      {
        label: "praca",
        street: "Main St 1",
        postalCode: "10001",
        city: "New York",
        country: "USA",
      },
    ],
  },
};
const rawCard: EntryData = {
  v: 3,
  type: "card",
  name: "Karta główna",
  ...common(3),
  fields: {
    holder: "JAN KOWALSKI",
    number: "4111111111111111",
    expiry: "01/30",
    cvc: "123",
    pin: "4321",
  },
};
const rawNote: EntryData = { v: 3, type: "note", name: "Notatka", ...common(4), fields: {} };
const rawDocument: EntryData = {
  v: 3,
  type: "document",
  name: "Paszport",
  ...common(5),
  fields: {
    kind: "passport",
    number: "AB1234567",
    fullName: "Jan Kowalski",
    issueDate: "2020-05-06",
    expiryDate: "2030-05-05",
    issuer: "Wojewoda Mazowiecki",
  },
};
// Canonical key order (v, type, name, note, fields, custom, hlc) for everything that ends up in the file.
const canon = (d: EntryData) => JSON.parse(serializeEntryData(d)) as EntryData;
const login = canon(rawLogin);
const contact = canon(rawContact);
const card = canon(rawCard);
const note = canon(rawNote);
const document = canon(rawDocument);
const legacyText = JSON.stringify({
  name: "example.com",
  username: "jan@example.com",
  password: "p@ss wörd!",
  hlc: hlc(1793404800000, 2, "device-a"),
});
const tombstone = { hlc: hlc(1793404900000, 0, "device-b") };

async function entry(
  n: number,
  description: string,
  deleted: boolean,
  payload: string,
  parsed: unknown,
) {
  const id = idOf(n);
  return {
    description,
    vaultKey,
    id,
    nonce: nonceOf(n),
    deleted,
    payload,
    parsed,
    blob: await seal(fromHex(vaultKey), utf8(payload), entryAad(id), fromHex(nonceOf(n))),
  };
}

const v3Entry = (n: number, description: string, data: EntryData) =>
  entry(n, description, false, serializeEntryData(data), data);

const entries = [
  await v3Entry(1, "login with every field filled, escapes and emoji", login),
  await v3Entry(2, "contact with every field filled", contact),
  await v3Entry(3, "card with every field filled", card),
  await v3Entry(4, "note (empty fields object)", note),
  await v3Entry(5, "document (passport) with every field filled", document),
  await entry(
    6,
    "legacy v2 entry (old key order, no v), read as a login",
    false,
    legacyText,
    canon(parseEntryData(JSON.parse(legacyText))),
  ),
  await entry(7, "tombstone", true, serializeEntryData(tombstone), null),
];
for (const e of entries) {
  // The generator must agree with the parsers before anything is written.
  const value = JSON.parse(e.payload);
  if (e.deleted) parseTombstoneData(value);
  else if (serializeEntryData(parseEntryData(value)) !== serializeEntryData(e.parsed as EntryData))
    throw new Error(`parse mismatch: ${e.description}`);
}

const clone = <T>(x: T): any => structuredClone(x);
const mutate = (make: () => any, f: (x: any) => void) => () => {
  const x = make();
  f(x);
  return x;
};
const legacy = () => JSON.parse(legacyText);
const INVALID_ENTRY = "Invalid entry payload";
const INVALID_TOMBSTONE = "Invalid tombstone payload";

const rejectedEntries: [string, () => unknown][] = [
  [
    "unknown type",
    mutate(
      () => clone(login),
      (x) => {
        x.type = "wifi";
      },
    ),
  ],
  [
    "v 2",
    mutate(
      () => clone(login),
      (x) => {
        x.v = 2;
      },
    ),
  ],
  [
    "v string",
    mutate(
      () => clone(login),
      (x) => {
        x.v = "3";
      },
    ),
  ],
  [
    "v fractional",
    mutate(
      () => clone(login),
      (x) => {
        x.v = 3.5;
      },
    ),
  ],
  [
    "missing totp",
    mutate(
      () => clone(login),
      (x) => {
        delete x.fields.totp;
      },
    ),
  ],
  [
    "urls number",
    mutate(
      () => clone(login),
      (x) => {
        x.fields.urls = [1];
      },
    ),
  ],
  [
    "hidden string",
    mutate(
      () => clone(login),
      (x) => {
        x.custom[0].hidden = "true";
      },
    ),
  ],
  [
    "extra top key",
    mutate(
      () => clone(login),
      (x) => {
        x.extra = 1;
      },
    ),
  ],
  [
    "extra fields key",
    mutate(
      () => clone(login),
      (x) => {
        x.fields.extra = 1;
      },
    ),
  ],
  [
    "extra custom key",
    mutate(
      () => clone(login),
      (x) => {
        x.custom[0].extra = 1;
      },
    ),
  ],
  [
    "extra address key",
    mutate(
      () => clone(contact),
      (x) => {
        x.fields.addresses[0].extra = 1;
      },
    ),
  ],
  [
    "note with fields",
    mutate(
      () => clone(note),
      (x) => {
        x.fields = { x: "" };
      },
    ),
  ],
  [
    "bad document kind",
    mutate(
      () => clone(document),
      (x) => {
        x.fields.kind = "visa";
      },
    ),
  ],
  [
    "v2 extra deleted",
    mutate(legacy, (x) => {
      x.deleted = true;
    }),
  ],
  [
    "hlc extra key",
    mutate(
      () => clone(login),
      (x) => {
        x.hlc.extra = 1;
      },
    ),
  ],
  [
    "hlc missing key",
    mutate(
      () => clone(login),
      (x) => {
        delete x.hlc.d;
        x.hlc.z = 1;
      },
    ),
  ],
  [
    "v2 hlc extra key",
    mutate(legacy, (x) => {
      x.hlc.extra = 1;
    }),
  ],
  [
    "v2 no password",
    mutate(legacy, (x) => {
      delete x.password;
    }),
  ],
];
const rejectedTombstones: [string, () => unknown][] = [
  ["tombstone with extra key name", () => ({ ...tombstone, name: "x" })],
  ["tombstone with extra key deleted", () => ({ ...tombstone, deleted: true })],
  [
    "tombstone hlc extra key",
    mutate(
      () => clone(tombstone),
      (x) => {
        x.hlc.extra = 1;
      },
    ),
  ],
  [
    "tombstone hlc missing key",
    mutate(
      () => clone(tombstone),
      (x) => {
        delete x.hlc.d;
        x.hlc.z = 1;
      },
    ),
  ],
];

function rejectedCase(description: string, deleted: boolean, make: () => unknown, error: string) {
  const payload = JSON.stringify(make());
  let thrown = "";
  try {
    if (deleted) parseTombstoneData(JSON.parse(payload));
    else parseEntryData(JSON.parse(payload));
  } catch (e) {
    thrown = (e as Error).message;
  }
  if (thrown !== error)
    throw new Error(`rejected case "${description}" threw "${thrown}", expected "${error}"`);
  return { description, deleted, payload, error };
}

const rejected = [
  ...rejectedEntries.map(([d, make]) => rejectedCase(d, false, make, INVALID_ENTRY)),
  ...rejectedTombstones.map(([d, make]) => rejectedCase(d, true, make, INVALID_TOMBSTONE)),
];

const out = {
  format: "passholder-test-vectors",
  version: 3,
  notes:
    "AAD is passholder/v2/entry/<id>; blob = Base64(0x01 || nonce(12) || ciphertext || tag(16)), AES-256-GCM; payload is the exact UTF-8 plaintext. Entry payloads are compact JSON in canonical key order, escaped as JS JSON.stringify does.",
  limits: {
    MAX_ENTRY_BLOB_LENGTH,
    MAX_BLOB_BYTES_PER_ROUND,
    MAX_CHANGES_PER_REQUEST,
    MAX_CHANGES_PER_RESPONSE,
  },
  entries,
  rejected,
  oldPaths: { status: 410, body: { error: "update required" } },
};
writeFileSync(
  new URL("../test-vectors/v3.json", import.meta.url),
  JSON.stringify(out, null, 2) + "\n",
);
console.log(`test-vectors/v3.json: ${entries.length} entries, ${rejected.length} rejected`);
