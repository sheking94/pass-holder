package io.github.sheking94.passholder.core.p2p

import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Minimal HTTP/1.1 server: one POST request per connection, answered with `Connection: close`.
 * Parsing is deliberately strict; anything unusual gets a JSON error and the connection is closed.
 */
class SyncHttpServer(
    private val port: Int,
    private val handler: (path: String, body: ByteArray) -> HostReply,
    private val threads: Int = 4,
    private val readTimeoutMs: Int = 10_000,
) {
    companion object {
        const val MAX_HEADER_BYTES = 16 * 1024
    }

    private class HttpError(val status: Int, val error: String) : Exception(error)

    private val lock = Any()
    private var serverSocket: ServerSocket? = null
    private var pool: ExecutorService? = null

    val isRunning: Boolean get() = synchronized(lock) { serverSocket?.isClosed == false }

    /** Starts listening and returns the actual port (useful with port 0). */
    fun start(): Int = synchronized(lock) {
        check(serverSocket == null) { "already running" }
        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetSocketAddress(port))
        val executor = Executors.newFixedThreadPool(threads)
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
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                return
            }
            try {
                executor.execute { serve(client) }
            } catch (_: RejectedExecutionException) {
                closeQuietly(client)
            }
        }
    }

    private fun serve(client: Socket) {
        client.use {
            try {
                client.soTimeout = readTimeoutMs
                val input = BufferedInputStream(client.getInputStream())
                val reply = try {
                    val (path, body) = readRequest(input)
                    try {
                        handler(path, body)
                    } catch (e: Exception) {
                        error(500, "internal error")
                    }
                } catch (e: HttpError) {
                    error(e.status, e.error)
                }
                write(client, reply)
            } catch (_: IOException) {
                // Timeout, reset or early EOF: just drop the connection.
            }
        }
    }

    private fun error(status: Int, message: String) = HostReply(status, """{"error":"$message"}""")

    private fun readRequest(input: InputStream): Pair<String, ByteArray> {
        val lines = readHeaderLines(input)
        val parts = lines[0].split(' ')
        if (parts.size != 3 || !parts[2].startsWith("HTTP/1.")) throw HttpError(400, "bad request")
        val headers = HashMap<String, String>()
        for (line in lines.drop(1)) {
            val colon = line.indexOf(':')
            if (colon <= 0) throw HttpError(400, "bad request")
            val name = line.substring(0, colon).lowercase()
            val value = line.substring(colon + 1).trim()
            if (name == "content-length" && headers[name] != null && headers[name] != value) {
                throw HttpError(400, "bad request")
            }
            headers[name] = value
        }
        if (parts[0] != "POST") throw HttpError(405, "method not allowed")
        if (headers.containsKey("transfer-encoding")) throw HttpError(501, "not implemented")
        val raw = headers["content-length"] ?: throw HttpError(411, "length required")
        if (raw.isEmpty() || !raw.all { it in '0'..'9' } || raw.length > 10) throw HttpError(400, "bad request")
        val length = raw.toLong()
        if (length > P2pHost.MAX_BODY_BYTES) throw HttpError(413, "body too large")
        val body = ByteArray(length.toInt())
        var read = 0
        while (read < body.size) {
            val n = input.read(body, read, body.size - read)
            if (n < 0) throw IOException("unexpected EOF")
            read += n
        }
        return parts[1].substringBefore('?') to body
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
        431 -> "Request Header Fields Too Large"
        500 -> "Internal Server Error"
        501 -> "Not Implemented"
        503 -> "Service Unavailable"
        else -> "Status"
    }

    private fun closeQuietly(s: Socket) {
        try {
            s.close()
        } catch (_: IOException) {
        }
    }
}
