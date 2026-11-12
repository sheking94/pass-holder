package io.github.sheking94.passholder.app.autofill

import android.app.PendingIntent
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.app.LeaveLock
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.app.TestSecretWrapper
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.AutofillNode
import io.github.sheking94.passholder.core.autofill.FieldDescriptor
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import android.service.autofill.FillResponse
import android.service.autofill.SaveInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class FillLogicTest {
    private val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
    private var authCalls = 0
    private val auth = {
        authCalls++
        PendingIntent.getActivity(app, 0, Intent(app, AutofillUnlockActivity::class.java), PendingIntent.FLAG_IMMUTABLE).intentSender
    }
    private val loginNodes = listOf(
        AutofillNode(autofillId(1), FieldDescriptor(type = "text", name = "username"), false),
        AutofillNode(autofillId(2), FieldDescriptor(type = "password", name = "password"), false),
    )
    private fun request(pkg: String = "com.android.chrome", domain: String? = "github.com") =
        ParsedRequest(AppRequest(pkg, domain, "https"), loginNodes)

    @Before
    fun setUp() {
        app.secretWrapper = TestSecretWrapper
        app.phoneStore.disconnect()
    }

    @After
    fun tearDown() {
        app.leaveLock.cancel()
        app.settings.askToSave = true
    }

    private fun vaultWithLogin() {
        app.phoneStore.createVault("haslo-glowne-1")
        app.phoneStore.upsertContent(
            "1", EntryContentV3("GitHub", "", LoginFields("jkowalski", "s3cret", urls = listOf("https://github.com")), emptyList()),
        )
    }

    // SaveInfo getters are @hide, so they are read by reflection.
    private fun saveInfo(r: FillResponse): SaveInfo? = r.javaClass.getMethod("getSaveInfo").invoke(r) as SaveInfo?
    private fun datasetCount(r: FillResponse): Int = (r.javaClass.getMethod("getDatasets").invoke(r) as List<*>?)?.size ?: 0
    private fun ids(a: Array<*>?) = a?.toList() ?: emptyList<Any?>()
    private fun requiredIds(i: SaveInfo) = ids(i.javaClass.getMethod("getRequiredIds").invoke(i) as Array<*>?)
    private fun optionalIds(i: SaveInfo) = ids(i.javaClass.getMethod("getOptionalIds").invoke(i) as Array<*>?)

    @Test
    fun `unlocked with matches carries save info`() {
        vaultWithLogin()
        val response = respond(app, request(), null, auth)!!
        assertEquals(1, datasetCount(response))
        val info = saveInfo(response)!!
        assertEquals(listOf(autofillId(2)), requiredIds(info))
        assertEquals(listOf(autofillId(1)), optionalIds(info))
        assertEquals(SaveInfo.SAVE_DATA_TYPE_PASSWORD or SaveInfo.SAVE_DATA_TYPE_USERNAME, info.javaClass.getMethod("getType").invoke(info))
        assertEquals(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE, info.javaClass.getMethod("getFlags").invoke(info))
    }

    @Test
    fun `password only screen has no optional ids`() {
        vaultWithLogin()
        val nodes = listOf(AutofillNode(autofillId(2), FieldDescriptor(type = "password", name = "password"), false))
        val info = saveInfo(respond(app, ParsedRequest(AppRequest("com.android.chrome", "github.com", "https"), nodes), null, auth)!!)!!
        assertEquals(listOf(autofillId(2)), requiredIds(info))
        assertTrue(optionalIds(info).isEmpty())
    }

    @Test
    fun `no matching entry gives save info only`() {
        vaultWithLogin()
        val response = respond(app, request(domain = "example.com"), null, auth)!!
        assertEquals(0, datasetCount(response))
        assertNotNull(saveInfo(response))
    }

    @Test
    fun `locked vault carries save info`() {
        vaultWithLogin()
        app.phoneStore.lock()
        assertNotNull(saveInfo(respond(app, request(), null, auth)!!))
    }

    @Test
    fun `save prompt off gives no save info`() {
        vaultWithLogin()
        app.settings.askToSave = false
        val matching = respond(app, request(), null, auth)!!
        assertEquals(1, datasetCount(matching))
        assertNull(saveInfo(matching))
        assertNull(respond(app, request(domain = "example.com"), null, auth))
        app.phoneStore.lock()
        assertNull(saveInfo(respond(app, request(), null, auth)!!))
    }

    @Test
    fun `own app and no vault still get nothing`() {
        assertNull(respond(app, request(), null, auth))
        vaultWithLogin()
        assertNull(respond(app, request(pkg = app.packageName, domain = null), null, auth))
    }

    @Test
    fun `non login screens carry no save info`() {
        vaultWithLogin()
        val nodes = listOf(AutofillNode(autofillId(3), FieldDescriptor(type = "text", name = "cc-number"), false))
        val response = respond(app, ParsedRequest(AppRequest("com.android.chrome", "github.com", "https"), nodes), null, auth)
        assertNull(response?.let(::saveInfo))
    }

    @Test
    fun `client state keeps field ids and app`() {
        val spec = saveSpecFor(app, request())!!
        val ids = spec.toClientState().saveSpecIds()!!
        assertEquals(autofillId(2), ids.password)
        assertEquals(autofillId(1), ids.username)
        assertEquals(AppRequest("com.android.chrome", "github.com", "https"), ids.app)

        val noUser = SaveSpec(io.github.sheking94.passholder.core.save.SaveFields(autofillId(2), null), AppRequest("com.x", null, null))
        val back = noUser.toClientState().saveSpecIds()!!
        assertNull(back.username)
        assertEquals(AppRequest("com.x", null, null), back.app)
        assertNull(android.os.Bundle().saveSpecIds())
    }

    @Test
    fun `own app gets nothing`() {
        vaultWithLogin()
        assertNull(respond(app, request(pkg = app.packageName, domain = null), null, auth))
    }

    @Test
    fun `no vault gets nothing`() {
        assertNull(respond(app, request(), null, auth))
    }

    @Test
    fun `screen without fillable fields gets nothing`() {
        vaultWithLogin()
        assertNull(respond(app, ParsedRequest(AppRequest("com.android.chrome", "github.com", "https"), emptyList()), null, auth))
    }

    @Test
    fun `locked vault gets the unlock prompt`() {
        vaultWithLogin()
        app.phoneStore.lock()
        assertNotNull(respond(app, request(), null, auth))
        assertEquals(1, authCalls)
    }

    @Test
    fun `unlocked vault gets matching logins only`() {
        vaultWithLogin()
        assertNotNull(respond(app, request(), null, auth))
        assertEquals(0, datasetCount(respond(app, request(domain = "example.com"), null, auth)!!))
        assertEquals(0, authCalls)
    }

    @Test
    fun `unlocked vault past the 60 s deadline gets the unlock prompt and locks`() {
        vaultWithLogin()
        // The timer never ran (deep sleep, frozen app), but the clock went on past the deadline (D1).
        var t = 0L
        app.leaveLock = LeaveLock(app.phoneStore, now = { t }).also { it.schedule(LeaveLock.DELAY_MS) }
        assertNotNull(respond(app, request(), null, auth))
        assertEquals("before the deadline: suggestions", 0, authCalls)
        t = LeaveLock.DELAY_MS
        assertNotNull(respond(app, request(), null, auth))
        assertEquals("past the deadline: the unlock prompt", 1, authCalls)
        assertFalse(app.phoneStore.isUnlocked)
    }

    @Test
    fun `a new unlock prompt does not cancel the one still shown`() {
        // Each locked response holds its own sender; the next request must not turn an earlier one dead.
        val first = unlockPendingIntent(app)
        unlockPendingIntent(app)
        assertFalse(shadowOf(first).isCanceled)
    }
}
