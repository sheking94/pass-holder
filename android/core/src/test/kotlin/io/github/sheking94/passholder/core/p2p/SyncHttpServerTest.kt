package io.github.sheking94.passholder.core.p2p

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
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
        return send(port, "POST $path HTTP/1.1\r\nHost: 127.0.0.1:$port\r\ncontent-type: application/json\r\ncontent-length: $len\r\n\r\n$body")
    }

    private inline fun withServer(
        threads: Int = 4,
        timeout: Int = 10_000,
        deadline: Long = 15_000,
        queue: Int = 16,
        noinline handler: (String, ByteArray) -> HostReply = { _, _ -> HostReply(200, "{}") },
        block: (SyncHttpServer, Int) -> Unit,
    ) {
        val server = SyncHttpServer(0, handler, threads, timeout, requestDeadlineMs = deadline, queueCapacity = queue)
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
        val r = send(port, "GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        assertEquals(405, r.status)
        assertEquals("""{"error":"method not allowed"}""", r.body)
    }

    @Test
    fun `oversized content length is 413 without reading the body`() = withServer { _, port ->
        val t0 = System.nanoTime()
        val r = send(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1048577\r\n\r\n")
        assertEquals(413, r.status)
        assertEquals("""{"error":"body too large"}""", r.body)
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 1000)
    }

    @Test
    fun `missing content length is 411`() = withServer { _, port ->
        val r = send(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        assertEquals(411, r.status)
        assertEquals("""{"error":"length required"}""", r.body)
    }

    @Test
    fun `malformed content length is 400`() = withServer { _, port ->
        for (v in listOf("abc", "-1", "")) {
            val r = send(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: $v\r\n\r\n")
            assertEquals(400, r.status, v)
            assertEquals("""{"error":"bad request"}""", r.body)
        }
    }

    @Test
    fun `transfer encoding is 501`() = withServer { _, port ->
        val r = send(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n")
        assertEquals(501, r.status)
        assertEquals("""{"error":"not implemented"}""", r.body)
    }

    @Test
    fun `headers over 16 KiB are 431`() = withServer { _, port ->
        val big = "a".repeat(17 * 1024)
        val r = send(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: $big\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n")
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

    // ---- Host header (DNS rebinding) ----

    @Test
    fun `host that is not an IP literal or localhost is 403`() = withServer { _, port ->
        for (host in listOf("evil.example", "x", "127.0.0.1.evil.example", "300.1.1.1", "[::1]", "")) {
            val r = send(port, "POST /x HTTP/1.1\r\nHost: $host\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
            assertEquals(403, r.status, host)
            assertEquals("""{"error":"forbidden host"}""", r.body)
        }
    }

    @Test
    fun `ip literal and localhost hosts are accepted`() = withServer { _, port ->
        for (host in listOf("127.0.0.1", "192.168.1.20:8787", "localhost", "LOCALHOST:8787", "10.0.0.2")) {
            val r = send(port, "POST /x HTTP/1.1\r\nHost: $host\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
            assertEquals(200, r.status, host)
        }
    }

    // ---- Web pages (Origin, Content-Type) ----

    @Test
    fun `origin other than an extension is 403`() = withServer { _, port ->
        for (origin in listOf("https://evil.example", "null", "http://192.168.1.5:8787")) {
            val r = send(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: $origin\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
            assertEquals(403, r.status, origin)
            assertEquals("""{"error":"forbidden origin"}""", r.body)
        }
    }

    @Test
    fun `extension origin or none is accepted`() = withServer { _, port ->
        val ext = send(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: chrome-extension://abcdef\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
        assertEquals(200, ext.status)
        assertEquals(200, post(port, "/x", "{}").status)
    }

    @Test
    fun `content type other than json is 415`() = withServer { _, port ->
        for (type in listOf(null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx")) {
            val header = if (type == null) "" else "Content-Type: $type\r\n"
            val r = send(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\n${header}Content-Length: 2\r\n\r\n{}")
            assertEquals(415, r.status, type)
            assertEquals("""{"error":"unsupported media type"}""", r.body)
        }
    }

    @Test
    fun `json content type with parameters is accepted`() = withServer { _, port ->
        for (type in listOf("application/json", "Application/JSON; charset=utf-8")) {
            val r = send(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: $type\r\nContent-Length: 2\r\n\r\n{}")
            assertEquals(200, r.status, type)
        }
    }

    @Test
    fun `connection on a refused local address is closed without an answer`() {
        val handled = AtomicInteger()
        val server = SyncHttpServer(0, { _, _ -> handled.incrementAndGet(); HostReply(200, "{}") }, allowLocal = { !it.isLoopbackAddress })
        val port = server.start()
        try {
            Socket("127.0.0.1", port).use { s ->
                s.soTimeout = 5000
                s.getOutputStream().write("POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".toByteArray())
                s.getOutputStream().flush()
                val first = try {
                    s.getInputStream().read()
                } catch (_: IOException) {
                    -1
                }
                assertEquals(-1, first)
            }
            assertEquals(0, handled.get())
        } finally {
            server.stop()
        }
    }

    @Test
    fun `missing host is 400`() = withServer { _, port ->
        val r = send(port, "POST /x HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}")
        assertEquals(400, r.status)
        assertEquals("""{"error":"bad request"}""", r.body)
    }

    // ---- Stalling clients ----

    /** Sends [request] one byte every [gapMs]; returns ms until the server closed the connection. */
    private fun trickle(port: Int, request: String, gapMs: Long, maxMs: Long = 5_000): Long {
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = maxMs.toInt()
            val t0 = System.nanoTime()
            val writer = Thread {
                try {
                    for (b in request.toByteArray()) {
                        s.getOutputStream().write(b.toInt())
                        s.getOutputStream().flush()
                        Thread.sleep(gapMs)
                    }
                } catch (_: Exception) {
                    // The server closed the connection.
                }
            }
            writer.isDaemon = true
            writer.start()
            try {
                while (s.getInputStream().read() >= 0) {
                    // Drain any reply until EOF.
                }
            } catch (_: SocketTimeoutException) {
                throw AssertionError("server did not cut the trickling client off")
            } catch (_: IOException) {
                // Reset: also cut off.
            }
            return (System.nanoTime() - t0) / 1_000_000
        }
    }

    @Test
    fun `slow trickle client is cut off at the total deadline`() = withServer(timeout = 2_000, deadline = 500) { _, port ->
        // Every single read is far under the 2 s read timeout; only the total deadline stops it.
        val headers = "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Pad: ${"a".repeat(200)}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"
        val ms = trickle(port, headers, gapMs = 20)
        assertTrue(ms in 400..1_800, "cut off after $ms ms")
    }

    @Test
    fun `body trickle is also covered by the deadline`() = withServer(timeout = 2_000, deadline = 500) { _, port ->
        val ms = trickle(port, "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n" + "x".repeat(1000), gapMs = 5)
        assertTrue(ms < 1_800, "cut off after $ms ms")
    }

    private fun stalled(port: Int) = Socket("127.0.0.1", port).apply {
        getOutputStream().write("POST /x HTTP/1.1\r\nHo".toByteArray())
        getOutputStream().flush()
    }

    @Test
    fun `four stalled clients do not starve a normal request beyond the deadline`() =
        withServer(threads = 4, timeout = 10_000, deadline = 600) { _, port ->
            val stalledClients = List(4) { stalled(port) }
            try {
                Thread.sleep(100) // all four now hold a worker
                val t0 = System.nanoTime()
                assertEquals(200, post(port, "/x", "{}").status)
                val ms = (System.nanoTime() - t0) / 1_000_000
                assertTrue(ms < 2_000, "served after $ms ms")
            } finally {
                stalledClients.forEach { it.close() }
            }
        }

    @Test
    fun `a full queue answers 503 busy at once`() = withServer(threads = 1, queue = 1, deadline = 10_000) { _, port ->
        val stalledClients = listOf(stalled(port), stalled(port))
        try {
            Thread.sleep(200) // one in the worker, one in the queue
            val t0 = System.nanoTime()
            val r = post(port, "/x", "{}")
            assertEquals(503, r.status)
            assertEquals("""{"error":"busy"}""", r.body)
            assertTrue((System.nanoTime() - t0) / 1_000_000 < 1_000)
        } finally {
            stalledClients.forEach { it.close() }
        }
    }

    // ---- Acceptor and bind failures ----

    @Test
    fun `acceptor survives a transient accept failure`() {
        val failures = AtomicInteger(2)
        val server = SyncHttpServer(0, { _, _ -> HostReply(200, "{}") }, socketFactory = {
            object : ServerSocket() {
                override fun accept(): Socket {
                    if (failures.getAndDecrement() > 0) throw IOException("transient")
                    return super.accept()
                }
            }
        })
        val port = server.start()
        try {
            assertEquals(200, post(port, "/x", "{}").status)
            assertTrue(server.isRunning)
        } finally {
            server.stop()
        }
    }

    @Test
    fun `an acceptor that keeps failing closes the socket so isRunning is false`() {
        val server = SyncHttpServer(0, { _, _ -> HostReply(200, "{}") }, socketFactory = {
            object : ServerSocket() {
                override fun accept(): Socket = throw IOException("dead")
            }
        })
        server.start()
        try {
            val t0 = System.nanoTime()
            while (server.isRunning && (System.nanoTime() - t0) / 1_000_000 < 10_000) Thread.sleep(50)
            assertFalse(server.isRunning)
        } finally {
            server.stop()
        }
    }

    @Test
    fun `failed bind closes the socket and allows another start`() {
        val closed = AtomicBoolean(false)
        val busy = ServerSocket(0)
        try {
            val server = SyncHttpServer(busy.localPort, { _, _ -> HostReply(200, "{}") }, socketFactory = {
                object : ServerSocket() {
                    override fun close() {
                        closed.set(true)
                        super.close()
                    }
                }
            })
            assertThrows<IOException> { server.start() }
            assertTrue(closed.get(), "unbound socket was not closed")
            assertFalse(server.isRunning)
            busy.close()
            val port = server.start()
            try {
                assertEquals(busy.localPort, port)
            } finally {
                server.stop()
            }
        } finally {
            busy.close()
        }
    }
}
