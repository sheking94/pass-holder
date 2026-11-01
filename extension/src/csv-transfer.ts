import type { EntryFields, ImportResult } from "./vault-store.ts";

/**
 * Import and export of passwords as CSV in the layout NordPass uses, so a file exported from
 * NordPass can be imported here and a file exported here can be imported into NordPass.
 * PassHolder keeps only name, username and password, so the other columns are written empty
 * and ignored on import.
 */

/** NordPass export header, in its order. Import finds columns by name, so the order there does not matter. */
export const NORDPASS_COLUMNS = [
  "name",
  "url",
  "additional_urls",
  "username",
  "password",
  "note",
  "cardholdername",
  "cardnumber",
  "cvc",
  "expirydate",
  "zipcode",
  "folder",
  "full_name",
  "phone_number",
  "email",
  "address1",
  "address2",
  "city",
  "country",
  "state",
  "type",
  "custom_fields",
] as const;

/** NordPass "type" of a login. Other types (note, credit_card, identity) have nothing PassHolder can store. */
const LOGIN_TYPE = "password";

export interface ParsedImport {
  entries: EntryFields[];
  /** Rows that were not imported, with the line number in the file (header is line 1) and why. */
  skipped: { line: number; reason: string }[];
}

// --- CSV (RFC 4180) ------------------------------------------------------------------------

/**
 * Splits CSV text into rows of fields. Handles quoted fields with commas, doubled quotes and
 * line breaks inside, CRLF or LF line ends and a UTF-8 BOM. Blank lines are dropped.
 */
export function parseCsv(text: string): { line: number; fields: string[] }[] {
  const rows: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowStartLine = 1;
  const input = text.startsWith("﻿") ? text.slice(1) : text;

  const endRow = () => {
    fields.push(field);
    if (fields.length > 1 || fields[0] !== "") rows.push({ line: rowStartLine, fields });
    fields = [];
    field = "";
    rowStartLine = line;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      line++;
      endRow();
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error(`Plik CSV jest uszkodzony: niezamknięty cudzysłów (wiersz ${rowStartLine})`);
  if (field !== "" || fields.length > 0) endRow();
  return rows;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// --- NordPass layout -----------------------------------------------------------------------

/** The CSV text of a NordPass-style export of these entries, sorted by name. */
export function exportNordPassCsv(entries: readonly EntryFields[]): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name, "pl"));
  const rows = sorted.map(({ name, username, password }) => {
    const values: Partial<Record<(typeof NORDPASS_COLUMNS)[number], string>> = { name, username, password, type: LOGIN_TYPE };
    return NORDPASS_COLUMNS.map((column) => values[column] ?? "");
  });
  return toCsv([NORDPASS_COLUMNS, ...rows]);
}

/** Host of a URL without "www.", or the text itself if it is not a URL. Used when a row has no name. */
function nameFromUrl(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Reads a NordPass CSV export. Only logins (type "password", or rows without a type column) are
 * taken; notes, cards and identities are reported as skipped. A row without a name gets the
 * host of its URL as the name.
 */
export function parseNordPassCsv(text: string): ParsedImport {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("Plik jest pusty");
  const index = new Map(header.fields.map((name, i) => [name.trim().toLowerCase(), i]));
  if (!index.has("password") || !(index.has("name") || index.has("url"))) {
    throw new Error("To nie wygląda na eksport z NordPass: brak kolumn name/url i password w pierwszym wierszu");
  }
  const get = (fields: string[], column: string) => {
    const i = index.get(column);
    return i === undefined ? "" : (fields[i] ?? "");
  };

  const result: ParsedImport = { entries: [], skipped: [] };
  for (const { line, fields } of rows) {
    const type = get(fields, "type").trim();
    if (type && type !== LOGIN_TYPE) {
      result.skipped.push({ line, reason: `typ „${type}” (zapisujemy tylko hasła)` });
      continue;
    }
    const password = get(fields, "password");
    const url = get(fields, "url").trim();
    const name = get(fields, "name").trim() || (url ? nameFromUrl(url) : "");
    if (!name) {
      result.skipped.push({ line, reason: "brak nazwy i adresu" });
      continue;
    }
    if (!password) {
      result.skipped.push({ line, reason: "brak hasła" });
      continue;
    }
    result.entries.push({ name, username: get(fields, "username"), password });
  }
  return result;
}

/** How many skipped rows the summary lists one by one; the rest is shown as "…". */
const LISTED_SKIPPED_ROWS = 5;

/** The message shown after an import: what was added, what was skipped and why, and a reminder to delete the file. */
export function importSummary(parsed: ParsedImport, result: ImportResult): string {
  const { skipped } = parsed;
  const listed = skipped.slice(0, LISTED_SKIPPED_ROWS).map((s) => `wiersz ${s.line}: ${s.reason}`).join("; ");
  const parts = [
    `Dodano ${result.added} wpisów (lokalnie, zsynchronizuj, żeby trafiły na serwer).`,
    result.duplicates > 0 && `Pominięto ${result.duplicates} takich, które już są w sejfie.`,
    skipped.length > 0 && `Pominięto ${skipped.length} wierszy: ${listed}${skipped.length > LISTED_SKIPPED_ROWS ? "; …" : "."}`,
    "Usuń plik CSV z dysku, zawiera hasła jawnym tekstem.",
  ];
  return parts.filter(Boolean).join(" ");
}
