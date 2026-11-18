package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.AtomicFiles
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.KdfParams
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Protects a secret at rest; on Android backed by the Keystore, in tests by a plain Base64 stand-in. */
interface SecretWrapper {
    fun wrap(secret: ByteArray): String
    fun unwrap(wrapped: String): ByteArray
}

@Serializable
data class StoredDevice(
    val deviceId: String,
    val name: String,
    /** Base64. */
    val staticPublicKey: String,
    val pairedAt: Long,
    val lastSyncAt: Long? = null,
)

/** The vault key wrapped with the master password, and the KDF parameters that unwrap it. */
data class WrappedVault(val kdf: KdfParams, val wrappedVaultKey: String)

/** What a [HostState] holds, read from its nullable fields ([HostState.phase]). */
sealed interface HostPhase {
    /** createVault or a finished restore: everything needed to unlock. */
    data class Ready(val vault: WrappedVault, val keyCheck: String) : HostPhase

    /**
     * startRestore ran and finishRestore has not succeeded yet. [sent] is the extension's KDF and wrapped key once
     * it paired in restore mode, null before; the master password has not been checked against it.
     */
    data class Restoring(val sent: WrappedVault?) : HostPhase

    /** A key check without a KDF or wrapped key: never written by this app; treated as no vault. */
    data object Inconsistent : HostPhase
}

/**
 * Persistent state of the phone host (host.json). The file format is the nullable fields below; code reads them
 * through [phase]. keyCheck == null means a restore from the extension is in progress ([HostPhase.Restoring]).
 * keyCheck is Base64 HMAC-SHA256(vaultKey, "passholder/v2/key-check"), set at createVault and finishRestore.
 */
@Serializable
data class HostState(
    val deviceId: String,
    val epoch: String,
    val wrappedStaticKey: String,
    val kdf: KdfParams? = null,
    val wrappedVaultKey: String? = null,
    val keyCheck: String? = null,
    val devices: List<StoredDevice> = emptyList(),
) {
    /** KDF and wrapped key when both are set (a vault, or a restore the extension already sent). */
    val wrappedVault: WrappedVault? get() = if (kdf != null && wrappedVaultKey != null) WrappedVault(kdf, wrappedVaultKey) else null

    val phase: HostPhase get() {
        val vault = wrappedVault
        return when {
            keyCheck == null -> HostPhase.Restoring(vault)
            vault != null -> HostPhase.Ready(vault, keyCheck)
            else -> HostPhase.Inconsistent
        }
    }

    fun withVault(vault: WrappedVault): HostState = copy(kdf = vault.kdf, wrappedVaultKey = vault.wrappedVaultKey)
}

fun StoredDevice.toPairedDevice(): PairedDevice = PairedDevice(deviceId, name, Encoding.fromBase64(staticPublicKey))

class HostStateStore(private val file: File, private val wrapper: SecretWrapper) {
    private val json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = false
    }

    /** The saved state, or null when there is no file. Throws IllegalStateException for content that is not a host state. */
    fun load(): HostState? {
        if (!file.exists()) return null
        return try {
            json.decodeFromString(HostState.serializer(), file.readText(Charsets.UTF_8))
        } catch (e: IllegalArgumentException) {
            // SerializationException is an IllegalArgumentException.
            throw IllegalStateException("Corrupt host state", e)
        }
    }

    /** Replaces the file atomically ([AtomicFiles.write]). */
    fun save(state: HostState) {
        AtomicFiles.write(file, json.encodeToString(HostState.serializer(), state).toByteArray(Charsets.UTF_8))
    }

    fun staticKey(state: HostState): KeyPair = NoiseKeys.fromPrivateKey(wrapper.unwrap(state.wrappedStaticKey))

    /** A fresh identity: new device id, random 16-byte epoch and a new static key. Not saved. */
    fun newState(kdf: KdfParams?, wrappedVaultKey: String?): HostState = HostState(
        deviceId = UUID.randomUUID().toString(),
        epoch = Encoding.toBase64(Encoding.randomBytes(16)),
        wrappedStaticKey = wrapper.wrap(NoiseKeys.generate().privateKey),
        kdf = kdf,
        wrappedVaultKey = wrappedVaultKey,
    )

    fun delete() {
        Files.deleteIfExists(File(file.path + ".tmp").toPath())
        Files.deleteIfExists(file.toPath())
    }
}
