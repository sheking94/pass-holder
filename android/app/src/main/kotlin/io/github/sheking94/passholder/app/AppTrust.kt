package io.github.sheking94.passholder.app

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import androidx.core.content.edit
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.verifyApp

/** SHA-256 digests (lowercase hex) of an installed package's signing certificates; null when it cannot be read. */
fun interface AppSigners {
    fun certs(packageName: String): Set<String>?
}

/**
 * From PackageManager. Android 9+: the signing history (a rotated key keeps the old certificate there) or, for an
 * app with several signers, all of them; below: the signatures. A package hidden by package visibility reads as null.
 */
class SystemAppSigners(private val context: Context) : AppSigners {
    override fun certs(packageName: String): Set<String>? = try {
        val pm = context.packageManager
        val signatures: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo
            if (info == null) {
                null
            } else if (info.hasMultipleSigners()) {
                info.apkContentsSigners
            } else {
                info.signingCertificateHistory
            }
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES).signatures
        }
        signatures?.takeIf { it.isNotEmpty() }?.map { Encoding.sha256Hex(it.toByteArray()) }?.toSet()
    } catch (_: PackageManager.NameNotFoundException) {
        null
    }
}

/**
 * Who the phone trusts to ask for logins (security review V3-S3): browsers by their known certificates, the apps of
 * a login by the certificate remembered when the app was tied to it. The remembered digests are not secret; they
 * live in the app's private preferences, where no other app can change them.
 */
class AppTrust(context: Context, private val signers: () -> AppSigners) {
    private val prefs = context.getSharedPreferences("app_certs", Context.MODE_PRIVATE)

    /** [request] with the flags set from the installed app (read anew on every call). */
    fun verify(request: AppRequest): AppRequest = verifyApp(request, signers().certs(request.packageName), remembered(request.packageName))

    fun remembered(packageName: String): Set<String>? = prefs.getStringSet(packageName, null)?.toSet()

    /** Remembers the certificates [packageName] has now, if none are remembered yet (trust on first use). */
    fun rememberIfNew(packageName: String) {
        if (packageName.isEmpty() || remembered(packageName) != null) return
        remember(packageName)
    }

    /** Remembers the certificates [packageName] has now, replacing older ones: the user picked this installed app. */
    fun remember(packageName: String) {
        val certs = signers().certs(packageName) ?: return
        prefs.edit { putStringSet(packageName, certs) }
    }
}
