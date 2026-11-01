package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext

/** [status] is the HTTP status, or 0 when the server could not be reached. */
class ApiException(val status: Int, message: String, cause: Throwable? = null) : Exception(message, cause)

@Serializable
data class ServerStatus(val initialized: Boolean, val version: String)

@Serializable
data class SetupRequest(val setupToken: String, val kdf: KdfParams, val authKey: String, val wrappedVaultKey: String)

@Serializable
data class PreloginResponse(val kdf: KdfParams)

@Serializable
data class SessionResponse(val token: String, val expiresAt: Long, val wrappedVaultKey: String)

@Serializable
private data class SessionRequest(val authKey: String)

/**
 * HTTP client for the Raspberry Pi server (API in docs/SPEC.md §6).
 * With [certificatePin] the connection trusts only that certificate; without it only plain http:// is
 * allowed (local development server).
 */
class ServerClient(baseUrl: String, certificatePin: String?, base: OkHttpClient = OkHttpClient()) {
    private val baseUrl = baseUrl.trimEnd('/')
    private val http: OkHttpClient
    private val json = Json { ignoreUnknownKeys = true }

    init {
        val builder = base.newBuilder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
        if (this.baseUrl.startsWith("https://")) {
            requireNotNull(certificatePin) { "HTTPS needs a pinned certificate" }
            val trust = CertificatePin.TrustManager(certificatePin)
            val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
            builder.sslSocketFactory(ssl.socketFactory, trust)
            // The pin already proves this is our server: it holds the private key of exactly the certificate
            // we saved. Checking the host name on top would only break access through another address
            // (for example the VPN IP) that was not listed when the certificate was made.
            builder.hostnameVerifier { _, _ -> true }
        } else {
            require(this.baseUrl.startsWith("http://")) { "Adres musi zaczynać się od https://" }
        }
        http = builder.build()
    }

    /** With [timeoutMs], gives up (as "unreachable", status 0) when the whole call takes longer. */
    fun status(timeoutMs: Long? = null): ServerStatus {
        val client = if (timeoutMs == null) http else http.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build()
        return request("GET", "/api/v1/status", null, client = client)
    }

    fun setup(body: SetupRequest) {
        request<JsonObject>("POST", "/api/v1/setup", json.encodeToString(body))
    }

    fun prelogin(): PreloginResponse = request("GET", "/api/v1/prelogin", null)

    fun session(authKey: String): SessionResponse =
        request("POST", "/api/v1/session", json.encodeToString(SessionRequest(authKey)))

    fun sync(token: String, body: SyncRequest): SyncResponse =
        request("POST", "/api/v1/sync", json.encodeToString(body), token)

    private inline fun <reified T> request(
        method: String,
        path: String,
        body: String?,
        token: String? = null,
        client: OkHttpClient = http,
    ): T {
        val builder = Request.Builder().url(baseUrl + path)
        if (token != null) builder.header("Authorization", "Bearer $token")
        builder.method(method, body?.toRequestBody("application/json".toMediaType()))
        val text: String
        val code: Int
        try {
            client.newCall(builder.build()).execute().use { response ->
                code = response.code
                text = response.body?.string().orEmpty()
            }
        } catch (e: IOException) {
            val pin = generateSequence(e as Throwable) { it.cause }.filterIsInstance<PinMismatchException>().firstOrNull()
            if (pin != null) throw ApiException(0, "${pin.message}. Jeśli wymieniłeś certyfikat, połącz telefon ponownie.", e)
            throw ApiException(0, "Serwer jest niedostępny. Czy Raspberry Pi jest włączone?", e)
        }
        if (code !in 200..299) {
            val error = runCatching { json.parseToJsonElement(text) as JsonObject }.getOrNull()?.get("error")?.jsonPrimitive?.content
            throw ApiException(code, error ?: "HTTP $code")
        }
        return json.decodeFromString(text)
    }
}
