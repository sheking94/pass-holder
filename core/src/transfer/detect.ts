import { PassHolderError } from "../errors.ts";
import type { EntryContent } from "../p2p/entry.ts";
import type { ParsedImport } from "./common.ts";
import { exportBitwardenJson, isBitwardenJson, parseBitwardenJson } from "./bitwarden-json.ts";
import { exportNordPassCsv, parseNordPassCsv } from "./nordpass-csv.ts";
import { exportPassHolderJson, isPassHolderJson, parsePassHolderJson } from "./passholder-json.ts";

export type TransferFormat = "passholder" | "bitwarden" | "nordpass";

/** Recognises the format from the file's content (JSON starts with "{", anything else is read as NordPass CSV) and parses it. */
export function parseImportFile(text: string): { format: TransferFormat; parsed: ParsedImport } {
  const body = text.replace(/^\uFEFF/, "").trim();
  if (body === "") throw new PassHolderError("IMPORT_EMPTY_FILE", "The file is empty");
  if (!body.startsWith("{")) return { format: "nordpass", parsed: parseNordPassCsv(text) };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new PassHolderError("IMPORT_BAD_JSON", "The JSON file is damaged", { cause: error });
  }
  if (isPassHolderJson(value)) return { format: "passholder", parsed: parsePassHolderJson(body) };
  if (isBitwardenJson(value) || isEncryptedBitwarden(value))
    return { format: "bitwarden", parsed: parseBitwardenJson(body) };
  throw new PassHolderError(
    "IMPORT_UNKNOWN_FORMAT",
    "Not a PassHolder, Bitwarden or NordPass export",
  );
}

/** A Bitwarden encrypted export has no `items` (password-protected: salt + data); parseBitwardenJson explains why it is refused. */
function isEncryptedBitwarden(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).encrypted === true
  );
}

export function exportFile(format: TransferFormat, entries: readonly EntryContent[]): string {
  switch (format) {
    case "passholder":
      return exportPassHolderJson(entries);
    case "bitwarden":
      return exportBitwardenJson(entries);
    case "nordpass":
      return exportNordPassCsv(entries);
  }
}
