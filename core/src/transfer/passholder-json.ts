import { MAX_ATTACHMENTS_PARSED, MAX_FILE_SIZE, isAttachmentMime, isAttachmentName } from "../files/attachment.ts";
import { parseEntryContent, type EntryContentV3 } from "../p2p/entry.ts";
import { sortForExport, type ImportSkip, type ParsedImport } from "./common.ts";

const NOT_PASSHOLDER = "To nie jest plik PassHolder w wersji 3";

/** True for an object carrying the PassHolder format marker (used to detect the file kind). */
export function isPassHolderJson(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).format === "passholder";
}

export function exportPassHolderJson(entries: readonly EntryContentV3[]): string {
  // Attachment descriptors carry file keys and the files are not exported, so they are left out.
  const bare = entries.map(({ attachments: _attachments, ...rest }) => rest as EntryContentV3);
  return JSON.stringify({ format: "passholder", version: 3, entries: sortForExport(bare) }, null, 2) + "\n";
}

/** Number of files that an export of these entries leaves out. */
export function countAttachments(entries: readonly EntryContentV3[]): number {
  return entries.reduce((sum, e) => sum + (e.attachments?.length ?? 0), 0);
}

/** A file description in an archive index: exactly these keys, in this order. `path` only finds the file in the ZIP. */
export interface ArchivedFile { name: string; mime: string; size: number; path: string }

/** An entry of an archive index: content without attachments, plus the descriptions of its files (may be empty). */
export interface ArchiveEntry { content: EntryContentV3; files: ArchivedFile[] }

export interface ParsedArchive { entries: ArchiveEntry[]; skipped: ImportSkip[] }

const FILE_KEYS = ["name", "mime", "size", "path"];

function parseArchivedFile(value: unknown): ArchivedFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
  const o = value as Record<string, unknown>;
  const own = Object.keys(o);
  if (own.length !== FILE_KEYS.length || !FILE_KEYS.every((k) => Object.hasOwn(o, k))) throw new Error();
  const { name, mime, size, path } = o;
  if (typeof name !== "string" || !isAttachmentName(name)) throw new Error();
  if (typeof mime !== "string" || !isAttachmentMime(mime)) throw new Error();
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_FILE_SIZE) throw new Error();
  if (typeof path !== "string" || path === "") throw new Error();
  return { name, mime, size, path };
}

function parseArchivedFiles(value: unknown): ArchivedFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ATTACHMENTS_PARSED) throw new Error();
  return value.map(parseArchivedFile);
}

/** Entries with their position in the file (from 1), for "wpis N". */
function parseIndex(text: string): { entries: (ArchiveEntry & { n: number })[]; skipped: ImportSkip[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(NOT_PASSHOLDER);
  }
  if (!isPassHolderJson(doc)) throw new Error(NOT_PASSHOLDER);
  const { version, entries: raw } = doc as Record<string, unknown>;
  if (version !== 3 || !Array.isArray(raw)) throw new Error(NOT_PASSHOLDER);
  const entries: (ArchiveEntry & { n: number })[] = [];
  const skipped: ImportSkip[] = [];
  raw.forEach((item, i) => {
    try {
      let files: ArchivedFile[] = [];
      let body = item;
      if (typeof item === "object" && item !== null && Object.hasOwn(item, "attachments")) {
        const { attachments, ...rest } = item as Record<string, unknown>;
        files = parseArchivedFiles(attachments);
        body = rest;
      }
      const content = parseEntryContent(body);
      if (content.name.trim() === "") skipped.push({ at: `wpis ${i + 1}`, reason: "brak nazwy" });
      else entries.push({ n: i + 1, content, files });
    } catch {
      skipped.push({ at: `wpis ${i + 1}`, reason: "zły format wpisu" });
    }
  });
  return { entries, skipped };
}

/**
 * The index of a PassHolder ZIP (also a PassHolder JSON v3 file): same rules as parsePassHolderJson, and an entry may
 * carry `attachments` with 1..40 file descriptions; a bad description skips the entry as "zły format wpisu".
 */
export function parseArchiveIndex(text: string): ParsedArchive {
  const { entries, skipped } = parseIndex(text);
  return { entries: entries.map(({ content, files }) => ({ content, files })), skipped };
}

/**
 * Throws a Polish message if the file is not PassHolder JSON v3; a bad entry is skipped as "wpis N" (from 1).
 * File descriptions of an archive index are left out and listed in `files` ("wpis N, nazwa"), since the files
 * themselves are only in the ZIP.
 */
export function parsePassHolderJson(text: string): ParsedImport {
  const { entries, skipped } = parseIndex(text);
  const files = entries.flatMap((e) => e.files.map((f) => ({ at: `wpis ${e.n}, ${f.name}`, reason: "importuj całe archiwum ZIP" })));
  const parsed: ParsedImport = { entries: entries.map((e) => e.content), skipped };
  if (files.length > 0) parsed.files = files;
  return parsed;
}
