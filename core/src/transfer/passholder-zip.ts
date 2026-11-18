// PassHolder ZIP: passholder.json (a PassHolder JSON v3 index whose entries describe their files) followed by the
// decrypted files under files/<n>-<name>. Paths from an archive are only used to look entries up in the ZIP.
import { hasErrorCode, PassHolderError, type ErrorCode } from "../errors.ts";
import { MAX_FILE_SIZE, type Attachment } from "../files/attachment.ts";
import type { EntryContent } from "../p2p/entry.ts";
import { sortForExport } from "./common.ts";
import {
  parseArchiveIndex,
  passHolderJsonText,
  type ArchivedFile,
  type ParsedArchive,
} from "./passholder-json.ts";
import { ZipWriter, readZipEntry, readZipIndex, type ZipEntry } from "./zip.ts";
import { MIB } from "../sizes.ts";

export const MAX_ZIP_BYTES = 256 * MIB;
export const ARCHIVE_INDEX = "passholder.json";

const notArchive = (cause?: unknown) =>
  new PassHolderError("ZIP_NOT_PASSHOLDER", "The archive is not a PassHolder export", { cause });

/** Why `readFile` of an opened archive could not give a described file. */
export type ArchiveFileError = Extract<
  ErrorCode,
  | "ARCHIVE_FILE_MISSING"
  | "ARCHIVE_FILE_SIZE_MISMATCH"
  | "ARCHIVE_FILE_TOO_LARGE"
  | "ARCHIVE_FILE_CORRUPTED"
>;
/** Largest passholder.json accepted, after inflating. */
const MAX_INDEX_BYTES = 10 * MIB;

function archiveFileError(code: ArchiveFileError, cause?: unknown): PassHolderError {
  return new PassHolderError(code, `Archived file: ${code}`, { cause });
}

/** Path of the n-th exported file (from 1); characters Windows refuses in file names become "_". */
export function archivePath(n: number, name: string): string {
  return `files/${n}-${name.replace(/[<>:"|?*]/g, "_")}`;
}

/**
 * Writes the entries (sorted as in the JSON export) and their files. `readFile` gives a file's decrypted bytes, or
 * undefined when the file is not available (waiting for sync, damaged): it is then left out and counted in `missing`.
 */
export async function exportPassHolderZip(
  entries: readonly EntryContent[],
  readFile: (a: Attachment) => Promise<Uint8Array | undefined>,
  date?: Date,
): Promise<{ parts: Uint8Array[]; files: number; missing: number }> {
  const zip = new ZipWriter(date);
  const index: EntryContent[] = [];
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
    index.push(
      (described.length > 0 ? { ...content, attachments: described } : content) as EntryContent,
    );
  }
  const json = passHolderJsonText(index);
  // The index is written first, so a reader that streams the archive (the phone) meets it before the files.
  await zip.add(ARCHIVE_INDEX, new TextEncoder().encode(json), { first: true });
  return { parts: zip.finish(), files, missing };
}

/** An archive opened by openPassHolderZip. */
export interface OpenedArchive {
  parsed: ParsedArchive;
  /** A described file's bytes; throws a PassHolderError with an ArchiveFileError code. */
  readFile(f: ArchivedFile): Promise<Uint8Array>;
}

/**
 * Reads the index of a PassHolder ZIP held in memory: throws code ZIP_TOO_LARGE, ZIP_INVALID or ZIP_NOT_PASSHOLDER.
 * `readFile` gives a described file's bytes or throws a PassHolderError with an ArchiveFileError code.
 */
export async function openPassHolderZip(bytes: Uint8Array): Promise<OpenedArchive> {
  if (bytes.length > MAX_ZIP_BYTES)
    throw new PassHolderError("ZIP_TOO_LARGE", "The file is over MAX_ZIP_BYTES");
  const byPath = new Map<string, ZipEntry>(readZipIndex(bytes).map((e) => [e.path, e]));
  const indexEntry = byPath.get(ARCHIVE_INDEX);
  if (indexEntry === undefined) throw notArchive();
  let parsed: ParsedArchive;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await readZipEntry(bytes, indexEntry, MAX_INDEX_BYTES),
    );
    parsed = parseArchiveIndex(text);
  } catch (error) {
    // A damaged index means a damaged archive; anything else (too large, not UTF-8, not PassHolder JSON) is not ours.
    if (hasErrorCode(error, "ZIP_INVALID")) throw error;
    throw notArchive(error);
  }
  return {
    parsed,
    async readFile(f: ArchivedFile): Promise<Uint8Array> {
      const e = byPath.get(f.path);
      if (e === undefined) throw archiveFileError("ARCHIVE_FILE_MISSING");
      if (e.size !== f.size) throw archiveFileError("ARCHIVE_FILE_SIZE_MISMATCH");
      try {
        return await readZipEntry(bytes, e, MAX_FILE_SIZE);
      } catch (error) {
        throw archiveFileError(
          hasErrorCode(error, "ZIP_ENTRY_TOO_LARGE")
            ? "ARCHIVE_FILE_TOO_LARGE"
            : "ARCHIVE_FILE_CORRUPTED",
          error,
        );
      }
    },
  };
}
