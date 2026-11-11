package io.github.sheking94.passholder.app.autofill

import android.app.PendingIntent
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.app.TestSecretWrapper
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.AutofillNode
import io.github.sheking94.passholder.core.autofill.FieldDescriptor
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
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

    private fun vaultWithLogin() {
        app.phoneStore.createVault("haslo-glowne-1")
        app.phoneStore.upsertContent(
            "1", EntryContentV3("GitHub", "", LoginFields("jkowalski", "s3cret", urls = listOf("https://github.com")), emptyList()),
        )
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
        assertNull(respond(app, request(domain = "example.com"), null, auth))
        assertEquals(0, authCalls)
    }
}
