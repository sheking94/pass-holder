package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.p2p.HttpTestTransport
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.nio.file.Files

/** SyncController on the plain JVM: start and stop in any order leave no server behind. */
class SyncControllerTest {
    private val dir = Files.createTempDirectory("sync").toFile()
    private val store = PhoneVaultStore(dir, TestSecretWrapper).apply { startRestore() }
    private var bound = -1
    private val controller = SyncController(store, 0, addresses = { bound = it; listOf("http://127.0.0.1:$it") })

    @After
    fun cleanUp() {
        controller.stop(null)
        dir.deleteRecursively()
    }

    private fun listening(port: Int) = try {
        HttpTestTransport(port)("/p2p/v1/ping", "{}".toByteArray()).status == 200
    } catch (_: IOException) {
        false
    }

    @Test
    fun `a stop after the ticket cancels the start, a running server is not started twice`() {
        val ticket = controller.startTicket()
        controller.stop(null)
        assertFalse(controller.start(ticket))
        assertFalse(controller.running)
        assertEquals(-1, bound)

        assertTrue(controller.start())
        assertTrue(listening(bound))
        val port = bound
        assertFalse("already running: no new server", controller.start())
        assertEquals(port, bound)

        controller.stop(SyncController.IDLE_STOPPED)
        assertFalse(listening(port))
        assertEquals(SyncController.IDLE_STOPPED, controller.state.value.stoppedReason)
    }

    @Test
    fun `a connection on a local address that is not allowed gets no answer`() {
        val closed = SyncController(store, 0, addresses = { bound = it; emptyList() }, allowsLocal = { false })
        try {
            assertTrue(closed.start())
            assertFalse(listening(bound))
        } finally {
            closed.stop(null)
        }
    }
}
