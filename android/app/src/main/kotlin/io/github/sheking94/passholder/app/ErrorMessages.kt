package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.PasswordGenerator

// The only place where the core's error codes become the Polish text the user sees (like extension/src/error-messages.ts).

/** Text for each code; `when` without `else`, so a new code does not compile until it has a text here. */
private fun text(code: ErrorCode, detail: String?): String = when (code) {
    ErrorCode.VAULT_EXISTS -> "Na telefonie już jest sejf"

    ErrorCode.NO_VAULT -> "Brak sejfu na telefonie"

    ErrorCode.VAULT_LOCKED -> "Sejf jest zablokowany"

    ErrorCode.VAULT_CHANGED -> "Sejf zmienił się w trakcie, spróbuj jeszcze raz"

    ErrorCode.VAULT_UNREADABLE -> "Nie mogę odczytać danych sejfu na telefonie. Najpierw je usuń."

    ErrorCode.WRONG_MASTER_PASSWORD -> "Złe hasło główne"

    ErrorCode.WRONG_UNLOCK_KEYS -> "Złe klucze odblokowania"

    ErrorCode.PASSWORD_UNCHANGED -> "Nowe hasło musi być inne niż obecne"

    ErrorCode.NO_SPACE -> "Za mało miejsca na telefonie"

    ErrorCode.RESTORE_NOT_RUNNING -> "Odtwarzanie z wtyczki nie trwa"

    ErrorCode.RESTORE_NOT_SENT -> "Wtyczka jeszcze nie przesłała sejfu"

    ErrorCode.RESTORE_CHANGED -> "Odtwarzanie zmieniło się w trakcie, spróbuj jeszcze raz"

    ErrorCode.ENTRY_TOO_LARGE -> "Wpis jest za duży"

    ErrorCode.ENTRY_TYPE_MISMATCH -> "Ten wpis ma inny typ"

    ErrorCode.GENERATOR_NO_GROUPS -> "Wybierz co najmniej jedną grupę znaków"

    ErrorCode.GENERATOR_BAD_LENGTH ->
        "Długość musi być od ${PasswordGenerator.MIN_LENGTH} do ${PasswordGenerator.MAX_LENGTH}"

    // The extension's answer does not open: not what a paired PassHolder extension sends.
    ErrorCode.NOISE_FAILED -> "Wtyczka odpowiedziała niepoprawnie."

    ErrorCode.FILE_EMPTY -> AttachmentFiles.EMPTY

    ErrorCode.FILE_TOO_LARGE -> AttachmentFiles.TOO_LARGE

    ErrorCode.FILE_INVALID_NAME -> AttachmentFiles.BAD_NAME

    ErrorCode.FILE_CORRUPTED -> AttachmentFiles.CORRUPTED

    ErrorCode.IMPORT_EMPTY_FILE -> "Plik jest pusty"

    ErrorCode.IMPORT_BAD_JSON -> "Plik JSON jest uszkodzony"

    ErrorCode.IMPORT_UNKNOWN_FORMAT -> "Nie rozpoznano pliku: to nie jest eksport PassHolder, Bitwarden ani NordPass"

    ErrorCode.IMPORT_CSV_UNCLOSED_QUOTE -> "Plik CSV jest uszkodzony: niezamknięty cudzysłów (wiersz $detail)"

    ErrorCode.IMPORT_NOT_PASSHOLDER -> "To nie jest plik PassHolder w wersji 3"

    ErrorCode.IMPORT_NOT_NORDPASS -> "To nie wygląda na eksport z NordPass: brak kolumn name/url w pierwszym wierszu"

    ErrorCode.IMPORT_NOT_BITWARDEN -> "To nie jest plik Bitwarden JSON"

    ErrorCode.IMPORT_BITWARDEN_ENCRYPTED ->
        "Zaszyfrowany eksport Bitwarden nie jest obsługiwany. Wyeksportuj z Bitwardena plik JSON bez szyfrowania."

    ErrorCode.ZIP_INVALID -> "Archiwum ZIP jest uszkodzone albo nieobsługiwane"

    ErrorCode.ZIP_TOO_LARGE -> "Plik jest za duży (limit 256 MiB)"

    ErrorCode.ZIP_NOT_PASSHOLDER -> "Archiwum nie jest eksportem PassHolder"
}

/**
 * What the user sees for any error: the Polish text of a core code, otherwise the message (the app's own errors
 * are already Polish), otherwise the class name.
 */
fun errorMessage(error: Throwable): String = when (error) {
    is PassHolderException -> text(error.code, error.detail)
    else -> error.message ?: error.javaClass.simpleName
}
