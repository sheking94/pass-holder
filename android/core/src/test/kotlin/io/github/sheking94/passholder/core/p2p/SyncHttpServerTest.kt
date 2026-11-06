package io.github.sheking94.passholder.core.p2p

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.Socket
import java.util.concurrent.Callable
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

class SyncHttpServerTest {
    private class Raw(val status: Int, val headers: String, val body: String)

    private fun send(port: Int, request: String, readTimeout: Int = 5000): Raw {
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = readTimeout
            s.getOutputStream().write(request.toByteArray(Charsets.ISO_8859_1))
            s.getOutputStream().flush()
            val text = String(s.getInputStream().readBytes(), Charsets.UTF_8)
            val split = text.indexOf("\r\n\r\n")
            val head = text.substring(0, split)
            return Raw(head.substring(9, 12).toInt(), head, text.substring(split + 4))
        }
    }

    private fun post(port: Int, path: String, body: String): Raw {
        val len = body.toByteArray().size
        return send(port, "POST $path HTTP/1.1\r\nHost: x\r\ncontent-length: $len\r\n\r\n$body")
    }

    private inline fun withServer(
        threads: Int = 4,
        timeout: Int = 10_000,
        noinline handler: (String, ByteArray) -> HostReply = { _, _ -> HostReply(200, "{}") },
        block: (SyncHttpServer, Int) -> Unit,
    ) {
        val server = SyncHttpServer(0, handler, threads, timeout)
        val port = server.start()
        try {
            block(server, port)
        } finally {
            server.stop()
        }
    }

    @Test
    fun `post reaches handler with path and body and reply is returned`() {
        val seen = CopyOnWriteArrayList<Pair<String, String>>()
        withServer(handler = { p, b ->
            seen.add(p to String(b))
            HostReply(201, """{"ok":true}""")
        }) { _, port ->
            val r = post(port, "/x?y=1", """{"a":1}""")
            assertEquals(201, r.status)
            assertEquals("""{"ok":true}""", r.body)
            assertTrue(r.headers.contains("Connection: close"))
            assertTrue(r.headers.contains("Content-Type: application/json; charset=utf-8"))
            assertTrue(r.headers.contains("Content-Length: 11"))
            assertEquals(listOf("/x" to """{"a":1}"""), seen.toList())
        }
    }

    @Test
    fun `non post is 405`() = withServer { _, port ->
        val r = send(port, "GET /x HTTP/1.1\r\nHost: x\r\n\r\n")
        assertEquals(405, r.status)
        assertEquals("""{"error":"method not allowed"}""", r.body)
    }

    @Test
    fun `oversized content length is 413 without reading the body`() = withServer { _, port ->
        val t0 = System.nanoTime()
        val r = send(port, "POST /x HTTP/1.1\r\nContent-Length: 1048577\r\n\r\n")
        assertEquals(413, r.status)
        assertEquals("""{"error":"body too large"}""", r.body)
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 1000)
    }

    @Test
    fun `missing content length is 411`() = withServer { _, port ->
        val r = send(port, "POST /x HTTP/1.1\r\nHost: x\r\n\r\n")
        assertEquals(411, r.status)
        assertEquals("""{"error":"length required"}""", r.body)
    }

    @Test
    fun `malformed content length is 400`() = withServer { _, port ->
        for (v in listOf("abc", "-1", "")) {
            val r = send(port, "POST /x HTTP/1.1\r\nContent-Length: $v\r\n\r\n")
            assertEquals(400, r.status, v)
            assertEquals("""{"error":"bad request"}""", r.body)
        }
    }

    @Test
    fun `transfer encoding is 501`() = withServer { _, port ->
        val r = send(port, "POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n")
        assertEquals(501, r.status)
        assertEquals("""{"error":"not implemented"}""", r.body)
    }

    @Test
    fun `headers over 16 KiB are 431`() = withServer { _, port ->
        val big = "a".repeat(17 * 1024)
        val r = send(port, "POST /x HTTP/1.1\r\nX-Big: $big\r\nContent-Length: 0\r\n\r\n")
        assertEquals(431, r.status)
        assertEquals("""{"error":"headers too large"}""", r.body)
    }

    @Test
    fun `garbage request line is 400`() = withServer { _, port ->
        assertEquals(400, send(port, "NONSENSE\r\n\r\n").status)
    }

    @Test
    fun `handler exception is 500`() = withServer(handler = { _, _ -> error("boom") }) { _, port ->
        val r = post(port, "/x", "{}")
        assertEquals(500, r.status)
        assertEquals("""{"error":"internal error"}""", r.body)
    }

    @Test
    fun `stalled header is closed after read timeout`() = withServer(timeout = 200) { _, port ->
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = 3000
            s.getOutputStream().write("POST /x HTTP/1.1\r\nHos".toByteArray())
            s.getOutputStream().flush()
            val t0 = System.nanoTime()
            val n = try {
                s.getInputStream().read()
            } catch (e: java.net.SocketTimeoutException) {
                throw AssertionError("server did not close the connection")
            }
            // Either EOF or an error reply, then close; never a hang.
            assertTrue(n == -1 || n == 'H'.code)
            assertTrue((System.nanoTime() - t0) / 1_000_000 < 2000)
        }
    }

    @Test
    fun `eight parallel requests all succeed`() = withServer { _, port ->
        val pool = Executors.newFixedThreadPool(8)
        try {
            val results = pool.invokeAll(List(8) { Callable { post(port, "/x", "{}").status } })
            assertEquals(List(8) { 200 }, results.map { it.get() })
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun `stop then start works again`() {
        val server = SyncHttpServer(0, { _, _ -> HostReply(200, "{}") })
        assertEquals(false, server.isRunning)
        val p1 = server.start()
        assertTrue(server.isRunning)
        assertEquals(200, post(p1, "/x", "{}").status)
        server.stop()
        assertEquals(false, server.isRunning)
        val p2 = server.start()
        try {
            assertEquals(200, post(p2, "/x", "{}").status)
        } finally {
            server.stop()
        }
    }
}
