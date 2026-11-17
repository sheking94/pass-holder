import { withCode } from "../error-code.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Attachment } from "../../src/files/attachment.ts";
import type { EntryContent } from "../../src/p2p/entry.ts";
import {
  ARCHIVE_INDEX,
  archivePath,
  exportPassHolderZip,
  openPassHolderZip,
  parseArchiveIndex,
} from "../../src/transfer/index.ts";
import { ZipWriter, readZipEntry, readZipIndex } from "../../src/transfer/zip.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const date = new Date(Date.UTC(2026, 10, 13, 12, 0, 0));

function attachment(name: string, mime: string, bytes: Uint8Array, n: number): Attachment {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name,
    mime,
    size: bytes.length,
    chunks: 1,
    sha256: "0".repeat(64),
    key: "A".repeat(43) + "=",
  };
}

const photo = new Uint8Array(4096).map((_, i) => (i * 7) % 256);
const text = utf8("Zażółć gęślą jaźń\n".repeat(50));
const login: EntryContent = {
  type: "login",
  name: "Bank",
  note: "",
  custom: [],
  fields: {
    username: "jan",
    password: "tajne",
    totp: "",
    urls: ["https://bank.pl"],
    androidApps: [],
  },
  attachments: [
    attachment("a:b?.jpg", "image/jpeg", photo, 1),
    attachment("umowa.txt", "text/plain", text, 2),
  ],
};
const note: EntryContent = {
  type: "note",
  name: "Adres",
  note: "ul. Polna 1",
  custom: [],
  fields: {},
};
const contents = new Map<string, Uint8Array>([
  [login.attachments![0]!.id, photo],
  [login.attachments![1]!.id, text],
]);
const readAll = async (a: Attachment) => contents.get(a.id);

async function bytesOf(parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
}

async function zipOf(files: [string, string | Uint8Array][]): Promise<Uint8Array> {
  const w = new ZipWriter(date);
  for (const [path, body] of files) await w.add(path, typeof body === "string" ? utf8(body) : body);
  return bytesOf(w.finish());
}

