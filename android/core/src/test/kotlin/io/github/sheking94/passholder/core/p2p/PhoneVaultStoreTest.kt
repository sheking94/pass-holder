package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.ChangeRequest
import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.Kdf
import io.github.sheking94.passholder.core.KdfParams
import io.github.sheking94.passholder.core.VaultCrypto
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File

class PhoneVaultStoreTest {
    @TempDir
    lateinit var dir: File

    private var time = 1_700_000_000_000L
    private val servers = ArrayList<SyncHttpServer>()
    private val phoneAddresses = listOf("http://10.0.0.2:8787")

    /** The extension side: its identity and static key. */
    private val extKey = NoiseKeys.generate()
    private val extIdentity = DeviceIdentity("ext-1", "Chrome", Encoding.toBase64(extKey.publicKey))

    /** Cheapest KDF the phone accepts, so the restore tests stay fast. */
    private val weakestKdf = KdfParams(
        "argon2id", Encoding.toBase64(Encoding.randomBytes(16)), Kdf.MIN_MEMORY_KIB, Kdf.MIN_ITERATIONS, Kdf.MIN_PARALLELISM,
    )

    @AfterEach
    fun stopServers() = servers.forEach { it.stop() }

    private fun newStore(autoLockMs: Long = PhoneVaultStore.AUTO_LOCK_MS) =
        PhoneVaultStore(dir, PlainSecretWrapper, { time }, autoLockMs)

    /** Starts a real HTTP server on a free port with the store's router; returns a transport to it. */
    private fun serve(store: PhoneVaultStore, onRequest: () -> Unit = {}): HttpTestTransport {
        val server = SyncHttpServer(0, store.router(onRequest) { phoneAddresses }::handle)
        servers.add(server)
        return HttpTestTransport(server.start())
    }

    private fun clientFor(transport: TestTransport, pair: PairResult) =
        TestP2pClient(extIdentity.deviceId, extKey, Encoding.fromBase64(pair.phoneIdentity!!.staticPublicKey), transport)

    private fun blob(vaultKey: ByteArray, id: String, name: String) =
        EntryV3.encrypt(
            vaultKey, id,
            EntryDataV3(EntryContentV3(name, "", LoginFields("user-$id", "pass-$id"), emptyList()), Hlc(time, 0, extIdentity.deviceId)),
        )

    private fun nameOf(vaultKey: ByteArray, id: String, blob: String) = EntryV3.parse(EntryV3.decrypt(vaultKey, id, blob)).content.name

    @Test
    fun createVaultPairSyncAndReopen() {
        val store = newStore()
        assertFalse(store.hasVault)
        assertFalse(store.restoreInProgress)
        store.createVault("hasło główne")
        assertTrue(store.hasVault)
        assertFalse(store.restoreInProgress)
        assertTrue(store.isUnlocked)
        store.upsert("e1", Credentials("Bank", "jan", "tajne"))
        assertEquals("Bank", store.entry("e1")!!.credentials.name)
        assertNull(store.entry("missing"))

        var requests = 0
        val http = serve(store) { requests++ }
        val offer = store.offerPairing()
        assertEquals(PairingMode.PAIR, offer.mode)
        val pair = TestP2pClient.pair(http, offer.code, extIdentity)
        assertEquals(200, pair.finish!!.status, pair.finish!!.body)
        val info = pair.phoneVaultInfo!!
        assertEquals(phoneAddresses, info.addresses)
        assertEquals("Telefon", pair.phoneIdentity!!.name)
        // The extension unwraps the vault key with the master password.
        val vaultKey = Kdf.deriveKeys("hasło główne", info.kdf).let { VaultCrypto.unwrapVaultKey(it.encKey, info.wrappedVaultKey) }
        assertArrayEquals(store.exportUnlockKeys(), vaultKey)
        assertEquals(listOf("ext-1"), store.devices().map { it.deviceId })
        assertEquals("Chrome", store.devices()[0].name)
        assertEquals(time, store.devices()[0].pairedAt)
        assertNull(store.devices()[0].lastSyncAt)

        time += 5_000
        val client = clientFor(http, pair)
        val first = client.syncResponse(P2pSyncRequest(info.epoch, 0, emptyList()))
        assertEquals(listOf("e1"), first.changes.map { it.id })
        assertEquals("Bank", nameOf(vaultKey, "e1", first.changes[0].blob))
        assertEquals(phoneAddresses, first.addresses)
        assertEquals(time, store.devices()[0].lastSyncAt)

        // The extension's change shows up on the phone.
        val pushed = client.syncResponse(
            P2pSyncRequest(info.epoch, first.currentRevision, listOf(ChangeRequest("e2", 0, false, blob(vaultKey, "e2", "Poczta")))),
        )
        assertEquals(1, pushed.accepted.size)
        assertEquals(listOf("Bank", "Poczta"), store.entries().map { it.credentials.name })
        assertEquals(emptyList<String>(), store.unreadableIds())
        assertTrue(requests >= 5)

        // A new store on the same directory: locked, unlocks with the password, keeps entries and devices.
        servers.forEach { it.stop() }
        val reopened = newStore()
        assertTrue(reopened.hasVault)
        assertFalse(reopened.isUnlocked)
        assertThrows<IllegalStateException> { reopened.entries() }
        assertEquals("Złe hasło główne", assertThrows<IllegalArgumentException> { reopened.unlock("złe") }.message)
        reopened.unlock("hasło główne")
        assertEquals(listOf("Bank", "Poczta"), reopened.entries().map { it.credentials.name })
        assertEquals(time, reopened.devices().single().lastSyncAt)
        reopened.delete("e1")
        assertEquals(listOf("e2"), reopened.entries().map { it.id })

        // Sync mode again on the reopened store: the same extension still syncs.
        val again = clientFor(serve(reopened), pair).syncResponse(P2pSyncRequest(info.epoch, 0, emptyList()))
        assertEquals(setOf("e1", "e2"), again.changes.map { it.id }.toSet())
        assertTrue(again.changes.single { it.id == "e1" }.deleted)
    }

