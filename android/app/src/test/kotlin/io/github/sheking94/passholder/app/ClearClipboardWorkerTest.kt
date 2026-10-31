package io.github.sheking94.passholder.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import androidx.work.testing.WorkManagerTestInitHelper
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

    private fun runWorker(copiedPassword: String) = runBlocking {
        TestListenableWorkerBuilder<ClearClipboardWorker>(context)
            .setInputData(workDataOf(ClearClipboardWorker.KEY_HASH to SecureClipboard.sha256(copiedPassword)))
            .build()
            .doWork()
    }

    @Test
    fun `clears the clipboard when it still holds the copied password`() {
        SecureClipboard.copy(context, "hasło", "hunter2", sensitive = true)
        assertEquals(ListenableWorker.Result.success(), runWorker("hunter2"))
        assertFalse(clipboard.hasPrimaryClip() && clipboard.primaryClip!!.getItemAt(0).text?.isNotEmpty() == true)
    }

    @Test
    fun `leaves something you copied later alone`() {
        SecureClipboard.copy(context, "hasło", "hunter2", sensitive = true)
        clipboard.setPrimaryClip(ClipData.newPlainText("notatka", "lista zakupów"))
        runWorker("hunter2")
        assertEquals("lista zakupów", clipboard.primaryClip!!.getItemAt(0).text.toString())
    }

    @Test
    fun `marks a copied password as sensitive`() {
        SecureClipboard.copy(context, "hasło", "hunter2", sensitive = true)
        assertEquals(true, clipboard.primaryClip!!.description.extras?.getBoolean("android.content.extra.IS_SENSITIVE"))
    }
}
