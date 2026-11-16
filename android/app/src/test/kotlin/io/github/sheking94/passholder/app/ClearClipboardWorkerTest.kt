package io.github.sheking94.passholder.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.workDataOf
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class ClearClipboardWorkerTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val clipboard = context.getSystemService(ClipboardManager::class.java)

    /** WorkManager in test mode: clipboard-clearing jobs are queued, not run on a timer. */
    @Before
    fun initWorkManager() = WorkManagerTestInitHelper.initializeTestWorkManager(ApplicationProvider.getApplicationContext())

    private fun runWorker(copiedPassword: String, keyId: String = SecureClipboard.keyId) = runBlocking {
        TestListenableWorkerBuilder<ClearClipboardWorker>(context)
            .setInputData(
                workDataOf(
                    ClearClipboardWorker.KEY_TAG to SecureClipboard.tag(copiedPassword),
                    ClearClipboardWorker.KEY_ID to keyId,
                ),
            )
            .build()
            .doWork()
    }

    @Test
    fun `clears the clipboard when it still holds the copied password`() {
        SecureClipboard.copyPassword(context, "hasło", "hunter2")
        assertEquals(ListenableWorker.Result.success(), runWorker("hunter2"))
        assertFalse(clipboard.hasPrimaryClip() && clipboard.primaryClip!!.getItemAt(0).text?.isNotEmpty() == true)
    }

    @Test
    fun `leaves something you copied later alone`() {
        SecureClipboard.copyPassword(context, "hasło", "hunter2")
        clipboard.setPrimaryClip(ClipData.newPlainText("notatka", "lista zakupów"))
        runWorker("hunter2")
        assertEquals("lista zakupów", clipboard.primaryClip!!.getItemAt(0).text.toString())
    }

    @Test
    fun `clears anyway when the process restarted and the key is gone`() {
        SecureClipboard.copyPassword(context, "hasło", "hunter2")
        clipboard.setPrimaryClip(ClipData.newPlainText("notatka", "lista zakupów"))
        runWorker("hunter2", keyId = "inny-proces")
        assertFalse(clipboard.hasPrimaryClip() && clipboard.primaryClip!!.getItemAt(0).text?.isNotEmpty() == true)
    }

    @Test
    fun `the tag is keyed, not a plain hash of the password`() {
        val plainSha256 = java.security.MessageDigest.getInstance("SHA-256").digest("hunter2".toByteArray())
            .joinToString("") { "%02x".format(it) }
        assertNotEquals(plainSha256, SecureClipboard.tag("hunter2"))
        assertEquals(SecureClipboard.tag("hunter2"), SecureClipboard.tag("hunter2"))
    }

    @Test
    fun `marks a copied password as sensitive`() {
        SecureClipboard.copyPassword(context, "hasło", "hunter2")
        assertEquals(true, clipboard.primaryClip!!.description.extras?.getBoolean("android.content.extra.IS_SENSITIVE"))
    }
}
