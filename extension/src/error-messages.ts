// The only place where the core's error codes become the Polish text the user sees.
import { files, KIB, MIB, p2p, PassHolderError, transfer, type ErrorCode } from "@passholder/core";

export const PHONE_UNREACHABLE = "Telefon nie odpowiada. Czy tryb Synchronizacja jest włączony?";
export const PHONE_FORGOT_BROWSER =
  "Telefon nie zna tej przeglądarki. Sparuj ją ponownie w „Adresy telefonu” → „Sparuj z innym telefonem / odtwórz telefon”.";
export const PHONE_UPDATE_REQUIRED = "Zaktualizuj aplikację na telefonie";
export const PHONE_MALFORMED = "Telefon odpowiedział niepoprawnie.";
export const FILE_CORRUPTED = "Plik jest uszkodzony";
const FILE_EMPTY = "Plik jest pusty";
export const SYNC_AGAIN = "Zsynchronizuj ponownie";
/** A background action (fill, save) found the vault locked. */
export const UNLOCK_AND_RETRY = "Sejf jest zablokowany. Odblokuj go i spróbuj ponownie";

/** Text for each code; `detail` is PassHolderError.detail (an entry's name, a CSV line). */
const TEXTS: Record<ErrorCode, (detail: string | undefined) => string> = {
  HOST_MALFORMED: () => PHONE_MALFORMED,
  // A Noise message that does not open: the answer is not what a PassHolder phone sends.
  NOISE_FAILED: () => PHONE_MALFORMED,
  HOST_ERROR: (detail) => `Telefon odpowiedział błędem (${detail ?? "bez opisu"}).`,
  DEVICE_NOT_PAIRED: () => PHONE_FORGOT_BROWSER,
  PHONE_UPDATE_REQUIRED: () => PHONE_UPDATE_REQUIRED,

  PAIRING_NOT_WAITING: () => "Telefon nie czeka na parowanie albo kod wygasł.",
  PAIRING_WRONG_CODE: () => "Zły kod parowania. Poproś telefon o nowy kod.",
  PAIRING_RESTORE_EXPECTED: () => "Telefon czeka na odtworzenie sejfu z wtyczki",
  PAIRING_BAD_CODE_FORMAT: () => `Kod parowania to ${p2p.PAIRING_CODE_LENGTH} cyfr.`,

  ENTRY_TOO_LARGE: () => "Wpis jest za duży",
  ENTRY_TOO_LARGE_TO_SYNC: (name) =>
    `Wpis „${name}” jest za duży (ponad ${p2p.MAX_ENTRY_BLOB_LENGTH / KIB} KiB) i nie może zostać zsynchronizowany. Skróć go.`,
  SYNC_EPOCH_CHANGED_TWICE: () =>
    "Sejf na telefonie zmienił się w trakcie synchronizacji. Spróbuj ponownie.",
  SYNC_NOT_SETTLED: () => "Synchronizacja się nie ustaliła. Spróbuj ponownie.",
  SYNC_ROUND_LIMIT: () => "Synchronizacja trwała za długo. Spróbuj ponownie.",

  FILE_EMPTY: () => FILE_EMPTY,
  FILE_TOO_LARGE: () => `Plik jest za duży (limit ${files.MAX_FILE_SIZE / MIB} MB)`,
  FILE_INVALID_NAME: () => "Nieprawidłowa nazwa pliku",
  FILE_CORRUPTED: () => FILE_CORRUPTED,
  FILE_SYNC_EPOCH_MISMATCH: () => SYNC_AGAIN,

  IMPORT_EMPTY_FILE: () => FILE_EMPTY,
  IMPORT_BAD_JSON: () => "Plik JSON jest uszkodzony",
  IMPORT_UNKNOWN_FORMAT: () =>
    "Nie rozpoznano pliku: to nie jest eksport PassHolder, Bitwarden ani NordPass",
  IMPORT_CSV_UNCLOSED_QUOTE: (line) =>
    `Plik CSV jest uszkodzony: niezamknięty cudzysłów (wiersz ${line})`,
  IMPORT_NOT_PASSHOLDER: () => "To nie jest plik PassHolder w wersji 3",
  IMPORT_NOT_NORDPASS: () =>
    "To nie wygląda na eksport z NordPass: brak kolumn name/url w pierwszym wierszu",
  IMPORT_NOT_BITWARDEN: () => "To nie jest plik Bitwarden JSON",
  IMPORT_BITWARDEN_ENCRYPTED: () =>
    "Zaszyfrowany eksport Bitwarden nie jest obsługiwany. Wyeksportuj z Bitwardena plik JSON bez szyfrowania.",

  ZIP_INVALID: () => "Archiwum ZIP jest uszkodzone albo nieobsługiwane",
  ZIP_TOO_LARGE: () => `Plik jest za duży (limit ${transfer.MAX_ZIP_BYTES / MIB} MiB)`,
  ZIP_WRITE_TOO_LARGE: () => "Archiwum byłoby za duże",
  ZIP_ENTRY_TOO_LARGE: () => "Plik w archiwum jest za duży",
  ZIP_NOT_PASSHOLDER: () => "Archiwum nie jest eksportem PassHolder",
  // Reasons of a skipped file in the import summary ("wpis N, nazwa: …").
  ARCHIVE_FILE_MISSING: () => "brak w archiwum",
  ARCHIVE_FILE_SIZE_MISMATCH: () => "inny rozmiar niż w opisie",
  ARCHIVE_FILE_TOO_LARGE: () => "za duży",
  ARCHIVE_FILE_CORRUPTED: () => "uszkodzony",
};

/**
 * What the user sees for any thrown value: the Polish text of a core code, otherwise the message of an Error
 * (the extension's own errors are already Polish), otherwise the value as text.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof p2p.P2pHostError && error.code === "HOST_ERROR")
    return `Telefon odpowiedział błędem ${error.status} (${error.detail}).`;
  if (error instanceof PassHolderError) return TEXTS[error.code](error.detail);
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The same failure as an Error whose message is what the user sees (the original stays as `cause`). Used where
 * the store hands an error to a screen, which shows `error.message`. Anything that is not a core error is kept.
 */
export function toUserError(error: unknown): unknown {
  if (!(error instanceof PassHolderError)) return error;
  return new Error(errorMessage(error), { cause: error });
}
