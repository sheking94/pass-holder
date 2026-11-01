package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.atomic.AtomicLong

/** Small persistent key-value storage. [FileStore] on the phone, [MemoryStore] in tests. */
interface KeyValueStore {
    fun get(key: String): String?
    fun set(key: String, value: String)
    fun remove(key: String)
}

class MemoryStore : KeyValueStore {
    val data = mutableMapOf<String, String>()
    override fun get(key: String) = data[key]
    override fun set(key: String, value: String) { data[key] = value }
    override fun remove(key: String) { data.remove(key) }
}

/** One file per key. Writes go to a temporary file first and are then renamed, so a crash never leaves half a file. */
class FileStore(private val dir: File) : KeyValueStore {
    init { dir.mkdirs() }

    private fun file(key: String): File {
        require(key.matches(Regex("[a-z-]+"))) { "Bad key" }
        return File(dir, "$key.json")
    }

    override fun get(key: String): String? = file(key).takeIf { it.exists() }?.readText()

    override fun set(key: String, value: String) {
        val tmp = File(dir, "$key.json.tmp")
        tmp.writeText(value)
        Files.move(tmp.toPath(), file(key).toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    override fun remove(key: String) { file(key).delete() }
}

/** Kept on disk. Nothing here is readable without the master password. */
@Serializable
data class Account(
    val serverUrl: String,
    /** SHA-256 fingerprint of the server certificate confirmed when pairing; null for a local http:// server. */
    val certificatePin: String?,
    val kdf: KdfParams,
    val wrappedVaultKey: String,
)

/**
 * Everything the app does with the vault, the Android counterpart of extension/src/vault-store.ts.
 *
 * On disk: the account (server address, KDF parameters, wrapped vault key) and the vault itself,
 * encrypted with the vault key. So the app works offline and talks to the server only when you sync.
 * In memory, only while unlocked: the vault key, the auth key and the decrypted entries.
 *
 * Methods are blocking (Argon2id, disk, network): call them off the main thread. They are synchronized,
 * so two operations never interleave.
 */
class VaultStore(
    private val disk: KeyValueStore,
    private val makeClient: (url: String, pin: String?) -> ServerClient = { url, pin -> ServerClient(url, pin) },
    private val now: () -> Long = System::currentTimeMillis,
    private val autoLockMs: Long = AUTO_LOCK_MS,
) {
    private class Session(val vaultKey: ByteArray, val authKey: ByteArray, val vault: LocalVault) {
        var token: String? = null
        var tokenExpiresAt = 0L

        fun remember(login: SessionResponse) {
            token = login.token
            tokenExpiresAt = login.expiresAt
        }
    }

    private val json = Json { ignoreUnknownKeys = true }
    @Volatile
    private var session: Session? = null

    /** Outside the lock on purpose: the UI calls [touch] on every tap and must never wait for a running sync. */
    private val lastActivity = AtomicLong(0)

    /** Not synchronized: the file is replaced atomically, and the UI may read it while a sync runs. */
    fun account(): Account? = disk.get(ACCOUNT)?.let { json.decodeFromString<Account>(it) }

    val isUnlocked: Boolean get() = session != null

    /** Snapshot of live entries, sorted by name. */
    @Synchronized
    fun entries(): List<LiveEntry> =
        requireSession().vault.liveEntries().sortedBy { it.credentials.name.lowercase() }

    @Synchronized
    fun entry(id: String): LiveEntry? = requireSession().vault.liveEntry(id)

    @Synchronized
    fun pendingCount(): Int = requireSession().vault.pendingCount()

    /** Creates a new vault on an empty server. */
    @Synchronized
    fun createVault(serverUrl: String, certificatePin: String?, setupToken: String, masterPassword: String) {
        val client = makeClient(serverUrl, certificatePin)
        val kdf = Kdf.newParams()
        val keys = Kdf.deriveKeys(masterPassword, kdf)
        val vaultKey = VaultCrypto.newVaultKey()
        val wrapped = VaultCrypto.wrapVaultKey(keys.encKey, vaultKey)
        keys.encKey.fill(0)
        try {
            client.setup(SetupRequest(setupToken, kdf, Encoding.toBase64(keys.authKey), wrapped))
        } catch (e: ApiException) {
            throw when (e.status) {
                403 -> ApiException(403, "Zły token z logu serwera")
                409 -> ApiException(409, "Na serwerze już jest sejf. Wybierz „Mam już sejf”.")
                else -> e
            }
        }
        disk.set(ACCOUNT, json.encodeToString(Account(serverUrl, certificatePin, kdf, wrapped)))
        start(vaultKey, keys.authKey, LocalVault())
    }

    /** Connects this phone to a vault that already exists on the server, then downloads it. */
    @Synchronized
    fun connectExisting(serverUrl: String, certificatePin: String?, masterPassword: String) {
        val client = makeClient(serverUrl, certificatePin)
        val kdf = client.prelogin().kdf
        Kdf.assertAcceptable(kdf)
        val keys = Kdf.deriveKeys(masterPassword, kdf)
        val login = requestSession(client, keys.authKey)
        val vaultKey = VaultCrypto.unwrapVaultKey(keys.encKey, login.wrappedVaultKey)
        keys.encKey.fill(0)
        disk.set(ACCOUNT, json.encodeToString(Account(serverUrl, certificatePin, kdf, login.wrappedVaultKey)))
        start(vaultKey, keys.authKey, LocalVault())
        requireSession().remember(login)
        sync()
    }

    /** Works offline: the wrapped vault key and the encrypted vault are on disk. */
    @Synchronized
    fun unlock(masterPassword: String) {
        val account = account() ?: throw IllegalStateException("Brak konta")
        val keys = Kdf.deriveKeys(masterPassword, account.kdf)
        val vaultKey = try {
            VaultCrypto.unwrapVaultKey(keys.encKey, account.wrappedVaultKey)
        } catch (e: Exception) {
            throw IllegalArgumentException("Złe hasło główne", e)
        } finally {
            keys.encKey.fill(0)
        }
        start(vaultKey, keys.authKey, loadVault(vaultKey))
    }

    /**
     * The two keys an unlocked vault holds in memory (vault key + auth key, 64 bytes), for the fingerprint
     * unlock: the app encrypts them with a key in the Android Keystore that only a fingerprint releases.
     * Returns a copy; the caller should zero it once encrypted.
     */
    @Synchronized
    fun exportUnlockKeys(): ByteArray {
        val s = requireSession()
        return s.vaultKey + s.authKey
    }

    /**
     * Unlocks with keys from [exportUnlockKeys] instead of the master password (no Argon2id, so it is instant).
     * Decrypting the local vault checks the keys: AES-GCM fails on a wrong vault key.
     */
    @Synchronized
    fun unlockWithKeys(keys: ByteArray) {
        require(keys.size == 2 * KEY_LENGTH) { "Złe klucze odblokowania" }
        account() ?: throw IllegalStateException("Brak konta")
        // Without the local vault there is nothing to check the keys against; use the master password then.
        if (disk.get(VAULT) == null) throw IllegalStateException("Brak sejfu na telefonie")
        val vaultKey = keys.copyOfRange(0, KEY_LENGTH)
        val authKey = keys.copyOfRange(KEY_LENGTH, 2 * KEY_LENGTH)
        val vault = try {
            loadVault(vaultKey)
        } catch (e: Exception) {
            vaultKey.fill(0)
            authKey.fill(0)
            throw IllegalArgumentException("Złe klucze odblokowania", e)
        }
        start(vaultKey, authKey, vault)
    }

    /** Forgets the keys and the decrypted entries. */
    @Synchronized
    fun lock() {
        session?.let {
            it.vaultKey.fill(0)
            it.authKey.fill(0)
        }
        session = null
    }

    /** Marks user activity; auto-lock counts from the last one. Cheap and never blocks. */
    fun touch() {
        lastActivity.set(now())
    }

    /** Locks if there was no activity for [autoLockMs]. Returns true if the vault is (now) locked. */
    @Synchronized
    fun lockIfIdle(): Boolean {
        if (session == null) return true
        if (now() - lastActivity.get() >= autoLockMs) lock()
        return session == null
    }

    /** Forgets this phone's account and local copy. The server keeps everything. */
    @Synchronized
    fun disconnect() {
        lock()
        disk.remove(ACCOUNT)
        disk.remove(VAULT)
    }

    @Synchronized
    fun upsert(id: String, credentials: Credentials) {
        requireSession().vault.upsert(id, credentials, now())
        save()
    }

    @Synchronized
    fun delete(id: String) {
        requireSession().vault.delete(id, now())
        save()
    }

    @Synchronized
    fun sync() {
        val s = requireSession()
        val account = account() ?: throw IllegalStateException("Brak konta")
        val client = makeClient(account.serverUrl, account.certificatePin)
        withFreshToken(client, s) { token -> VaultSync.sync(s.vault, s.vaultKey) { request -> client.sync(token, request) } }
        save()
    }

    /**
     * Runs [action] with a valid session token. The server keeps sessions in memory only, so switching the
     * Pi off and on forgets our token although it has not expired yet: on 401 log in again once and retry.
     */
    private fun withFreshToken(client: ServerClient, s: Session, action: (token: String) -> Unit) {
        val current = s.token
        val expiringSoon = s.tokenExpiresAt <= now() + TOKEN_REFRESH_MARGIN_MS
        val token = if (current != null && !expiringSoon) current else refreshToken(client, s)
        try {
            action(token)
        } catch (e: ApiException) {
            if (e.status != 401) throw e
            action(refreshToken(client, s))
        }
    }

    /** Gets a new session token, keeps it in [s] and returns it. */
    private fun refreshToken(client: ServerClient, s: Session): String {
        val login = requestSession(client, s.authKey)
        s.remember(login)
        return login.token
    }

    /** POST /session, with the server's errors turned into messages for the user. */
    private fun requestSession(client: ServerClient, authKey: ByteArray): SessionResponse = try {
        client.session(Encoding.toBase64(authKey))
    } catch (e: ApiException) {
        throw when (e.status) {
            401 -> ApiException(401, "Złe hasło główne")
            429 -> ApiException(429, "Za dużo prób logowania, odczekaj minutę")
            404 -> ApiException(404, "Na serwerze nie ma jeszcze sejfu")
            else -> e
        }
    }

    private fun requireSession(): Session = session ?: throw IllegalStateException("Sejf jest zablokowany")

    private fun start(vaultKey: ByteArray, authKey: ByteArray, vault: LocalVault) {
        lock()
        session = Session(vaultKey, authKey, vault)
        save()
    }

    private fun save() {
        val s = requireSession()
        disk.set(VAULT, Aead.seal(s.vaultKey, Encoding.utf8(json.encodeToString(s.vault)), LOCAL_VAULT_AAD))
        touch()
    }

    private fun loadVault(vaultKey: ByteArray): LocalVault {
        val blob = disk.get(VAULT) ?: return LocalVault()
        return json.decodeFromString(Encoding.fromUtf8(Aead.open(vaultKey, blob, LOCAL_VAULT_AAD)))
    }

    companion object {
        const val AUTO_LOCK_MS = 15 * 60_000L
        private const val KEY_LENGTH = 32

        /** A token this close to expiry is renewed before a sync, so it does not run out halfway. */
        private const val TOKEN_REFRESH_MARGIN_MS = 10_000L
        private const val ACCOUNT = "account"
        private const val VAULT = "vault"
        private const val LOCAL_VAULT_AAD = "passholder/v1/local-vault"
    }
}
