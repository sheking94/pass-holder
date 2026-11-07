package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.KdfParams
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
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

/**
 * Persistent state of the phone host (host.json).
 * kdf == null means a restore from the extension is in progress.
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
)

fun StoredDevice.toPairedDevice(): PairedDevice = PairedDevice(deviceId, name, Encoding.fromBase64(staticPublicKey))

class HostStateStore(private val file: File, private val wrapper: SecretWrapper) {
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = false }

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

    /** Writes file.tmp, fsyncs it, then renames over the target. */
    fun save(state: HostState) {
        val tmp = File(file.path + ".tmp")
        FileOutputStream(tmp).use { out ->
            out.write(json.encodeToString(HostState.serializer(), state).toByteArray(Charsets.UTF_8))
            out.flush()
            out.fd.sync()
        }
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
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