    @Test
    fun removedDeviceCannotHandshake() {
        val store = newStore()
        store.createVault("pw")
        val http = serve(store)
        val pair = TestP2pClient.pair(http, store.offerPairing().code, extIdentity)
        val client = clientFor(http, pair)
        assertEquals(200, client.handshakeReply().status)
        store.removeDevice("ext-1")
        assertEquals(emptyList<StoredDevice>(), store.devices())
        val refused = client.handshakeReply()
        assertEquals(403, refused.status)
        assertEquals("""{"error":"device not paired"}""", refused.body)
        // Still removed after a restart.
        assertEquals(emptyList<StoredDevice>(), newStore().devices())
    }

    @Test
    fun pairingAgainWithTheSameDeviceReplacesIt() {
        val store = newStore()
        store.createVault("pw")
        val http = serve(store)
        assertEquals(200, TestP2pClient.pair(http, store.offerPairing().code, extIdentity).finish!!.status)
        val newKey = NoiseKeys.generate()
        val renamed = DeviceIdentity("ext-1", "Chrome 2", Encoding.toBase64(newKey.publicKey))
        assertEquals(200, TestP2pClient.pair(http, store.offerPairing().code, renamed).finish!!.status)
        assertEquals(listOf("Chrome 2"), store.devices().map { it.name })
    }

