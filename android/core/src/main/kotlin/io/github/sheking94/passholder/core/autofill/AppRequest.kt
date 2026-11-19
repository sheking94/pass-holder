package io.github.sheking94.passholder.core.autofill

/**
 * Who asks for a fill or a save. [packageName], [webDomain] and [webScheme] are what the app's view structure claims;
 * the two flags are what the phone checked against the app's signing certificate (security review V3-S3), see
 * [verifyApp]. Both default to false, so a request nobody checked trusts neither the web domain nor `androidApps`.
 */
data class AppRequest(
    val packageName: String,
    val webDomain: String?,
    val webScheme: String?,
    /** [packageName] is in [TRUSTED_BROWSERS] and signed with one of its certificates: [webDomain] counts. */
    val browserVerified: Boolean = false,
    /** The app is signed with the certificate remembered for [packageName] (or none is remembered yet): `androidApps` count. */
    val appVerified: Boolean = false,
)

/**
 * Browsers whose reported web domain is trusted (spec 3.2): package to the SHA-256 digests (lowercase hex) of its
 * release signing certificates. Source: Google's list of privileged browsers for passkeys
 * (gstatic.com/gpm-passkeys-privileged-apps/apps.json, read 2026-11-15); a browser that rotates its key keeps the
 * old certificate in its signing history, so it still matches.
 */
val TRUSTED_BROWSERS: Map<String, Set<String>> = mapOf(
    "com.android.chrome" to setOf("f0fd6c5b410f25cb25c3b53346c8972fae30f8ee7411df910480ad6b2d60db83"),
    "com.chrome.beta" to setOf(
        "da633d34b69e63ae2103b49d53ce052fc5f7f3c53aab94fdc2a208bdfd14249c",
        "3d7a1223019aa39d9ea0e3436ab7c0896bfb4fb679f4de5fe7c23f326c8f994a",
    ),
    "com.chrome.dev" to setOf(
        "9044ee5fee4bbc5e21dd44665431c4eb1f1f71a32716a0bc927bcbb39233cabf",
        "3d7a1223019aa39d9ea0e3436ab7c0896bfb4fb679f4de5fe7c23f326c8f994a",
    ),
    "com.chrome.canary" to setOf("2019dfa1fb23efbf70c5bcd1443c5beab04f3f2ff4366e9ac1e3457639a24cfc"),
    "org.mozilla.firefox" to setOf("a78b62a5165b4494b2fead9e76a280d22d937fee6251aece599446b2ea319b04"),
    "org.mozilla.firefox_beta" to setOf("a78b62a5165b4494b2fead9e76a280d22d937fee6251aece599446b2ea319b04"),
    "org.mozilla.focus" to setOf("6203a473be36d64ee37f87fa500edbc79eab930610ab9b9fa4ca7d5c1f1b4ffc"),
    "com.microsoft.emmx" to setOf("01e1999710a82c2749b4d50c445dc85d670b6136089d0a766a73827c82a1eac9"),
    "com.brave.browser" to setOf("9c2db70513515fdbfbbc585b3edf3d7123d4dc67c94ffd306361c1d79bbf18ac"),
    "com.sec.android.app.sbrowser" to setOf("34df0e7a9f1cf1892e45c056b4973cd81ccf148a4050d11aea4ac5a65f900a42"),
    "com.opera.browser" to setOf("5d6afbf87f652af04647ada0df634cf22370900b164b09d50bd23aa2cb5285b8"),
    "com.duckduckgo.mobile.android" to setOf("bb7bb31c573c46a1da7fc5c528a6acf432108456feec50810c7f33694eb3d2d4"),
    "com.vivaldi.browser" to setOf("e8a78544655ba8c09817f732768f5689b1662ec4b2bc5a0bc0ec138d33ca3d1e"),
)

/**
 * The request with its flags set from the app's certificates (security review V3-S3). [certs]: SHA-256 digests of
 * the package's signing certificates as the phone reads them (including its signing history), null when the package
 * cannot be read; [pinned]: the digests remembered for the package when it was tied to a login, null when none.
 * Trust on first use: a package with nothing remembered yet is trusted if it can be read at all.
 */
fun verifyApp(request: AppRequest, certs: Set<String>?, pinned: Set<String>?): AppRequest {
    val known = TRUSTED_BROWSERS[request.packageName]
    val browser = certs != null && known != null && certs.any { it in known }
    val app = certs != null && (pinned == null || certs.any { it in pinned })
    return request.copy(browserVerified = browser, appVerified = app)
}
