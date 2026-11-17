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
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

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
        val tiramisu = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        val key = if (tiramisu) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
        clip.description.extras = PersistableBundle().apply { putBoolean(key, true) }
        clipboard(context).setPrimaryClip(clip)
        scheduleClear(context, password)
    }

    private fun clipboard(context: Context) = context.getSystemService(ClipboardManager::class.java)

    private fun scheduleClear(context: Context, text: String) {
        // WorkManager runs the job even if the app is closed or the process was killed in the meantime.
        // WorkManager stores the job in its database on disk: only an HMAC of the password goes there, with a key
        // that lives in this process's memory, so the stored value cannot be checked against a dictionary.
        val request = OneTimeWorkRequestBuilder<ClearClipboardWorker>()
            .setInitialDelay(CLEAR_AFTER_MINUTES, TimeUnit.MINUTES)
            .setInputData(workDataOf(ClearClipboardWorker.KEY_TAG to tag(text), ClearClipboardWorker.KEY_ID to keyId))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    /** Random key of this process, never written anywhere: a new process has another one. */
    private val hmacKey = ByteArray(32).also { SecureRandom().nextBytes(it) }

    /** Public name of [hmacKey]: the worker compares it to see whether the process (and the key) is still the same. */
    internal val keyId: String = Encoding.toHex(ByteArray(8).also { SecureRandom().nextBytes(it) })

    /** HMAC-SHA256 of the text with the process key, as hex. */
    internal fun tag(text: String): String {
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(hmacKey, "HmacSHA256")) }
        return Encoding.toHex(mac.doFinal(text.toByteArray()))
    }
}

/**
 * Clears the clipboard if it still holds the copied password.
 * Since Android 10 an app in the background cannot read the clipboard; then we cannot tell whether you
 * copied something else in the meantime, and we clear it anyway: a password left behind is the worse outcome.
 * The same when the process was restarted since the copy: the HMAC key is gone, so we cannot compare either.
 */
class ClearClipboardWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    // ClipboardManager calls are plain IPC to the system and work from this background thread.
    override suspend fun doWork(): Result {
        val clipboard = applicationContext.getSystemService(ClipboardManager::class.java)
        val current = runCatching { clipboard.primaryClip?.getItemAt(0)?.coerceToText(applicationContext)?.toString() }.getOrNull()
        val sameProcess = inputData.getString(KEY_ID) == SecureClipboard.keyId
        if (current != null && sameProcess && !sameTag(SecureClipboard.tag(current), inputData.getString(KEY_TAG))) return Result.success()
        val canClear = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        if (canClear) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
        return Result.success()
    }

    private fun sameTag(a: String, b: String?) = b != null && MessageDigest.isEqual(a.toByteArray(), b.toByteArray())

    companion object {
        const val KEY_TAG = "tag"
        const val KEY_ID = "keyId"
    }
}
