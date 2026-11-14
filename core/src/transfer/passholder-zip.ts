// PassHolder ZIP: passholder.json (a PassHolder JSON v3 index whose entries describe their files) followed by the
// decrypted files under files/<n>-<name>. Paths from an archive are only used to look entries up in the ZIP.
import { MAX_FILE_SIZE, type Attachment } from "../files/attachment.ts";
import type { EntryContentV3 } from "../p2p/entry.ts";
import { sortForExport } from "./common.ts";
import { parseArchiveIndex, type ArchivedFile, type ParsedArchive } from "./passholder-json.ts";
import { ZIP_ENTRY_TOO_LARGE, ZIP_INVALID, ZipWriter, readZipEntry, readZipIndex, type ZipEntry } from "./zip.ts";

export const MAX_ZIP_BYTES = 268435456;
export const ARCHIVE_INDEX = "passholder.json";
export const NOT_ARCHIVE = "Archiwum nie jest eksportem PassHolder";

const ZIP_TOO_LARGE = "Plik jest za duży (limit 256 MiB)";
/** Largest passholder.json accepted, after inflating. */
const MAX_INDEX_BYTES = 10485760;

/** Path of the n-th exported file (from 1); characters Windows refuses in file names become "_". */
export function archivePath(n: number, name: string): string {
  return `files/${n}-${name.replace(/[<>:"|?*]/g, "_")}`;
}

/**
 * Writes the entries (sorted as in the JSON export) and their files. `readFile` gives a file's decrypted bytes, or
 * undefined when the file is not available (waiting for sync, damaged): it is then left out and counted in `missing`.
 */
export async function exportPassHolderZip(
  entries: readonly EntryContentV3[],
  readFile: (a: Attachment) => Promise<Uint8Array | undefined>,
  date?: Date,
): Promise<{ parts: Uint8Array[]; files: number; missing: number }> {
  const zip = new ZipWriter(date);
  const index: EntryContentV3[] = [];
  let files = 0;
  let missing = 0;
  for (const { attachments, ...content } of sortForExport(entries)) {
    const described: ArchivedFile[] = [];
    for (const a of attachments ?? []) {
      const bytes = await readFile(a);
      if (bytes === undefined) {
        missing++;
        continue;
      }
      const path = archivePath(++files, a.name);
      await zip.add(path, bytes);
      described.push({ name: a.name, mime: a.mime, size: bytes.length, path });
    }
    index.push((described.length > 0 ? { ...content, attachments: described } : content) as EntryContentV3);
  }
  const json = JSON.stringify({ format: "passholder", version: 3, entries: index }, null, 2) + "\n";
  // The index is written first, so a reader that streams the archive (the phone) meets it before the files.
  await zip.add(ARCHIVE_INDEX, new TextEncoder().encode(json), { first: true });
  return { parts: zip.finish(), files, missing };
}

/**
 * Reads the index of a PassHolder ZIP held in memory. `readFile` gives a described file's bytes or throws an Error
 * with the Polish reason: "brak w archiwum", "inny rozmiar niż w opisie", "za duży" or "uszkodzony".
 */
export async function openPassHolderZip(
  bytes: Uint8Array,
): Promise<{ parsed: ParsedArchive; readFile(f: ArchivedFile): Promise<Uint8Array> }> {
  if (bytes.length > MAX_ZIP_BYTES) throw new Error(ZIP_TOO_LARGE);
  const byPath = new Map<string, ZipEntry>(readZipIndex(bytes).map((e) => [e.path, e]));
  const indexEntry = byPath.get(ARCHIVE_INDEX);
  if (indexEntry === undefined) throw new Error(NOT_ARCHIVE);
  let parsed: ParsedArchive;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await readZipEntry(bytes, indexEntry, MAX_INDEX_BYTES));
    parsed = parseArchiveIndex(text);
  } catch (err) {
    // A damaged index means a damaged archive; anything else (too large, not UTF-8, not PassHolder JSON) is not ours.
    throw new Error(err instanceof Error && err.message === ZIP_INVALID ? ZIP_INVALID : NOT_ARCHIVE);
  }
  return {
    parsed,
    async readFile(f: ArchivedFile): Promise<Uint8Array> {
      const e = byPath.get(f.path);
      if (e === undefined) throw new Error("brak w archiwum");
      if (e.size !== f.size) throw new Error("inny rozmiar niż w opisie");
      try {
        return await readZipEntry(bytes, e, MAX_FILE_SIZE);
      } catch (err) {
        throw new Error(err instanceof Error && err.message === ZIP_ENTRY_TOO_LARGE ? "za duży" : "uszkodzony");
      }
    },
  };
}
