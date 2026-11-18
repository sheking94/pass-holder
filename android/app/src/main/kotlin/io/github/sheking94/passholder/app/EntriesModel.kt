package io.github.sheking94.passholder.app

import android.content.Context
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.entries.tidyContent
import io.github.sheking94.passholder.app.entries.validateContent
import io.github.sheking94.passholder.app.ui.EntryActions
import io.github.sheking94.passholder.app.ui.StatusActions
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.PasswordGenerator
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.UUID

/** The entry form's work: save and delete on the phone, copying a field, the generator and the apps of a login. */
internal class EntriesModel(
    private val ui: UiStateHolder,
    private val store: PhoneVaultStore,
    private val attachments: AttachmentsModel,
    /** For the clipboard. */
    private val context: Context,
    private val settings: Settings,
    private val appTrust: () -> AppTrust,
    /** Read on every use: tests replace it. */
    private val installedApps: () -> InstalledApps,
) : EntryActions,
    StatusActions by ui {
    /** Only the values changed against [original] are format-checked. */
    override fun save(id: String?, content: EntryContent, original: EntryContent?) {
        val tidy = tidyContent(content)
        validateContent(tidy, original)?.let { return fail(it) }
        ui.launchOperation("Zapisuję…") {
            // ENTRY_TOO_LARGE and ENTRY_TYPE_MISMATCH end the operation with their text on the status line.
            store.upsertContent(id ?: UUID.randomUUID().toString(), tidy)
            // Files added in this form and removed from it before saving belong to no entry.
            attachments.discardAdded(keep = tidy.attachments.mapTo(HashSet()) { it.id })
            ui.showList(SAVED, EntryType.of(tidy.fields))
        }
    }

    override fun delete(id: String) {
        val tab = ui.current.returnTab()
        ui.launchOperation("Usuwam…") {
            store.delete(id)
            attachments.discardAdded()
            ui.showList(DELETED, tab)
        }
    }

    /**
     * A [sensitive] field (password, TOTP, card number…) is marked sensitive and the clipboard is cleared after
     * [SecureClipboard.CLEAR_AFTER_MINUTES]. [label] ("hasło", "numer karty"…) is used as given in the status.
     */
    override fun copy(label: String, value: String, sensitive: Boolean) {
        if (value.isEmpty()) return
        if (sensitive) {
            SecureClipboard.copyPassword(context, label, value)
            ui.showStatus("Skopiowano $label. Schowek zostanie wyczyszczony za ${SecureClipboard.CLEAR_AFTER_MINUTES} min.")
        } else {
            SecureClipboard.copyText(context, label, value)
            ui.showStatus("Skopiowano $label.")
        }
    }

    override fun generatorOptions(): GeneratorOptions = settings.generatorOptions

    override fun generatePassword(options: GeneratorOptions): String? = runCatching { PasswordGenerator.generate(options) }
        .onSuccess { settings.generatorOptions = options }
        .onFailure { fail(errorMessage(it)) }
        .getOrNull()

    override fun installedApps(): List<InstalledApp> = installedApps.invoke().list()

    override fun trustPickedApp(packageName: String) {
        ui.scope.launch(Dispatchers.IO) { runCatching { appTrust().remember(packageName) } }
    }

    private companion object {
        const val SAVED = "Zapisano na telefonie. Wtyczka dostanie zmianę przy następnej synchronizacji."
        const val DELETED = "Usunięto na telefonie. Wtyczka dostanie zmianę przy następnej synchronizacji."
    }
}
