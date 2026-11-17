package io.github.sheking94.passholder.core.p2p

import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Minimal HTTP/1.1 server: one POST request per connection, answered with `Connection: close`.
 * Parsing is deliberately strict; anything unusual gets a JSON error and the connection is closed.
 *
 * Any LAN host can connect before it authenticates, so a client gets at most [requestDeadlineMs] in total to send
 * its request (headers and body), [threads] connections are served at once and [queueCapacity] more may wait;
 * beyond that a connection gets 503 at once. The Host header must be an IPv4 literal or localhost
 * (a DNS-rebinding page in the user's browser would send its own host name). A request with an `Origin` header
 * other than `chrome-extension://…` gets 403 and one without `Content-Type: application/json` gets 415, so a web page
 * cannot send a "simple" no-cors POST (`text/plain`) that the server would act on.
 * A connection to a local address [allowLocal] refuses (e.g. the cellular interface) is closed without an answer.
 */
class SyncHttpServer(
    private val port: Int,
    private val handler: (path: String, body: ByteArray) -> HostReply,
    private val threads: Int = 4,
    private val readTimeoutMs: Int = 10_000,
    private val requestDeadlineMs: Long = 15_000,
    private val queueCapacity: Int = 16,
    private val socketFactory: () -> ServerSocket = { ServerSocket() },
    /** Whether to serve a connection that came in on this local address; checked on a worker thread. */
    private val allowLocal: (InetAddress) -> Boolean = { true },
) {
    companion object {
        const val MAX_HEADER_BYTES = 16 * 1024

        /** Consecutive accept() failures before the server gives up (and closes its socket). */
        const val MAX_ACCEPT_FAILURES = 20
        const val ACCEPT_BACKOFF_MS = 50L

        private val ALLOWED_HOST =
            Regex("""^(?:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})|localhost)(?::\d{1,5})?$""", RegexOption.IGNORE_CASE)

        /** An IPv4 literal (each part 0..255) or localhost, with an optional port. */
        internal fun isAllowedHost(host: String): Boolean {
            val m = ALLOWED_HOST.matchEntire(host) ?: return false
            return m.groupValues.drop(1).filter { it.isNotEmpty() }.all { it.toInt() <= 255 }
        }
    }

    private class HttpError(val status: Int, val error: String) : Exception(error)

    private val lock = Any()
    private var serverSocket: ServerSocket? = null
    private var pool: ExecutorService? = null

    val isRunning: Boolean get() = synchronized(lock) { serverSocket?.isClosed == false }

    /** Starts listening and returns the actual port (useful with port 0). */
    fun start(): Int = synchronized(lock) {
        check(serverSocket == null) { "already running" }
        val socket = socketFactory()
        try {
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(port))
        } catch (e: Throwable) {
            // Otherwise every failed "Włącz ponownie" on a busy port leaks a file descriptor.
            try {
                socket.close()
            } catch (_: IOException) {
            }
            throw e
        }
        val executor = ThreadPoolExecutor(threads, threads, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue(queueCapacity))
        serverSocket = socket
        pool = executor
        val acceptor = Thread({ acceptLoop(socket, executor) }, "sync-http-accept")
        acceptor.isDaemon = true
        acceptor.start()
        socket.localPort
    }

    fun stop() {
        val (socket, executor) = synchronized(lock) {
            val pair = serverSocket to pool
            serverSocket = null
            pool = null
            pair
        }
        try {
            socket?.close()
        } catch (_: IOException) {
        }
        executor?.shutdownNow()
    }

    private fun acceptLoop(socket: ServerSocket, executor: ExecutorService) {
        var failures = 0
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                if (socket.isClosed) return
                // E.g. out of file descriptors for a moment: wait and try again, but not forever.
                if (++failures >= MAX_ACCEPT_FAILURES) {
                    closeQuietly(socket)
                    return
                }
                try {
                    Thread.sleep(ACCEPT_BACKOFF_MS)
                } catch (_: InterruptedException) {
                    closeQuietly(socket)
                    return
                }
                continue
            }
            failures = 0
            try {
                executor.execute { serve(client) }
            } catch (_: RejectedExecutionException) {
                busy(client)
            }
        }
    }

    /**
     * All workers busy and the queue full: 503 without waiting for the request. Runs on the acceptor thread, so
     * it never blocks on the client; what already arrived is discarded first, or closing with unread data would
     * reset the connection and the client might never see the reply.
     */
    private fun busy(client: Socket) {
        try {
            write(client, HostReply.error(503, "busy"))
            client.shutdownOutput()
            val input = client.getInputStream()
            val scratch = ByteArray(4096)
            var left = MAX_HEADER_BYTES
            while (left > 0) {
                val n = minOf(input.available(), scratch.size, left)
                if (n <= 0) break
                left -= input.read(scratch, 0, n)
            }
        } catch (_: IOException) {
        } finally {
            closeQuietly(client)
        }
    }

    /**
     * The socket's input, where every read waits at most until [deadlineNanos] (and at most [readTimeoutMs]):
     * a client trickling one byte at a time cannot hold a worker longer than [requestDeadlineMs].
     */
    private inner class DeadlineInput(private val client: Socket, private val deadlineNanos: Long) : InputStream() {
        private val raw = client.getInputStream()

        private fun arm() {
            val leftMs = (deadlineNanos - System.nanoTime()) / 1_000_000
            if (leftMs <= 0) throw SocketTimeoutException("request deadline")
            client.soTimeout = minOf(readTimeoutMs.toLong(), leftMs).toInt()
        }

        override fun read(): Int {
            arm()
            return raw.read()
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            arm()
            return raw.read(b, off, len)
        }
    }

    private fun serve(client: Socket) {
        client.use {
            if (!localAllowed(client)) return
            try {
                val deadline = System.nanoTime() + requestDeadlineMs * 1_000_000
                val input = BufferedInputStream(DeadlineInput(client, deadline))
                val reply = try {
                    val (path, body) = readRequest(input)
                    try {
                        handler(path, body)
                    } catch (e: Exception) {
                        HostReply.error(500, "internal error")
                    }
                } catch (e: HttpError) {
                    HostReply.error(e.status, e.error)
                }
                write(client, reply)
            } catch (_: IOException) {
                // Timeout, reset or early EOF: just drop the connection.
            }
        }
    }

    private fun localAllowed(client: Socket): Boolean = try {
        allowLocal(client.localAddress)
    } catch (_: Exception) {
        false
    }

    private fun readRequest(input: InputStream): Pair<String, ByteArray> {
        val lines = readHeaderLines(input)
        val parts = lines[0].split(' ')
        if (parts.size != 3 || !parts[2].startsWith("HTTP/1.")) throw HttpError(400, "bad request")
        val headers = parseHeaders(lines.drop(1))
        val host = headers["host"] ?: throw HttpError(400, "bad request")
        if (!isAllowedHost(host)) throw HttpError(403, "forbidden host")
        if (parts[0] != "POST") throw HttpError(405, "method not allowed")
        val length = contentLength(headers)
        val origin = headers["origin"]
        if (origin != null && !origin.startsWith("chrome-extension://")) throw HttpError(403, "forbidden origin")
        val type = headers["content-type"]?.substringBefore(';')?.trim()?.lowercase()
        if (type != "application/json") throw HttpError(415, "unsupported media type")
        return parts[1].substringBefore('?') to readBody(input, length)
    }

    /** Header names in lower case; a repeated Content-Length or Host with another value is a 400. */
    private fun parseHeaders(lines: List<String>): Map<String, String> {
        val headers = HashMap<String, String>()
        for (line in lines) {
            val colon = line.indexOf(':')
            if (colon <= 0) throw HttpError(400, "bad request")
            val name = line.substring(0, colon).lowercase()
            val value = line.substring(colon + 1).trim()
            val previous = headers[name]
            if ((name == "content-length" || name == "host") && previous != null && previous != value) {
                throw HttpError(400, "bad request")
            }
            headers[name] = value
        }
        return headers
    }

    /** The declared body length: required, decimal, at most [P2pHost.MAX_BODY_BYTES]; chunked bodies are not supported. */
    private fun contentLength(headers: Map<String, String>): Int {
        if (headers.containsKey("transfer-encoding")) throw HttpError(501, "not implemented")
        val raw = headers["content-length"] ?: throw HttpError(411, "length required")
        if (raw.isEmpty() || !raw.all { it in '0'..'9' } || raw.length > 10) throw HttpError(400, "bad request")
        val length = raw.toLong()
        if (length > P2pHost.MAX_BODY_BYTES) throw HttpError(413, "body too large")
        return length.toInt()
    }

    private fun readBody(input: InputStream, length: Int): ByteArray {
        val body = ByteArray(length)
        var read = 0
        while (read < body.size) {
            val n = input.read(body, read, body.size - read)
            if (n < 0) throw IOException("unexpected EOF")
            read += n
        }
        return body
    }

    /** Reads request line and headers up to the blank line, at most MAX_HEADER_BYTES in total. */
    private fun readHeaderLines(input: InputStream): List<String> {
        val lines = ArrayList<String>()
        val line = StringBuilder()
        var total = 0
        while (true) {
            val b = input.read()
            if (b < 0) throw IOException("unexpected EOF")
            if (++total > MAX_HEADER_BYTES) throw HttpError(431, "headers too large")
            if (b == '\n'.code) {
                if (line.endsWith("\r")) line.setLength(line.length - 1)
                if (line.isEmpty()) {
                    if (lines.isEmpty()) throw HttpError(400, "bad request")
                    return lines
                }
                lines.add(line.toString())
                line.setLength(0)
            } else {
                line.append(b.toChar())
            }
        }
    }

    private fun write(client: Socket, reply: HostReply) {
        val body = reply.body.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 ${reply.status} ${reason(reply.status)}\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Connection: close\r\n\r\n"
        val out = client.getOutputStream()
        out.write(head.toByteArray(Charsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }

    private fun reason(status: Int) = when (status) {
        200 -> "OK"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        411 -> "Length Required"
        413 -> "Payload Too Large"
        415 -> "Unsupported Media Type"
        431 -> "Request Header Fields Too Large"
        500 -> "Internal Server Error"
        501 -> "Not Implemented"
        503 -> "Service Unavailable"
        else -> "Status"
    }

    private fun closeQuietly(s: java.io.Closeable) {
        try {
            s.close()
        } catch (_: IOException) {
        }
    }
}