    @Test
    fun restoreFromTheExtension() {
        // The extension's vault: its own KDF, vault key and three entries.
        val extKeys = Kdf.deriveKeys("hasło wtyczki", weakestKdf)
        val vaultKey = VaultCrypto.newVaultKey()
        val extInfo = VaultInfo(
            Encoding.toBase64(Encoding.randomBytes(16)), weakestKdf, VaultCrypto.wrapVaultKey(extKeys.encKey, vaultKey), listOf("x"),
        )

        val store = newStore()
        // Records of an earlier, abandoned restore are wiped.
        File(dir, "p2p").mkdirs()
        File(dir, "p2p/records.jsonl").writeText("""{"id":"old","revision":1,"deleted":false,"blob":"AA=="}""" + "\n")
        store.startRestore()
        assertTrue(store.restoreInProgress)
        assertFalse(store.hasVault)
        assertFalse(store.isUnlocked)
        assertEquals(
            "Wtyczka jeszcze nie przesłała sejfu",
            assertThrows<IllegalStateException> { store.finishRestore("hasło wtyczki") }.message,
        )

        val http = serve(store)
        val offer = store.offerPairing()
        assertEquals(PairingMode.RESTORE, offer.mode)
        val pair = TestP2pClient.pair(http, offer.code, extIdentity, extInfo)
        assertEquals(200, pair.finish!!.status, pair.finish!!.body)
        val phoneInfo = pair.phoneVaultInfo!!
        assertEquals(weakestKdf, phoneInfo.kdf)
        assertEquals(extInfo.wrappedVaultKey, phoneInfo.wrappedVaultKey)
        assertNotEquals(extInfo.epoch, phoneInfo.epoch)
        assertEquals(phoneAddresses, phoneInfo.addresses)
        // Paired, but nothing sent yet.
        assertTrue(store.restoreInProgress)
        assertFalse(store.hasVault)
        assertEquals(
            "Wtyczka jeszcze nie przesłała sejfu",
            assertThrows<IllegalStateException> { store.finishRestore("hasło wtyczki") }.message,
        )

        // The phone is locked (no vault key yet), but its host already takes the opaque blobs.
        val changes = listOf("a" to "Allegro", "b" to "Bank", "c" to "Ciocia").map { (id, name) ->
            ChangeRequest(id, 0, false, blob(vaultKey, id, name))
        }
        val res = clientFor(http, pair).syncResponse(P2pSyncRequest(phoneInfo.epoch, 0, changes))
        assertEquals(3, res.accepted.size)
        assertEquals(3, res.currentRevision)

        assertEquals("Złe hasło główne", assertThrows<IllegalArgumentException> { store.finishRestore("złe") }.message)
        assertTrue(store.restoreInProgress)
        assertFalse(store.hasVault)
        assertFalse(store.isUnlocked)

        store.finishRestore("hasło wtyczki")
        assertTrue(store.hasVault)
        assertFalse(store.restoreInProgress)
        assertTrue(store.isUnlocked)
        assertEquals(listOf("Allegro", "Bank", "Ciocia"), store.entries().map { it.credentials.name })
        assertEquals(PairingMode.PAIR, store.offerPairing().mode)

        // After a restart the restored vault opens with the extension's password and with the exported keys.
        val keys = store.exportUnlockKeys()
        val reopened = newStore()
        assertTrue(reopened.hasVault)
        reopened.unlockWithKeys(keys)
        assertEquals(3, reopened.entries().size)
        reopened.lock()
        reopened.unlock("hasło wtyczki")
        assertEquals(3, reopened.entries().size)
    }

    /** An extension vault (weakest KDF) ready to be sent in a restore. */
    private inner class ExtVault(password: String) {
        val vaultKey = VaultCrypto.newVaultKey()
        val info = VaultInfo(
            Encoding.toBase64(Encoding.randomBytes(16)), weakestKdf,
            VaultCrypto.wrapVaultKey(Kdf.deriveKeys(password, weakestKdf).encKey, vaultKey), emptyList(),
        )
    }

    @Test
    fun finishRestoreNeedsAPairedDevice() {
        val ext = ExtVault("hasło wtyczki")
        val store = newStore()
        store.startRestore()
        val http = serve(store)
        val pair = TestP2pClient.pair(http, store.offerPairing().code, extIdentity, ext.info)
        assertEquals(200, pair.finish!!.status)
        val res = clientFor(http, pair).syncResponse(
            P2pSyncRequest(pair.phoneVaultInfo!!.epoch, 0, listOf(ChangeRequest("a", 0, false, blob(ext.vaultKey, "a", "A")))),
        )
        assertEquals(1, res.accepted.size)
        // kdf, wrapped key and records are there, but the device that sent them is gone.
        store.removeDevice(extIdentity.deviceId)
        assertEquals(
            "Wtyczka jeszcze nie przesłała sejfu",
            assertThrows<IllegalStateException> { store.finishRestore("hasło wtyczki") }.message,
        )
        assertTrue(store.restoreInProgress)
        assertFalse(store.isUnlocked)
    }

