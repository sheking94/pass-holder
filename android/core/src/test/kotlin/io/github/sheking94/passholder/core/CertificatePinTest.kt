package io.github.sheking94.passholder.core

import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class CertificatePinTest {
    private val ca = HeldCertificate.Builder().certificateAuthority(0).commonName("PassHolder local CA").build()
    private val serverCert = HeldCertificate.Builder().signedBy(ca).commonName("passholder.local")
        .addSubjectAlternativeName("passholder.local").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(serverCert, ca.certificate).build().sslSocketFactory(), false)
        dispatcher = FakeServer()
        start()
    }
    // The certificate is for passholder.local, the test connects to 127.0.0.1: the pin alone must be enough.
    private val url = "https://127.0.0.1:${server.port}"

    @AfterEach
    fun stop() = server.shutdown()

    @Test
    fun `reads the server certificate for the user to compare`() {
        val cert = CertificatePin.fetchServerCertificate(url)
        assertEquals(CertificatePin.fingerprint(serverCert.certificate), CertificatePin.fingerprint(cert))
        assertEquals(95, CertificatePin.fingerprint(cert).length) // 32 bytes as "AB:" groups
    }

    @Test
    fun `talks to the server whose certificate matches the pin`() {
        val pin = CertificatePin.fingerprint(serverCert.certificate)
        assertEquals(ServerStatus(false, "1"), ServerClient(url, pin).status())
    }

    @Test
    fun `refuses another certificate, even one signed by the same CA`() {
        val other = HeldCertificate.Builder().signedBy(ca).commonName("passholder.local").build()
        val error = assertThrows<ApiException> { ServerClient(url, CertificatePin.fingerprint(other.certificate)).status() }
        assertEquals(0, error.status)
        assertTrue(error.message!!.startsWith("Certyfikat serwera nie zgadza się"), error.message)
    }

    @Test
    fun `refuses https without a pin`() {
        assertThrows<IllegalArgumentException> { ServerClient(url, null) }
    }

    @Test
    fun `normalizes the fingerprint formats people paste`() {
        val pin = CertificatePin.fingerprint(serverCert.certificate)
        assertEquals(pin, CertificatePin.normalize("sha256 Fingerprint=$pin"))
        assertEquals(pin, CertificatePin.normalize(pin.replace(":", "").lowercase()))
        assertThrows<IllegalArgumentException> { CertificatePin.normalize("AB:CD") }
    }
}
