package io.github.sheking94.passholder.app

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.core.content.edit
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.p2p.LocalAddresses
import io.github.sheking94.passholder.core.p2p.PhoneSync
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import io.github.sheking94.passholder.core.p2p.SecretWrapper
import kotlinx.serialization.json.Json

/** Lives as long as the app process. Holds the one PhoneVaultStore, so the vault stays unlocked across screen rotations. */
class PassHolderApp : Application() {
    /** The vault the phone owns (and serves to the extension). Tests replace it with [replacePhoneStore]. */
    lateinit var phoneStore: PhoneVaultStore
        private set
    /**
     * Wraps the phone's identity key on disk. Replaced in tests (Robolectric has no Android Keystore); the store
     * reads this property on every use, so replacing it after onCreate works.
     */
    var secretWrapper: SecretWrapper = KeystoreSecretWrapper()
    /** The port of sync mode; tests set 0 (any free port). */
    var syncPort: Int = PhoneSync.PORT
    /**
     * The clock of the vault store and of sync mode (idle stop, code expiry and countdown); tests move it forward.
     * One clock for both, so the code's expiry time (set by the store) and the countdown agree.
     */
    var clock: () -> Long = System::currentTimeMillis
    /** The phone's addresses shown in sync mode, for the port actually bound; tests use loopback only. */
    var syncAddresses: (boundPort: Int) -> List<String> = { LocalAddresses.list(it) }
    lateinit var settings: Settings
        private set
    /** Replaced in tests: Robolectric has neither the Android Keystore nor a fingerprint reader. */
    lateinit var biometric: BiometricUnlock
    /** Locks the vault 60 s after leaving the app, when the delay is on in the settings. */
    lateinit var leaveLock: LeaveLock
    /** The launcher apps a login can be tied to; tests replace it. */
    var installedApps: InstalledApps = SystemInstalledApps(this)
    var fingerprintPrompt: FingerprintPrompt = SystemFingerprintPrompt

    override fun onCreate() {
        super.onCreate()
        // filesDir is private to the app; other apps cannot read it (and the vault is encrypted anyway).
        // Constructing the store reads host.json but does not unwrap anything, so the Keystore is not touched here.
        phoneStore = PhoneVaultStore(
            filesDir,
            object : SecretWrapper {
                override fun wrap(secret: ByteArray) = secretWrapper.wrap(secret)
                override fun unwrap(wrapped: String) = secretWrapper.unwrap(wrapped)
            },
            now = { clock() },
            // The extension only gets "internal error"; the cause goes to logcat.
            onError = { Log.w(TAG, "Sync mode error", it) },
        )
        settings = Settings(this)
        biometric = BiometricUnlock(this)
        leaveLock = LeaveLock(phoneStore)
    }

    companion object {
        const val TAG = "PassHolder"
    }

    /** For tests: another store, with a [LeaveLock] that locks that store and not the old one. */
    internal fun replacePhoneStore(store: PhoneVaultStore) {
        phoneStore = store
        leaveLock = LeaveLock(store)
    }
}

/** Non-secret preferences. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var generatorOptions: GeneratorOptions
        get() = prefs.getString("generator", null)?.let { runCatching { Json.decodeFromString<GeneratorOptions>(it) }.getOrNull() } ?: GeneratorOptions()
        set(value) = prefs.edit { putString("generator", Json.encodeToString(value)) }

    /** Leaving the app locks the vault after 60 s instead of at once. On by default. */
    var lockDelay: Boolean
        get() = prefs.getBoolean("lockDelay", true)
        set(value) = prefs.edit { putBoolean("lockDelay", value) }
}
