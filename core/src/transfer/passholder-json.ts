import { parseEntryContent, type EntryContentV3 } from "../p2p/entry.ts";
import { sortForExport, type ImportSkip, type ParsedImport } from "./common.ts";

const NOT_PASSHOLDER = "To nie jest plik PassHolder w wersji 3";

/** True for an object carrying the PassHolder format marker (used to detect the file kind). */
export function isPassHolderJson(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).format === "passholder";
}

export function exportPassHolderJson(entries: readonly EntryContentV3[]): string {
  return JSON.stringify({ format: "passholder", version: 3, entries: sortForExport(entries) }, null, 2) + "\n";
}

/** Throws a Polish message if the file is not PassHolder JSON v3; a bad entry is skipped as "wpis N" (from 1). */
export function parsePassHolderJson(text: string): ParsedImport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(NOT_PASSHOLDER);
  }
  if (!isPassHolderJson(doc)) throw new Error(NOT_PASSHOLDER);
  const { version, entries: raw } = doc as Record<string, unknown>;
  if (version !== 3 || !Array.isArray(raw)) throw new Error(NOT_PASSHOLDER);
  const entries: EntryContentV3[] = [];
  const skipped: ImportSkip[] = [];
  raw.forEach((item, i) => {
    try {
      entries.push(parseEntryContent(item));
    } catch {
      skipped.push({ at: `wpis ${i + 1}`, reason: "zły format wpisu" });
    }
  });
  return { entries, skipped };
}
