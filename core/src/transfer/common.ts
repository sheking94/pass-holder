import {
  ENTRY_TYPES,
  type DocumentKind,
  type EntryContent,
  type PostalAddress,
} from "../p2p/entry.ts";

/** Polish names of document kinds: written into exports and shown in the extension. */
export const DOCUMENT_KIND_NAMES: Record<DocumentKind, string> = {
  id_card: "Dowód osobisty",
  passport: "Paszport",
  driving_license: "Prawo jazdy",
  student_id: "Legitymacja",
  other: "Inny",
};

/** Polish labels of document fields in exports (Bitwarden custom fields, NordPass note lines). */
export const DOCUMENT_LABELS = {
  kind: "Rodzaj dokumentu",
  fullName: "Imię i nazwisko",
  issueDate: "Data wydania",
  expiryDate: "Data ważności",
  issuer: "Wystawca",
} as const;

/** ImportSkip reasons shared by the importers. */
export const SKIP_BAD_ENTRY = "zły format wpisu";
export const SKIP_NO_NAME = "brak nazwy";

/** An entry or row an importer did not take. `at` is ready to show, e.g. "wiersz 3" (CSV, header is row 1) or "wpis 2" (JSON, from 1). */
export interface ImportSkip {
  at: string;
  reason: string;
}

/** `files`: file descriptions left out (an archive index imported as plain JSON), shown like skipped files. */
export interface ParsedImport {
  entries: EntryContent[];
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
export function contentKey(c: EntryContent): string {
  const { attachments: _attachments, ...rest } = c as EntryContent & { attachments?: unknown };
  return JSON.stringify(trimmed(rest));
}

/** A copy sorted by name (Polish collation), then by type in ENTRY_TYPES order. */
export function sortForExport(entries: readonly EntryContent[]): EntryContent[] {
  return [...entries].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "pl") ||
      ENTRY_TYPES.indexOf(a.type) - ENTRY_TYPES.indexOf(b.type),
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