/** Offsets of the central directory headers, in order. */
function centralHeaders(zip: Uint8Array): number[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: number[] = [];
  let at = v.getUint32(zip.length - 22 + 16, true);
  for (let i = v.getUint16(zip.length - 22 + 10, true); i > 0; i--) {
    out.push(at);
    at += 46 + v.getUint16(at + 28, true) + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

const index = (entries: unknown[]) => JSON.stringify({ format: "passholder", version: 3, entries });
const bare = ({ attachments: _a, ...rest }: EntryContent) => rest as EntryContent;

describe("archivePath", () => {
  it("numbers the file and replaces characters Windows refuses", () => {
    expect(archivePath(1, "a:b?.jpg")).toBe("files/1-a_b_.jpg");
    expect(archivePath(12, '<x>|"y"*.txt')).toBe("files/12-_x___y__.txt");
    expect(archivePath(3, "Zażółć.pdf")).toBe("files/3-Zażółć.pdf");
  });
});

describe("exportPassHolderZip", () => {
  it("writes passholder.json first, then the files under numbered paths", async () => {
    const { parts, files, missing } = await exportPassHolderZip([note, login], readAll, date);
    expect([files, missing]).toEqual([2, 0]);
    const zip = await bytesOf(parts);
    const entries = readZipIndex(zip);
    expect(entries.map((e) => e.path)).toEqual([
      ARCHIVE_INDEX,
      "files/1-a_b_.jpg",
      "files/2-umowa.txt",
    ]);
    const json = JSON.parse(
      new TextDecoder().decode(await readZipEntry(zip, entries[0]!, 1 << 20)),
    );
    expect(json.format).toBe("passholder");
    expect(json.version).toBe(3);
    expect(json.entries.map((e: EntryContent) => e.name)).toEqual(["Adres", "Bank"]);
    expect(json.entries[0].attachments).toBeUndefined();
    expect(json.entries[1].attachments).toEqual([
      { name: "a:b?.jpg", mime: "image/jpeg", size: photo.length, path: "files/1-a_b_.jpg" },
      { name: "umowa.txt", mime: "text/plain", size: text.length, path: "files/2-umowa.txt" },
    ]);
    for (const a of json.entries[1].attachments)
      expect(Object.keys(a)).toEqual(["name", "mime", "size", "path"]);
    expect(await readZipEntry(zip, entries[1]!, 1 << 20)).toEqual(photo);
  });

  it("leaves out a file it cannot read and counts it as missing", async () => {
    const readSome = async (a: Attachment) =>
      a.name === "umowa.txt" ? undefined : contents.get(a.id);
    const { parts, files, missing } = await exportPassHolderZip([login], readSome, date);
    expect([files, missing]).toEqual([1, 1]);
    const { parsed } = await openPassHolderZip(await bytesOf(parts));
    expect(parsed.entries[0]!.files.map((f) => f.name)).toEqual(["a:b?.jpg"]);
  });

  it("writes no attachments key when none of the entry's files could be read", async () => {
    const { parts, missing } = await exportPassHolderZip([login], async () => undefined, date);
    expect(missing).toBe(2);
    const { parsed } = await openPassHolderZip(await bytesOf(parts));
    expect(parsed).toEqual({
      entries: [{ content: bare(login), files: [], position: 1 }],
      skipped: [],
    });
    expect(readZipIndex(await bytesOf(parts)).map((e) => e.path)).toEqual([ARCHIVE_INDEX]);
  });
});

describe("openPassHolderZip", () => {
  it("returns the exported contents and the same file bytes", async () => {
    const { parts } = await exportPassHolderZip([login, note], readAll, date);
    const { parsed, readFile } = await openPassHolderZip(await bytesOf(parts));
    expect(parsed.skipped).toEqual([]);
    expect(parsed.entries.map((e) => e.content)).toEqual([bare(note), bare(login)]);
    const files = parsed.entries[1]!.files;
    expect(await readFile(files[0]!)).toEqual(photo);
    expect(await readFile(files[1]!)).toEqual(text);
  });

  it("refuses an archive without passholder.json", async () => {
    await expect(openPassHolderZip(await zipOf([["notes.txt", "x"]]))).rejects.toThrow(
      withCode("ZIP_NOT_PASSHOLDER"),
    );
  });

  it("refuses an archive whose passholder.json is not a PassHolder file", async () => {
    await expect(
      openPassHolderZip(await zipOf([[ARCHIVE_INDEX, '{"format":"other"}']])),
    ).rejects.toThrow(withCode("ZIP_NOT_PASSHOLDER"));
  });

  it("explains a file it cannot give back", async () => {
    const entry = {
      ...bare(note),
      attachments: [
        { name: "brak.txt", mime: "text/plain", size: 3, path: "files/1-brak.txt" },
        { name: "rozmiar.txt", mime: "text/plain", size: 5, path: "files/2-rozmiar.txt" },
      ],
    };
    const zip = await zipOf([
      [ARCHIVE_INDEX, index([entry])],
      ["files/2-rozmiar.txt", "abc"],
    ]);
    const { parsed, readFile } = await openPassHolderZip(zip);
    const [missing, wrongSize] = parsed.entries[0]!.files;
    await expect(readFile(missing!)).rejects.toThrow(withCode("ARCHIVE_FILE_MISSING"));
    await expect(readFile(wrongSize!)).rejects.toThrow(withCode("ARCHIVE_FILE_SIZE_MISMATCH"));
  });

  it("refuses a file that inflates past the size limit and one with a bad CRC", async () => {
    const entry = {
      ...bare(note),
      attachments: [
        { name: "bomb.bin", mime: "", size: 1000, path: "files/1-bomb.bin" },
        { name: "crc.txt", mime: "", size: 5, path: "files/2-crc.txt" },
      ],
    };
    const zip = await zipOf([
      [ARCHIVE_INDEX, index([entry])],
      ["files/1-bomb.bin", new Uint8Array(11 * 1024 * 1024)],
      ["files/2-crc.txt", "hello"],
    ]);
    const v = new DataView(zip.buffer);
    const [, bomb, crc] = centralHeaders(zip);
    v.setUint32(bomb! + 24, 1000, true);
    v.setUint32(crc! + 16, v.getUint32(crc! + 16, true) ^ 1, true);
    const { parsed, readFile } = await openPassHolderZip(zip);
    const [big, bad] = parsed.entries[0]!.files;
    await expect(readFile(big!)).rejects.toThrow(withCode("ARCHIVE_FILE_TOO_LARGE"));
    await expect(readFile(bad!)).rejects.toThrow(withCode("ARCHIVE_FILE_CORRUPTED"));
  });

  // archive-kotlin.passholder.zip is the same export written by the Android core (java.util.zip: deflated entries
  // with data descriptors), so both must read back as archive.expected.json.
  it.each(["archive.passholder.zip", "archive-kotlin.passholder.zip"])(
    "reads the shared archive fixture %s",
    async (name) => {
      const dir = new URL("../../test-vectors/transfer/", import.meta.url);
      const zip = new Uint8Array(readFileSync(new URL(name, dir)));
      // The first local header's flags: bit 3 (data descriptor) is set only by java.util.zip.
      expect(zip[6]! & 8).toBe(name.includes("kotlin") ? 8 : 0);
      const expected = JSON.parse(readFileSync(new URL("archive.expected.json", dir), "utf8"));
      const { parsed, readFile } = await openPassHolderZip(zip);
      const actual = [];
      for (const e of parsed.entries) {
        const files = [];
        for (const f of e.files)
          files.push({
            ...f,
            sha256: createHash("sha256")
              .update(await readFile(f))
              .digest("hex"),
          });
        actual.push({ content: e.content, files, position: e.position });
      }
      expect({ entries: actual, skipped: parsed.skipped }).toEqual(expected);
    },
  );
});

describe("parseArchiveIndex", () => {
  const file = { name: "a.txt", mime: "text/plain", size: 3, path: "files/1-a.txt" };

  it("keeps entries with and without files", () => {
    expect(parseArchiveIndex(index([{ ...bare(note), attachments: [file] }, bare(login)]))).toEqual(
      {
        entries: [
          { content: bare(note), files: [file], position: 1 },
          { content: bare(login), files: [], position: 2 },
        ],
        skipped: [],
      },
    );
  });

  it('skips an entry with a bad file description as "zły format wpisu"', () => {
    const bad = (attachments: unknown) => ({ ...bare(note), attachments });
    const r = parseArchiveIndex(
      index([
        bad([{ ...file, key: "x" }]),
        bad(Array.from({ length: 41 }, (_, i) => ({ ...file, path: `files/${i + 1}-a.txt` }))),
        bad([]),
        bad([{ ...file, size: 0 }]),
        bad([{ ...file, name: "a/b" }]),
        bad([{ ...file, path: "" }]),
        bad(Array.from({ length: 40 }, (_, i) => ({ ...file, path: `files/${i + 1}-a.txt` }))),
      ]),
    );
    expect(r.skipped).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => ({ at: `wpis ${n}`, reason: "zły format wpisu" })),
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.files).toHaveLength(40);
  });

  it("gives each entry its position in the index, counting skipped entries", () => {
    const r = parseArchiveIndex(
      index([
        { ...bare(note), attachments: [{ ...file, key: "x" }] },
        bare(login),
        { ...bare(note), attachments: [file] },
      ]),
    );
    expect(r.skipped).toEqual([{ at: "wpis 1", reason: "zły format wpisu" }]);
    expect(r.entries.map((e) => e.position)).toEqual([2, 3]);
  });

  it("skips a later entry that describes a path already described", () => {
    const other = { ...file, path: "files/2-b.txt" };
    const r = parseArchiveIndex(
      index([
        { ...bare(note), attachments: [file] },
        { ...bare(login), attachments: [other, file] },
        { ...bare(note), name: "Dwa razy", attachments: [other, other] },
        { ...bare(note), name: "Drugi", attachments: [other] },
      ]),
    );
    expect(r.skipped).toEqual([2, 3].map((n) => ({ at: `wpis ${n}`, reason: "zły format wpisu" })));
    expect(r.entries.map((e) => [e.position, e.files.map((f) => f.path)])).toEqual([
      [1, [file.path]],
      [4, [other.path]],
    ]);
  });

  it("follows the PassHolder JSON rules for the rest", () => {
    expect(parseArchiveIndex(index([{ ...bare(note), name: " " }])).skipped).toEqual([
      { at: "wpis 1", reason: "brak nazwy" },
    ]);
    expect(() => parseArchiveIndex("{")).toThrow(withCode("IMPORT_NOT_PASSHOLDER"));
  });
});
