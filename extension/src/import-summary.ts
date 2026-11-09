import type { transfer } from "@passholder/core";
import { entriesNoun, plural } from "./plural.ts";
import type { ImportResult } from "./vault-store.ts";

/** How many skipped items the summary lists one by one; the rest is shown as "…". */
const LISTED_SKIPPED = 5;

/** The message shown after an import: what was added, what was skipped and why, and a reminder to delete the file. */
export function importSummary(parsed: transfer.ParsedImport, result: ImportResult, format: transfer.TransferFormat): string {
  const { skipped } = parsed;
  const noun = (n: number) => (format === "nordpass" ? plural(n, "wiersz", "wiersze", "wierszy") : plural(n, "wpis", "wpisy", "wpisów"));
  const listed = skipped.slice(0, LISTED_SKIPPED).map((s) => `${s.at}: ${s.reason}`).join("; ");
  const parts = [
    `Dodano ${entriesNoun(result.added)} (lokalnie, zsynchronizuj, żeby trafiły na telefon).`,
    result.duplicates > 0 && `Pominięto ${result.duplicates} takich, które już są w sejfie lub powtarzają się w pliku.`,
    result.tooLarge > 0 && `Uwaga, pominięto za duże: ${result.tooLarge}.`,
    skipped.length > 0 && `Pominięto ${skipped.length} ${noun(skipped.length)}: ${listed}${skipped.length > LISTED_SKIPPED ? "; …" : "."}`,
    "Usuń plik z dysku, zawiera hasła jawnym tekstem.",
  ];
  return parts.filter(Boolean).join(" ");
}
