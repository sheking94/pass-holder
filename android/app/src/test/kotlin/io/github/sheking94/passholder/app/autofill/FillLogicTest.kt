package io.github.sheking94.passholder.app.autofill

import android.app.PendingIntent
import android.content.Intent
import android.service.autofill.FillResponse
import android.service.autofill.SaveInfo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.app.AppSigners
import io.github.sheking94.passholder.app.LeaveLock
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.app.TEST_APP_CERT
import io.github.sheking94.passholder.app.TestAppSigners
import io.github.sheking94.passholder.app.TestSecretWrapper
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.AutofillNode
import io.github.sheking94.passholder.core.autofill.FieldDescriptor
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
        app.appSigners = TestAppSigners
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
            "1",
            EntryContentV3("GitHub", "", LoginFields("jkowalski", "s3cret", urls = listOf("https://github.com")), emptyList()),
        )
    }

    // SaveInfo getters are @hide, so they are read by reflection.
    private fun saveInfo(r: FillResponse): SaveInfo? = r.javaClass.getMethod("getSaveInfo").invoke(r) as SaveInfo?
    private fun clientState(r: FillResponse): android.os.Bundle? = r.javaClass.getMethod("getClientState").invoke(r) as android.os.Bundle?
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
        val state = clientState(response)!!.saveSpecIds()!!
        assertEquals(autofillId(2), state.password)
        assertEquals(autofillId(1), state.username)
        assertEquals(AppRequest("com.android.chrome", "github.com", "https"), state.app)
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

    private val site = AppRequest("com.android.chrome", "github.com", "https")

    @Test
    fun `contact form with password carries save info`() {
        vaultWithLogin()
        val nodes = listOf(
            AutofillNode(autofillId(1), FieldDescriptor(autocomplete = listOf("given-name"), type = "text", name = "first"), false),
            AutofillNode(autofillId(2), FieldDescriptor(autocomplete = listOf("tel"), type = "tel", name = "phone"), false),
            AutofillNode(autofillId(3), FieldDescriptor(autocomplete = listOf("email"), type = "email", name = "email"), false),
            AutofillNode(autofillId(4), FieldDescriptor(type = "password", name = "password"), false),
        )
        val response = respond(app, ParsedRequest(site, nodes), null, auth)
        assertNotNull(response)
        assertEquals(listOf(autofillId(4)), requiredIds(saveInfo(response!!)!!))
    }

    @Test
    fun `new password only screen gets save info only`() {
        vaultWithLogin()
        val nodes = listOf(AutofillNode(autofillId(5), FieldDescriptor(autocomplete = listOf("new-password"), type = "password"), false))
        val response = respond(app, ParsedRequest(site, nodes), null, auth)!!
        assertEquals(0, datasetCount(response))
        assertEquals(listOf(autofillId(5)), requiredIds(saveInfo(response)!!))

        app.phoneStore.lock()
        val locked = respond(app, ParsedRequest(site, nodes), null, auth)!!
        assertEquals(0, authCalls)
        assertNotNull(saveInfo(locked))
    }

    @Test
    fun `registration without username has no optional ids`() {
        vaultWithLogin()
        val nodes = listOf(
            AutofillNode(autofillId(5), FieldDescriptor(autocomplete = listOf("new-password"), type = "password"), false),
            AutofillNode(autofillId(6), FieldDescriptor(autocomplete = listOf("new-password"), type = "password"), false),
        )
        val info = saveInfo(respond(app, ParsedRequest(site, nodes), null, auth)!!)!!
        assertEquals(listOf(autofillId(5)), requiredIds(info))
        assertTrue(optionalIds(info).isEmpty())
    }

    @Test
    fun `new password only screen without save prompt or vault gets nothing`() {
        val nodes = listOf(AutofillNode(autofillId(5), FieldDescriptor(autocomplete = listOf("new-password"), type = "password"), false))
        assertNull(respond(app, ParsedRequest(site, nodes), null, auth))
        vaultWithLogin()
        assertNull(respond(app, ParsedRequest(AppRequest(app.packageName, null, null), nodes), null, auth))
        app.settings.askToSave = false
        assertNull(respond(app, ParsedRequest(site, nodes), null, auth))
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
    fun `browser package with another certificate gets no login by web domain`() {
        vaultWithLogin()
        // V3-S3: an app installed under the package of a browser that is not on the phone.
        app.appSigners = AppSigners { setOf("ff") }
        assertEquals(0, datasetCount(respond(app, request(), null, auth)!!))
    }

    @Test
    fun `app login only for the remembered certificate, remembered on first fill`() {
        app.phoneStore.createVault("haslo-glowne-1")
        app.phoneStore.upsertContent(
            "1",
            EntryContentV3("Bank", "", LoginFields("jan", "s3cret", androidApps = listOf("pl.bank")), emptyList()),
        )
        val bank = { respond(app, request(pkg = "pl.bank", domain = null), null, auth)!! }
        assertNull(app.appTrust.remembered("pl.bank"))
        assertEquals(1, datasetCount(bank()))
        assertEquals(setOf(TEST_APP_CERT), app.appTrust.remembered("pl.bank"))
        // The real app replaced by one with the same package and another certificate.
        app.appSigners = AppSigners { setOf("ff") }
        assertEquals(0, datasetCount(bank()))
        assertEquals(setOf(TEST_APP_CERT), app.appTrust.remembered("pl.bank"))
    }

    @Test
    fun `app with no login tied to it is not remembered`() {
        vaultWithLogin()
        respond(app, request(pkg = "com.other", domain = null), null, auth)
        assertNull(app.appTrust.remembered("com.other"))
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
