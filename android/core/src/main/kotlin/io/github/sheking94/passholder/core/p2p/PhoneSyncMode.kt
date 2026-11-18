package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException

/**
 * The phone as the sync host: paired devices, pairing codes and the HTTP router of sync mode. Works while locked:
 * the host only moves opaque blobs. The [PairingHost] calls back into [identity], [vaultInfo] and [onPaired] while
 * holding its own lock, which then take the state lock of [storage] (lock order: pairing host → state lock).
 */
internal class PhoneSyncMode(
    private val storage: HostStorage,
    /** The name the extension shows for this phone. */
    private val deviceName: String,
    private val now: () -> Long,
    private val onError: (Throwable) -> Unit,
) {
    private val pairing = PairingHost(::identity, ::vaultInfo, ::onPaired, now, onError)

    @Volatile
    private var addresses: () -> List<String> = { emptyList() }

    /** (deviceId, Base64 static public key) of the current identity, so pairing does not unwrap the private key each time. Guarded by the state lock. */
    private var publicKeyCache: Pair<String, String>? = null

    /** See [PhoneVaultStore.router]. */
    fun router(onActivity: () -> Unit, addresses: () -> List<String>): PhoneRouter {
        pairing.cancel()
        storage.locked {
            this.addresses = addresses
            storage.reload()
        }
        return PhoneRouter(pairing, ::currentHost, onActivity, onError)
    }

    /** A new pairing code; in restore mode while a restore is in progress. */
    fun offerPairing(): PairingOffer {
        val hostState = storage.state ?: throw PassHolderException(ErrorCode.NO_VAULT)
        return pairing.offer(if (hostState.phase is HostPhase.Restoring) PairingMode.RESTORE else PairingMode.PAIR)
    }

    fun cancelPairing() = pairing.cancel()

    fun currentOffer(): PairingOffer? = pairing.current()

    fun devices(): List<StoredDevice> = storage.state?.devices.orEmpty()

    /** The device can no longer handshake (its next request gets 403). */
    fun removeDevice(deviceId: String) = storage.update { state ->
        if (state.devices.none { it.deviceId == deviceId }) null else state.copy(devices = state.devices.filter { it.deviceId != deviceId })
    }

    private fun currentHost(): P2pHost? = storage.host { state ->
        P2pHost(
            staticKey = storage.staticKey(state),
            devices = ::pairedDevices,
            store = storage.records(),
            epoch = state.epoch,
            addresses = { addresses() },
            now = now,
            onSynced = ::onSynced,
            onError = onError,
            files = storage.files(),
        )
    }

    private fun pairedDevices(): List<PairedDevice> = devices().map { it.toPairedDevice() }

    private fun onSynced(deviceId: String) = storage.update { state ->
        if (state.devices.none { it.deviceId == deviceId }) return@update null
        val at = now()
        state.copy(devices = state.devices.map { if (it.deviceId == deviceId) it.copy(lastSyncAt = at) else it })
    }

    private fun identity(): DeviceIdentity = storage.locked {
        val state = storage.requireState()
        val cached = publicKeyCache?.takeIf { it.first == state.deviceId }?.second
        val publicKey = cached ?: run {
            val pair = storage.staticKey(state)
            pair.privateKey.fill(0)
            Encoding.toBase64(pair.publicKey).also { publicKeyCache = state.deviceId to it }
        }
        DeviceIdentity(state.deviceId, deviceName, publicKey)
    }

    private fun vaultInfo(@Suppress("UNUSED_PARAMETER") restored: VaultInfo?): VaultInfo {
        val list = addresses().take(Pairing.MAX_ADDRESSES)
        val state = storage.requireState()
        val vault = state.wrappedVault ?: throw IllegalStateException("No vault")
        return VaultInfo(state.epoch, vault.kdf, vault.wrappedVaultKey, list)
    }

    /** The same deviceId replaces the earlier entry; in restore mode also keeps the extension's KDF and wrapped key. */
    private fun onPaired(device: StoredDevice, restored: VaultInfo?) = storage.locked {
        val state = storage.requireState()
        val phase = state.phase
        // The offer's mode was fixed when it was made; refuse if the phone's state changed since.
        check((phase is HostPhase.Restoring) == (restored != null)) { "Pairing mode no longer matches the vault" }
        // Once an extension sent its vault for the restore, only that extension may pair again (and resend it).
        if (phase is HostPhase.Restoring && phase.sent != null) {
            check(state.devices.any { it.deviceId == device.deviceId }) { "Restore already started by another device" }
        }
        val devices = state.devices.filter { it.deviceId != device.deviceId } + device
        val paired = state.copy(devices = devices)
        storage.save(if (restored == null) paired else paired.withVault(WrappedVault(restored.kdf, restored.wrappedVaultKey)))
    }
}
