package io.github.sheking94.passholder.app

import android.content.pm.PackageInfo
import android.content.pm.Signature
import android.content.pm.SigningInfo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.core.autofill.AppRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Security review V3-S3: certificates read from PackageManager and remembered per package. */
@RunWith(AndroidJUnit4::class)
class AppTrustTest {
    private val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
    private val cert = Signature(byteArrayOf(1, 2, 3))
    private val old = Signature(byteArrayOf(9, 9))

    private fun install(pkg: String, block: PackageInfo.() -> Unit) =
        shadowOf(app.packageManager).installPackage(PackageInfo().apply { packageName = pkg; block() })

    @Test
    @Config(sdk = [35])
    fun `signing history read on Android 9 and later`() {
        install("pl.bank") {
            signingInfo = SigningInfo().also { shadowOf(it).setSignatures(arrayOf(cert)); shadowOf(it).setPastSigningCertificates(arrayOf(old, cert)) }
        }
        assertEquals(setOf(sha256Hex(old.toByteArray()), sha256Hex(cert.toByteArray())), SystemAppSigners(app).certs("pl.bank"))
        assertNull(SystemAppSigners(app).certs("pl.missing"))
    }

    @Test
    @Config(sdk = [27])
    fun `signatures read below Android 9`() {
        @Suppress("DEPRECATION")
        install("pl.bank") { signatures = arrayOf(cert) }
        assertEquals(setOf(sha256Hex(cert.toByteArray())), SystemAppSigners(app).certs("pl.bank"))
    }

    @Test
    @Config(sdk = [35])
    fun `remember if new keeps the first certificate, remember replaces it`() {
        var current = setOf("aa")
        app.appSigners = AppSigners { current }
        val trust = app.appTrust
        trust.rememberIfNew("pl.bank")
        current = setOf("bb")
        trust.rememberIfNew("pl.bank")
        assertEquals(setOf("aa"), trust.remembered("pl.bank"))
        assertFalse(trust.verify(AppRequest("pl.bank", null, null)).appVerified)
        trust.remember("pl.bank")
        assertEquals(setOf("bb"), trust.remembered("pl.bank"))
        assertTrue(trust.verify(AppRequest("pl.bank", null, null)).appVerified)
    }

    @Test
    @Config(sdk = [35])
    fun `unreadable package is neither remembered nor trusted`() {
        app.appSigners = AppSigners { null }
        app.appTrust.rememberIfNew("pl.bank")
        assertNull(app.appTrust.remembered("pl.bank"))
        assertFalse(app.appTrust.verify(AppRequest("pl.bank", null, null)).appVerified)
    }
}
