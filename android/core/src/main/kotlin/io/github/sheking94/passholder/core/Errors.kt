package io.github.sheking94.passholder.core

// Errors the core reports to the app, like core/src/errors.ts. The app recognises them by [PassHolderException.code],
// never by the message text, and picks the text the user sees (app/ErrorMessages.kt). The message is English, for logs.

/** Every condition the app may need to tell apart or show to the user. */
enum class ErrorCode {
    // The vault on the phone.
    VAULT_EXISTS,
    NO_VAULT,
    VAULT_LOCKED,
    VAULT_CHANGED,
    VAULT_UNREADABLE,
    WRONG_MASTER_PASSWORD,
    WRONG_UNLOCK_KEYS,
    PASSWORD_UNCHANGED,
    NO_SPACE,

    // Restoring the vault from the extension.
    RESTORE_NOT_RUNNING,
    RESTORE_NOT_SENT,
    RESTORE_CHANGED,

    // Entries.
    ENTRY_TOO_LARGE,
    ENTRY_TYPE_MISMATCH,

    // Password generator.
    GENERATOR_NO_GROUPS,
    GENERATOR_BAD_LENGTH,

    // Talking to the extension.
    NOISE_FAILED,

    // Files in the vault.
    FILE_EMPTY,
    FILE_TOO_LARGE,
    FILE_INVALID_NAME,
    FILE_CORRUPTED,

    // Import files.
    IMPORT_EMPTY_FILE,
    IMPORT_BAD_JSON,
    IMPORT_UNKNOWN_FORMAT,
    IMPORT_CSV_UNCLOSED_QUOTE,
    IMPORT_NOT_PASSHOLDER,
    IMPORT_NOT_NORDPASS,
    IMPORT_NOT_BITWARDEN,
    IMPORT_BITWARDEN_ENCRYPTED,

    // ZIP archives.
    ZIP_INVALID,
    ZIP_TOO_LARGE,
    ZIP_NOT_PASSHOLDER,
}

/**
 * An error the core reports with a [code]. [detail] is what the code is about, for the app's text (a CSV line
 * number, the generator's length limits). The message is the English description, not for the user.
 */
class PassHolderException(val code: ErrorCode, message: String = code.name, val detail: String? = null, cause: Throwable? = null) :
    RuntimeException(message, cause)

/** True when this is a [PassHolderException] with one of [codes]. */
fun Throwable.hasErrorCode(vararg codes: ErrorCode): Boolean = this is PassHolderException && code in codes

/** Like [require], with a code: throws [PassHolderException] with [code] (and [detail]) when [value] is false. */
fun requireCode(value: Boolean, code: ErrorCode, detail: String? = null) {
    if (!value) throw PassHolderException(code, detail = detail)
}

/** Like [check], with a code: throws [PassHolderException] with [code] when [value] is false. */
fun checkCode(value: Boolean, code: ErrorCode) {
    if (!value) throw PassHolderException(code)
}
