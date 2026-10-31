package io.github.sheking94.passholder.app

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import io.github.sheking94.passholder.core.Encoding
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Copies to the clipboard; passwords are marked sensitive and cleared after a minute, like in the extension. */
object SecureClipboard {
    const val CLEAR_AFTER_MINUTES = 1L
    private const val WORK_NAME = "clear-clipboard"

    fun copyText(context: Context, label: String, text: String) {
        clipboard(context).setPrimaryClip(ClipData.newPlainText(label, text))
    }

    /** Copies a password marked as sensitive and schedules clearing it after [CLEAR_AFTER_MINUTES]. */
    fun copyPassword(context: Context, label: String, password: String) {
        val clip = ClipData.newPlainText(label, password)
        // Android 13+ then hides the text in the "copied" preview and keyboard suggestions.
        val key = if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
        clip.description.extras = PersistableBundle().apply { putBoolean(key, true) }
        clipboard(context).setPrimaryClip(clip)
        scheduleClear(context, password)
    }

    private fun clipboard(context: Context) = context.getSystemService(ClipboardManager::class.java)

    private fun scheduleClear(context: Context, text: String) {
        // WorkManager runs the job even if the app is closed or the process was killed in the meantime.
        // Only a hash of the password goes into the job, which WorkManager stores in its database.
        val request = OneTimeWorkRequestBuilder<ClearClipboardWorker>()
            .setInitialDelay(CLEAR_AFTER_MINUTES, TimeUnit.MINUTES)
            .setInputData(workDataOf(ClearClipboardWorker.KEY_HASH to sha256(text)))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    internal fun sha256(text: String): String =
        Encoding.toHex(MessageDigest.getInstance("SHA-256").digest(text.toByteArray()))
}

/**
 * Clears the clipboard if it still holds the copied password.
 * Since Android 10 an app in the background cannot read the clipboard; then we cannot tell whether you
 * copied something else in the meantime, and we clear it anyway: a password left behind is the worse outcome.
 */
class ClearClipboardWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    // ClipboardManager calls are plain IPC to the system and work from this background thread.
    override suspend fun doWork(): Result {
        val clipboard = applicationContext.getSystemService(ClipboardManager::class.java)
        val current = runCatching { clipboard.primaryClip?.getItemAt(0)?.coerceToText(applicationContext)?.toString() }.getOrNull()
        if (current != null && SecureClipboard.sha256(current) != inputData.getString(KEY_HASH)) return Result.success()
        if (Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
        return Result.success()
    }

    companion object {
        const val KEY_HASH = "hash"
    }
}
