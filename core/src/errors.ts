// Errors the core reports to an app. The app recognises them by `code`, never by the message text, and picks
// the text the user sees (the extension: extension/src/error-messages.ts). The message is English, for logs.

/** Every condition an app may need to tell apart or show to the user. */
export type ErrorCode =
  // Talking to the phone.
  | "HOST_MALFORMED"
  | "HOST_ERROR"
  | "DEVICE_NOT_PAIRED"
  | "PHONE_UPDATE_REQUIRED"
  | "NOISE_FAILED"
  // Pairing.
  | "PAIRING_NOT_WAITING"
  | "PAIRING_WRONG_CODE"
  | "PAIRING_RESTORE_EXPECTED"
  | "PAIRING_BAD_CODE_FORMAT"
  // Entries and their sync.
  | "ENTRY_TOO_LARGE"
  | "ENTRY_TOO_LARGE_TO_SYNC"
  | "SYNC_EPOCH_CHANGED_TWICE"
  | "SYNC_NOT_SETTLED"
  | "SYNC_ROUND_LIMIT"
  // Files in the vault.
  | "FILE_EMPTY"
  | "FILE_TOO_LARGE"
  | "FILE_INVALID_NAME"
  | "FILE_CORRUPTED"
  | "FILE_SYNC_EPOCH_MISMATCH"
  // Import files.
  | "IMPORT_EMPTY_FILE"
  | "IMPORT_BAD_JSON"
  | "IMPORT_UNKNOWN_FORMAT"
  | "IMPORT_CSV_UNCLOSED_QUOTE"
  | "IMPORT_NOT_PASSHOLDER"
  | "IMPORT_NOT_NORDPASS"
  | "IMPORT_NOT_BITWARDEN"
  | "IMPORT_BITWARDEN_ENCRYPTED"
  // ZIP archives.
  | "ZIP_INVALID"
  | "ZIP_TOO_LARGE"
  | "ZIP_WRITE_TOO_LARGE"
  | "ZIP_ENTRY_TOO_LARGE"
  | "ZIP_NOT_PASSHOLDER"
  | "ARCHIVE_FILE_MISSING"
  | "ARCHIVE_FILE_SIZE_MISMATCH"
  | "ARCHIVE_FILE_TOO_LARGE"
  | "ARCHIVE_FILE_CORRUPTED";

export interface PassHolderErrorOptions extends ErrorOptions {
  /** What the code is about, for the app's text: an entry's name, a CSV line number. */
  detail?: string;
}

/** An error the core reports with a code. The message is the English description, not for the user. */
export class PassHolderError extends Error {
  override readonly name: string = "PassHolderError";
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message: string = code, options: PassHolderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.detail = options.detail;
  }
}

/** True when `error` is a PassHolderError with this code (or one of these codes). */
export function hasErrorCode(
  error: unknown,
  ...codes: readonly ErrorCode[]
): error is PassHolderError {
  return error instanceof PassHolderError && codes.includes(error.code);
}