    @Test
    fun anotherDeviceCannotTakeOverAStartedRestore() {
        val ext = ExtVault("hasło wtyczki")
        val store = newStore()
        store.startRestore()
        val http = serve(store)
        assertEquals(200, TestP2pClient.pair(http, store.offerPairing().code, extIdentity, ext.info).finish!!.status)

        // A second extension with another vault is refused and changes nothing.
        val other = ExtVault("inne hasło")
        val otherIdentity = DeviceIdentity("ext-2", "Firefox", Encoding.toBase64(NoiseKeys.generate().publicKey))
        val refused = TestP2pClient.pair(http, store.offerPairing().code, otherIdentity, other.info)
        assertEquals(500, refused.finish!!.status)
        assertEquals(listOf("ext-1"), store.devices().map { it.deviceId })

        // The same extension may pair again.
        val again = TestP2pClient.pair(http, store.offerPairing().code, extIdentity, ext.info)
        assertEquals(200, again.finish!!.status)
        assertEquals(ext.info.wrappedVaultKey, again.phoneVaultInfo!!.wrappedVaultKey)
        clientFor(http, again).syncResponse(
            P2pSyncRequest(again.phoneVaultInfo!!.epoch, 0, listOf(ChangeRequest("a", 0, false, blob(ext.vaultKey, "a", "A")))),
        )
        assertThrows<IllegalArgumentException> { store.finishRestore("inne hasło") }
        store.finishRestore("hasło wtyczki")
        assertEquals(listOf("A"), store.entries().map { it.credentials.name })
    }

    @Test
    fun pairingIdentityIsStable() {
        val store = newStore()
        store.createVault("pw")
        val http = serve(store)
        val first = TestP2pClient.pair(http, store.offerPairing().code, extIdentity).phoneIdentity!!
        val second = TestP2pClient.pair(http, store.offerPairing().code, extIdentity).phoneIdentity!!
        assertEquals(first, second)
        // A new identity after disconnect gets a new key.
        store.disconnect()
        store.createVault("pw")
        val http2 = serve(store)
        val third = TestP2pClient.pair(http2, store.offerPairing().code, extIdentity).phoneIdentity!!
        assertNotEquals(first.deviceId, third.deviceId)
        assertNotEquals(first.staticPublicKey, third.staticPublicKey)
    }

    @Test
    fun currentOfferIsGoneOnceSpentOrExpired() {
        val store = newStore()
        store.createVault("pw")
        assertNull(store.currentOffer())
        val offer = store.offerPairing()
        assertEquals(offer, store.currentOffer())
        // The first /pair/start spends it, even with the wrong code.
        val http = serve(store)
        TestP2pClient.pair(http, "00000000", extIdentity)
        assertNull(store.currentOffer())

        store.offerPairing()
        time += PAIRING_CODE_TTL_MS
        assertNull(store.currentOffer())

        store.offerPairing()
        store.cancelPairing()
        assertNull(store.currentOffer())
    }

    @Test
    fun unlockWithExportedKeysOnly() {
        val store = newStore()
        store.createVault("pw")
        val keys = store.exportUnlockKeys()
        assertEquals(32, keys.size)
        store.lock()
        assertFalse(store.isUnlocked)
        assertThrows<IllegalStateException> { store.exportUnlockKeys() }

        // Empty store: the key check still tells a wrong key apart.
        assertEquals(
            "Złe klucze odblokowania",
            assertThrows<IllegalArgumentException> { store.unlockWithKeys(Encoding.randomBytes(32)) }.message,
        )
        assertThrows<IllegalArgumentException> { store.unlockWithKeys(Encoding.randomBytes(64)) }
        assertFalse(store.isUnlocked)
        store.unlockWithKeys(keys)
        assertTrue(store.isUnlocked)

        store.upsert("e1", Credentials("Bank", "jan", "x"))
        store.lock()
        assertThrows<IllegalArgumentException> { store.unlockWithKeys(Encoding.randomBytes(32)) }
        assertFalse(store.isUnlocked)
        newStore().apply {
            unlockWithKeys(keys)
            assertEquals(listOf("e1"), entries().map { it.id })
        }
    }

    @Test
    fun autoLocksAfterIdleTime() {
        val store = newStore(autoLockMs = 60_000)
        store.createVault("pw")
        time += 59_999
        assertFalse(store.lockIfIdle())
        store.touch()
        time += 59_999
        assertFalse(store.lockIfIdle())
        time += 1
        assertTrue(store.lockIfIdle())
        assertFalse(store.isUnlocked)
        assertTrue(store.lockIfIdle())
    }

