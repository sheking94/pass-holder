package io.github.sheking94.passholder.app

import android.app.Application
import android.content.Context
import androidx.core.content.edit
import io.github.sheking94.passholder.core.FileStore
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.VaultStore
import kotlinx.serialization.json.Json
import java.io.File

/** Lives as long as the app process. Holds the one VaultStore, so the vault stays unlocked across screen rotations. */
class PassHolderApp : Application() {
    lateinit var vaultStore: VaultStore
        private set
    lateinit var settings: Settings
        private set
    /** Replaced in tests: Robolectric has neither the Android Keystore nor a fingerprint reader. */
    lateinit var biometric: BiometricUnlock
    /** Locks the vault 60 s after leaving the app, when the delay is on in the settings. */
    lateinit var leaveLock: LeaveLock
    var fingerprintPrompt: FingerprintPrompt = SystemFingerprintPrompt

    override fun onCreate() {
        super.onCreate()
        // filesDir is private to the app; other apps cannot read it (and the vault is encrypted anyway).
        vaultStore = VaultStore(FileStore(File(filesDir, "vault")))
        settings = Settings(this)
        biometric = BiometricUnlock(this)
        leaveLock = LeaveLock(vaultStore)
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
