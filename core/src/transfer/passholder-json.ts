import {
  MAX_ATTACHMENTS_PARSED,
  MAX_FILE_SIZE,
  isAttachmentMime,
  isAttachmentName,
} from "../files/attachment.ts";
import { PassHolderError } from "../errors.ts";
import { parseEntryContent, type EntryContent } from "../p2p/entry.ts";
import { sortForExport, type ImportSkip, type ParsedImport } from "./common.ts";

/** True for an object carrying the PassHolder format marker (used to detect the file kind). */
export function isPassHolderJson(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).format === "passholder"
  );
}

export function exportPassHolderJson(entries: readonly EntryContent[]): string {
  // Attachment descriptors carry file keys and the files are not exported, so they are left out.
  const bare = entries.map(({ attachments: _attachments, ...rest }) => rest as EntryContent);
  return (
    JSON.stringify({ format: "passholder", version: 3, entries: sortForExport(bare) }, null, 2) +
    "\n"
  );
}

/** Number of files that an export of these entries leaves out. */
export function countAttachments(entries: readonly EntryContent[]): number {
  return entries.reduce((sum, e) => sum + (e.attachments?.length ?? 0), 0);
}

/** A file description in an archive index: exactly these keys, in this order. `path` only finds the file in the ZIP. */
export interface ArchivedFile {
  name: string;
  mime: string;
  size: number;
  path: string;
}

/**
 * An entry of an archive index: content without attachments, plus the descriptions of its files (may be empty).
 * `position` is the entry's place in the index's `entries` (from 1), the N of "wpis N".
 */
export interface ArchiveEntry {
  content: EntryContent;
  files: ArchivedFile[];
  position: number;
}

export interface ParsedArchive {
  entries: ArchiveEntry[];
  skipped: ImportSkip[];
}

const FILE_KEYS = ["name", "mime", "size", "path"];

/** A file description, or undefined when it breaks a rule. */
function parseArchivedFile(value: unknown): ArchivedFile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const own = Object.keys(o);
  if (own.length !== FILE_KEYS.length || !FILE_KEYS.every((k) => Object.hasOwn(o, k)))
    return undefined;
  const { name, mime, size, path } = o;
  if (typeof name !== "string" || !isAttachmentName(name)) return undefined;
  if (typeof mime !== "string" || !isAttachmentMime(mime)) return undefined;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_FILE_SIZE)
    return undefined;
  if (typeof path !== "string" || path === "") return undefined;
  return { name, mime, size, path };
}

/** 1..MAX_ATTACHMENTS_PARSED file descriptions, or undefined when the list or any description is bad. */
function parseArchivedFiles(value: unknown): ArchivedFile[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ATTACHMENTS_PARSED)
    return undefined;
  const files: ArchivedFile[] = [];
  for (const item of value) {
    const file = parseArchivedFile(item);
    if (file === undefined) return undefined;
    files.push(file);
  }
  return files;
}

/** An index item as its content and file descriptions, or undefined when its format is bad. */
function parseIndexItem(
  item: unknown,
): { content: EntryContent; files: ArchivedFile[] } | undefined {
  let files: ArchivedFile[] = [];
  let body = item;
  if (typeof item === "object" && item !== null && Object.hasOwn(item, "attachments")) {
    const { attachments, ...rest } = item as Record<string, unknown>;
    const parsed = parseArchivedFiles(attachments);
    if (parsed === undefined) return undefined;
    files = parsed;
    body = rest;
  }
  try {
    return { content: parseEntryContent(body), files };
  } catch {
    // parseEntryContent throws "Invalid entry payload" for any rule the content breaks.
    return undefined;
  }
}

const notPassHolder = (cause?: unknown) =>
  new PassHolderError("IMPORT_NOT_PASSHOLDER", "Not a PassHolder JSON v3 file", { cause });

/**
 * The index of a PassHolder ZIP (also a PassHolder JSON v3 file): same rules as parsePassHolderJson, and an entry may
 * carry `attachments` with 1..40 file descriptions; a bad description skips the entry as "zły format wpisu".
 */
export function parseArchiveIndex(text: string): ParsedArchive {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw notPassHolder(error);
  }
  if (!isPassHolderJson(doc)) throw notPassHolder();
  const { version, entries: raw } = doc as Record<string, unknown>;
  if (version !== 3 || !Array.isArray(raw)) throw notPassHolder();
  const entries: ArchiveEntry[] = [];
  const skipped: ImportSkip[] = [];
  // A path may be described once in the whole index, so one stored file cannot be imported many times.
  const paths = new Set<string>();
  raw.forEach((item, i) => {
    const at = `wpis ${i + 1}`;
    const parsed = parseIndexItem(item);
    const own = parsed?.files.map((f) => f.path) ?? [];
    if (parsed === undefined || new Set(own).size !== own.length || own.some((p) => paths.has(p))) {
      skipped.push({ at, reason: "zły format wpisu" });
      return;
    }
    if (parsed.content.name.trim() === "") {
      skipped.push({ at, reason: "brak nazwy" });
      return;
    }
    own.forEach((p) => paths.add(p));
    entries.push({ ...parsed, position: i + 1 });
  });
  return { entries, skipped };
}

/**
 * Throws code IMPORT_NOT_PASSHOLDER if the file is not PassHolder JSON v3; a bad entry is skipped as "wpis N" (from 1).
 * File descriptions of an archive index are left out and listed in `files` ("wpis N, nazwa"), since the files
 * themselves are only in the ZIP.
 */
export function parsePassHolderJson(text: string): ParsedImport {
  const { entries, skipped } = parseArchiveIndex(text);
  const files = entries.flatMap((e) =>
    e.files.map((f) => ({
      at: `wpis ${e.position}, ${f.name}`,
      reason: "importuj całe archiwum ZIP",
    })),
  );
  const parsed: ParsedImport = { entries: entries.map((e) => e.content), skipped };
  if (files.length > 0) parsed.files = files;
  return parsed;
}
