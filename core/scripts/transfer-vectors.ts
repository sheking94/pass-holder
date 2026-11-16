// Generates export, sort and archive vectors in test-vectors/transfer/ (shared with the Kotlin port).
// Run: node --experimental-strip-types core/scripts/transfer-vectors.ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Attachment } from "../src/files/attachment.ts";
import type { EntryContentV3 } from "../src/p2p/entry.ts";
import { exportFile, exportPassHolderZip, openPassHolderZip } from "../src/transfer/index.ts";

const dir = new URL("../test-vectors/transfer/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, dir), "utf8");
const write = (name: string, data: string | Uint8Array): void =>
  writeFileSync(new URL(name, dir), data);

const entries = [
  ...JSON.parse(read("passholder.expected.json")).entries,
  ...JSON.parse(read("bitwarden.expected.json")).entries,
];
write("export.passholder.json", exportFile("passholder", entries));
write("export.bitwarden.json", exportFile("bitwarden", entries));
write("export.nordpass.csv", exportFile("nordpass", entries));

const names = [
  "żaba",
  "Zebra",
  "zebra",
  "Źdźbło",
  "Łódź",
  "lody",
  "Lody",
  "ćma",
  "Cma",
  "cma",
  "Ąbc",
  "abc",
  "Abc",
  "Ślimak",
  "sok",
  "Ósemka",
  "osa",
  "Ńa",
  "na",
  "10 kotów",
  "2 koty",
  "Konto (stare)",
  "Konto-nowe",
  "konto_x",
  " spacja",
  "Ęka",
  "ewa",
  "résumé",
  "resume",
  "Résumé",
  "café",
  "cafe",
];
const sorted = [...names].sort((a, b) => a.localeCompare(b, "pl"));
write("sort.json", JSON.stringify({ names, sorted }, null, 2) + "\n");

// Archive: two entries, one with a deflated text file and a stored (incompressible) file whose name needs a safe path.
const text = new TextEncoder().encode("Zażółć gęślą jaźń\n".repeat(200));
const photo = new Uint8Array(3000);
for (let i = 0, x = 1; i < photo.length; i++) {
  x = (x * 1103515245 + 12345) >>> 0;
  photo[i] = x >>> 24;
}
const bodies = new Map([
  ["Zażółć ?.txt", text],
  ["a:b?.jpg", photo],
]);
const descriptor = (name: string, mime: string, n: number): Attachment => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  name,
  mime,
  size: bodies.get(name)!.length,
  chunks: 1,
  sha256: createHash("sha256").update(bodies.get(name)!).digest("hex"),
  key: "A".repeat(43) + "=",
});
const archived: EntryContentV3[] = [
  {
    type: "login",
    name: "Bank",
    note: "Pliki w archiwum",
    custom: [],
    fields: {
      username: "jan",
      password: "tajne hasło",
      totp: "",
      urls: ["https://bank.example"],
      androidApps: [],
    },
    attachments: [
      descriptor("Zażółć ?.txt", "text/plain", 1),
      descriptor("a:b?.jpg", "image/jpeg", 2),
    ],
  },
  { type: "note", name: "Adres", note: "ul. Polna 1", custom: [], fields: {} },
];
const { parts } = await exportPassHolderZip(
  archived,
  async (a) => bodies.get(a.name),
  new Date(Date.UTC(2026, 10, 13, 12, 0, 0)),
);
const zip = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
write("archive.passholder.zip", zip);
const { parsed, readFile } = await openPassHolderZip(zip);
const expectedEntries = [];
for (const e of parsed.entries) {
  const files = [];
  for (const f of e.files)
    files.push({
      ...f,
      sha256: createHash("sha256")
        .update(await readFile(f))
        .digest("hex"),
    });
  expectedEntries.push({ content: e.content, files, position: e.position });
}
write(
  "archive.expected.json",
  JSON.stringify({ entries: expectedEntries, skipped: parsed.skipped }, null, 2) + "\n",
);
