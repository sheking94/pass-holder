import type { EntryContentV3, EntryType, PostalAddress } from "../p2p/entry.ts";

/** Order of entry types in exports when names are equal. */
export const ENTRY_TYPE_ORDER: readonly EntryType[] = [
  "login",
  "contact",
  "card",
  "note",
  "document",
];

/** An entry or row an importer did not take. `at` is ready to show, e.g. "wiersz 3" (CSV, header is row 1) or "wpis 2" (JSON, from 1). */
export interface ImportSkip {
  at: string;
  reason: string;
}

/** `files`: file descriptions left out (an archive index imported as plain JSON), shown like skipped files. */
export interface ParsedImport {
  entries: EntryContentV3[];
  skipped: ImportSkip[];
  files?: ImportSkip[];
}

function trimmed(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(trimmed);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, trimmed(v)]),
    );
  }
  return value;
}

/**
 * Equal keys mean a duplicate: same content except attachments (an entry differing only in files is a duplicate,
 * as in the Android app), every text trimmed at its edges, object keys in sorted order.
 */
export function contentKey(c: EntryContentV3): string {
  const { attachments: _attachments, ...rest } = c as EntryContentV3 & { attachments?: unknown };
  return JSON.stringify(trimmed(rest));
}

/** A copy sorted by name (Polish collation), then by type in ENTRY_TYPE_ORDER. */
export function sortForExport(entries: readonly EntryContentV3[]): EntryContentV3[] {
  return [...entries].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "pl") ||
      ENTRY_TYPE_ORDER.indexOf(a.type) - ENTRY_TYPE_ORDER.indexOf(b.type),
  );
}

/** "Telefon (etykieta)", or just "Telefon" when the label is empty. Used for extra phones, e-mails and addresses on export. */
export const labelled = (name: string, label: string): string =>
  label === "" ? name : `${name} (${label})`;

/** "ulica, kod miasto, kraj" with empty parts left out. */
export function addressLine(a: PostalAddress): string {
  return [a.street, [a.postalCode, a.city].filter((x) => x !== "").join(" "), a.country]
    .filter((x) => x !== "")
    .join(", ");
}
