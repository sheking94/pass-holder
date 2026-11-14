import type { transfer } from "@passholder/core";
import { entriesNoun, filesNoun, plural } from "./plural.ts";
import type { ImportResult } from "./vault-store.ts";

/** How many skipped items the summary lists one by one; the rest is shown as "…". */
const LISTED_SKIPPED = 5;

/** "at: reason; at: reason" for the first LISTED_SKIPPED items, then "; …" if there are more, otherwise ".". */
function listSkipped(skipped: readonly transfer.ImportSkip[]): string {
  const listed = skipped.slice(0, LISTED_SKIPPED).map((s) => `${s.at}: ${s.reason}`).join("; ");
  return `${listed}${skipped.length > LISTED_SKIPPED ? "; …" : "."}`;
}

/**
 * The message shown after an import: what was added, what was skipped and why, and a reminder to delete the file.
 * `files` (a PassHolder ZIP, or files described in a bare passholder.json) adds how many files came in or were skipped.
 */
export function importSummary(
  parsed: transfer.ParsedImport | transfer.ParsedArchive,
  result: ImportResult,
  format: transfer.TransferFormat,
  files?: { added: number; skipped: transfer.ImportSkip[] },
): string {
  const { skipped } = parsed;
  const noun = (n: number) => (format === "nordpass" ? plural(n, "wiersz", "wiersze", "wierszy") : plural(n, "wpis", "wpisy", "wpisów"));
  const fileSkips = files?.skipped ?? [];
  const parts = [
    `Dodano ${entriesNoun(result.added)} (lokalnie, zsynchronizuj, żeby trafiły na telefon).`,
    result.duplicates > 0 && `Pominięto ${result.duplicates} takich, które już są w sejfie lub powtarzają się w pliku.`,
    result.tooLarge > 0 && `Uwaga, pominięto za duże: ${result.tooLarge}.`,
    skipped.length > 0 && `Pominięto ${skipped.length} ${noun(skipped.length)}: ${listSkipped(skipped)}`,
    files !== undefined && files.added > 0 && `Dodano ${filesNoun(files.added)}.`,
    fileSkips.length > 0 && `Pominięto ${filesNoun(fileSkips.length)}: ${listSkipped(fileSkips)}`,
    "Usuń plik z dysku, zawiera hasła jawnym tekstem.",
  ];
  return parts.filter(Boolean).join(" ");
}
