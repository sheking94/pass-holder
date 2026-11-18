package io.github.sheking94.passholder.app

import android.content.ContentResolver
import android.net.Uri
import android.util.Log
import io.github.sheking94.passholder.app.ui.AttachmentActions
import io.github.sheking94.passholder.app.ui.FilePicks
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.Attachments
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.Collections

/**
 * "Załączniki" of the entry form. A file added in the form is encrypted onto the disk at once but belongs to no
 * entry until "Zapisz": its id is kept here, so leaving the form (or saving without it) deletes the file.
 */
internal class AttachmentsModel(
    private val ui: UiStateHolder,
    private val store: PhoneVaultStore,
    private val resolver: ContentResolver,
    private val filePicks: FilePicks,
) : AttachmentActions,
    FilePicks by filePicks {
    /** Ids of the files added in the form now open: encrypted on disk already, in no saved entry yet. */
    private val addedFiles = Collections.synchronizedSet(HashSet<String>())

    override fun attachFile(uri: Uri?, count: Int, onAdded: (Attachment) -> Unit) {
        endFilePick()
        // The vault may have locked while the picker was open: the file is not even read then.
        if (uri == null || !store.isUnlocked) return
        if (!Attachments.canAdd(count)) return fail(AttachmentFiles.TOO_MANY)
        ui.launchOperation("Szyfruję plik…") {
            val picked = AttachmentFiles.read(resolver, uri)
            val attachment = try {
                store.addFile(picked.bytes, picked.name, picked.mime)
            } finally {
                picked.bytes.fill(0)
            }
            addedFiles.add(attachment.id)
            ui.update { it.copy(status = null) }
            ui.scope.launch { onAdded(attachment) }
        }
    }

    /** A file that cannot be checked counts as not ready. */
    override suspend fun fileReady(attachments: List<Attachment>): Set<String> = withContext(Dispatchers.IO) {
        attachments.filter { runCatching { store.isFileComplete(it) }.getOrDefault(false) }.mapTo(HashSet()) { it.id }
    }

    override fun downloadFile(attachment: Attachment, uri: Uri?) {
        endFilePick()
        if (uri == null || !store.isUnlocked) return
        ui.launchOperation("Odszyfrowuję plik…") {
            // FILE_CORRUPTED and VAULT_LOCKED end the operation with their text on the status line.
            val bytes = try {
                store.readFile(attachment)
            } catch (e: IOException) {
                throw IOException(AttachmentFiles.VAULT_READ_FAILED, e)
            }
            try {
                AttachmentFiles.write(resolver, uri, bytes)
            } finally {
                bytes.fill(0)
            }
            ui.showStatus("Zapisano plik ${attachment.name}.")
        }
    }

    /** Deletes the files added in the form, except the [keep] ones (saved in the entry). Blocking: for code already off the main thread. */
    fun discardAdded(keep: Set<String> = emptySet()) = discardFiles(takeAdded(keep))

    /** The ids are taken now, the files deleted off the main thread. */
    fun discardAddedInBackground() {
        val ids = takeAdded()
        if (ids.isEmpty()) return
        ui.scope.launch { withContext(Dispatchers.IO) { discardFiles(ids) } }
    }

    private fun takeAdded(keep: Set<String> = emptySet()): Set<String> =
        synchronized(addedFiles) { (addedFiles - keep).also { addedFiles.clear() } }

    /** Deletes [ids] (blocking). A failure goes to the log and the ids are kept for a later discard. */
    private fun discardFiles(ids: Set<String>) {
        if (ids.isEmpty()) return
        try {
            store.discardFiles(ids)
        } catch (e: Exception) {
            Log.w(TAG, "Could not discard files added to a form", e)
            synchronized(addedFiles) { addedFiles.addAll(ids) }
        }
    }

    private companion object {
        const val TAG = "AttachmentsModel"
    }
}