    @Test
    fun noHostBeforeTheVaultExists() {
        val store = newStore()
        val http = serve(store)
        assertEquals(HostReply(200, """{"ok":true}"""), http("/p2p/v1/ping", "{}".toByteArray()))
        assertEquals(503, http("/p2p/v2/handshake", "{}".toByteArray()).status)
        assertThrows<IllegalStateException> { store.offerPairing() }
        // The same router sees the vault created after it was built.
        store.createVault("pw")
        val pair = TestP2pClient.pair(http, store.offerPairing().code, extIdentity)
        assertEquals(200, pair.finish!!.status)
        assertEquals(200, clientFor(http, pair).handshakeReply().status)
    }

    @Test
    fun cancelledOfferIsGone() {
        val store = newStore()
        store.createVault("pw")
        val http = serve(store)
        store.offerPairing()
        store.cancelPairing()
        assertEquals(404, TestP2pClient.pair(http, "12345678", extIdentity).hello.status)
    }

    @Test
    fun refusesToOverwriteAVault() {
        val store = newStore()
        store.createVault("pw")
        assertThrows<IllegalStateException> { store.createVault("pw2") }
        assertThrows<IllegalStateException> { store.startRestore() }
        store.unlock("pw")
    }

    @Test
    fun disconnectDeletesEverything() {
        val store = newStore()
        store.createVault("pw")
        store.upsert("e1", Credentials("Bank", "jan", "x"))
        store.disconnect()
        assertFalse(store.isUnlocked)
        assertFalse(store.hasVault)
        assertFalse(File(dir, "p2p").exists())
        assertFalse(newStore().hasVault)
        // A fresh vault after disconnect starts empty.
        store.createVault("pw")
        assertEquals(emptyList<PhoneEntry>(), store.entries())
    }

    @Test
    fun corruptHostStateDoesNotThrowAndDisconnectClearsIt() {
        File(dir, "p2p").mkdirs()
        File(dir, "p2p/host.json").writeText("{ not a host state")
        File(dir, "p2p/records.jsonl").writeText("garbage\n")
        val store = newStore()
        assertTrue(store.corruptState)
        assertFalse(store.hasVault)
        assertFalse(store.restoreInProgress)
        assertFalse(store.isUnlocked)
        assertEquals(emptyList<StoredDevice>(), store.devices())
        // Nothing may silently overwrite what could still be recovered by hand: delete first.
        assertThrows<IllegalStateException> { store.createVault("pw") }
        assertThrows<IllegalStateException> { store.startRestore() }
        assertThrows<IllegalStateException> { store.offerPairing() }
        // Sync mode in this state: the router answers, the vault paths are not ready.
        val http = serve(store)
        assertEquals(200, http("/p2p/v1/ping", "{}".toByteArray()).status)
        assertEquals(503, http("/p2p/v2/handshake", "{}".toByteArray()).status)
        assertTrue(store.corruptState)

        store.disconnect()
        assertFalse(store.corruptState)
        assertFalse(File(dir, "p2p").exists())
        assertFalse(newStore().corruptState)
        store.createVault("pw")
        assertTrue(store.hasVault)
        assertEquals(emptyList<PhoneEntry>(), store.entries())
    }

    @Test
    fun aNewRouterDropsAStaleOffer() {
        val store = newStore()
        store.createVault("pw")
        serve(store)
        store.offerPairing()
        assertTrue(store.currentOffer() != null)
        // Sync mode stopped and started again (e.g. without the app's stop reaching cancelPairing).
        val http = serve(store)
        assertNull(store.currentOffer())
        assertEquals(404, http("/p2p/v1/pair/hello", "{}".toByteArray()).status)
    }

    @Test
    fun internalErrorsReachOnError() {
        val errors = ArrayList<Throwable>()
        var keystoreGone = false
        val wrapper = object : SecretWrapper {
            override fun wrap(secret: ByteArray) = PlainSecretWrapper.wrap(secret)
            override fun unwrap(wrapped: String): ByteArray {
                check(!keystoreGone) { "no Keystore key" }
                return PlainSecretWrapper.unwrap(wrapped)
            }
        }
        val store = PhoneVaultStore(dir, wrapper, { time }, onError = { errors.add(it) })
        store.createVault("pw")
        val http = serve(store)
        keystoreGone = true
        // The host's static key cannot be unwrapped: the extension sees only 500, the app's log the cause.
        assertEquals(HostReply(500, """{"error":"internal error"}"""), http("/p2p/v2/handshake", "{}".toByteArray()))
        assertEquals(listOf("no Keystore key"), errors.map { it.message })
    }
}
