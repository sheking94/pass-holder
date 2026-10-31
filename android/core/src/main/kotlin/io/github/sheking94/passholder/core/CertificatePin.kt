package io.github.sheking94.passholder.core

import java.net.InetSocketAddress
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

/** The server's certificate did not match the fingerprint saved when this phone was paired. */
class PinMismatchException(val actual: String) :
    CertificateException("Certyfikat serwera nie zgadza się z zapamiętanym odciskiem")

/**
 * Certificate pinning (docs/SPEC.md §7). When pairing, the app shows the SHA-256 fingerprint of the
 * server's certificate and you compare it with the one printed on the Raspberry Pi. After that the app
 * trusts exactly that one certificate and nothing else, not even CAs installed on the phone.
 */
object CertificatePin {
    /** SHA-256 of the certificate (DER), formatted like `openssl x509 -fingerprint -sha256`: "AB:CD:…". */
    fun fingerprint(cert: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }

    /** Accepts "AB:CD:…", "abcd…" or the whole openssl line "sha256 Fingerprint=AB:CD:…". */
    fun normalize(input: String): String {
        val hex = input.substringAfter('=').filter { it.isLetterOrDigit() }.uppercase()
        require(hex.length == 64 && hex.all { it in "0123456789ABCDEF" }) { "Odcisk SHA-256 ma 64 znaki szesnastkowe" }
        return hex.chunked(2).joinToString(":")
    }

    /** Trusts only a server whose leaf certificate has this fingerprint. */
    class TrustManager(pin: String) : X509TrustManager {
        private val expected = normalize(pin)

        override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
            val leaf = chain.firstOrNull() ?: throw CertificateException("Serwer nie przesłał certyfikatu")
            val actual = fingerprint(leaf)
            if (actual != expected) throw PinMismatchException(actual)
        }

        override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) =
            throw CertificateException("Not a server")

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    /**
     * Reads the certificate the server presents, without trusting it and without sending any request.
     * Used once, when pairing, so the user can compare the fingerprint with the one on the Pi.
     */
    fun fetchServerCertificate(serverUrl: String, timeoutMs: Int = 5000): X509Certificate {
        val uri = URI(serverUrl)
        require(uri.scheme == "https") { "Adres musi zaczynać się od https://" }
        val host = uri.host ?: throw IllegalArgumentException("Brak nazwy serwera w adresie")
        val port = if (uri.port == -1) 443 else uri.port
        var seen: X509Certificate? = null
        val recorder = object : X509TrustManager {
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
                seen = chain.firstOrNull()
                // Fail the handshake on purpose: we only wanted to look at the certificate.
                throw CertificateException("Certificate recorded")
            }

            override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(recorder), null) }
        try {
            (context.socketFactory.createSocket() as SSLSocket).use { socket ->
                socket.soTimeout = timeoutMs
                socket.connect(InetSocketAddress(host, port), timeoutMs)
                socket.startHandshake()
            }
        } catch (e: Exception) {
            if (seen == null) throw ApiException(0, "Serwer jest niedostępny. Czy Raspberry Pi jest włączone?", e)
        }
        return seen ?: throw ApiException(0, "Serwer nie przesłał certyfikatu")
    }
}
