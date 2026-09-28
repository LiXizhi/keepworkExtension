package com.keepwork.localhelper.net

import com.keepwork.localhelper.AppLog
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

data class HttpRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: ByteArray,
)

data class HttpResponse(
    val status: Int,
    val body: ByteArray = ByteArray(0),
    val headers: Map<String, String> = emptyMap(),
) {
    companion object {
        fun json(status: Int, json: String, headers: Map<String, String> = emptyMap()) = HttpResponse(
            status,
            json.toByteArray(StandardCharsets.UTF_8),
            mapOf("Content-Type" to "application/json; charset=utf-8") + headers,
        )
    }
}

class LoopbackHttpServer(
    private val port: Int,
    private val name: String,
    private val maxBodyBytes: Int,
    private val handler: (HttpRequest) -> HttpResponse,
) : AutoCloseable {
    private val running = AtomicBoolean(false)
    private val clients = Executors.newCachedThreadPool()
    private var socket: ServerSocket? = null
    private var acceptThread: Thread? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        val server = ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"))
        server.reuseAddress = true
        socket = server
        acceptThread = Thread({ acceptLoop(server) }, "$name-accept").apply {
            isDaemon = true
            start()
        }
        AppLog.info("$name.started", "http://127.0.0.1:$port")
    }

    private fun acceptLoop(server: ServerSocket) {
        while (running.get()) {
            try {
                val client = server.accept()
                clients.execute { client.use(::serve) }
            } catch (error: Throwable) {
                if (running.get()) AppLog.error("$name.accept.failed", error)
            }
        }
    }

    private fun serve(client: Socket) {
        client.soTimeout = 30_000
        val input = BufferedInputStream(client.getInputStream())
        val output = BufferedOutputStream(client.getOutputStream())
        val response = try {
            handler(readRequest(input))
        } catch (error: Throwable) {
            AppLog.warn("$name.request.failed", error.message.orEmpty())
            HttpResponse.json(400, "{\"error\":${jsonString(error.message ?: "Bad request")}}")
        }
        writeResponse(output, response)
    }

    private fun readRequest(input: BufferedInputStream): HttpRequest {
        val requestLine = readLine(input, 8192).split(' ')
        require(requestLine.size >= 2) { "Invalid request line" }
        val headers = linkedMapOf<String, String>()
        var headerBytes = 0
        while (true) {
            val line = readLine(input, 8192)
            headerBytes += line.length
            require(headerBytes <= 65_536) { "Headers are too large" }
            if (line.isEmpty()) break
            val separator = line.indexOf(':')
            require(separator > 0) { "Invalid header" }
            headers[line.substring(0, separator).trim().lowercase(Locale.US)] = line.substring(separator + 1).trim()
        }
        val body = when {
            headers["transfer-encoding"]?.equals("chunked", ignoreCase = true) == true -> readChunked(input)
            headers["content-length"] != null -> {
                val length = headers.getValue("content-length").toInt()
                require(length in 0..maxBodyBytes) { "Request body is too large" }
                input.readExact(length)
            }
            else -> ByteArray(0)
        }
        return HttpRequest(requestLine[0].uppercase(Locale.US), requestLine[1], headers, body)
    }

    private fun readChunked(input: BufferedInputStream): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        while (true) {
            val size = readLine(input, 128).substringBefore(';').trim().toInt(16)
            if (size == 0) {
                while (readLine(input, 8192).isNotEmpty()) Unit
                break
            }
            require(output.size() + size <= maxBodyBytes) { "Request body is too large" }
            output.write(input.readExact(size))
            require(readLine(input, 2).isEmpty()) { "Invalid chunk terminator" }
        }
        return output.toByteArray()
    }

    private fun readLine(input: BufferedInputStream, limit: Int): String {
        val bytes = java.io.ByteArrayOutputStream()
        var previous = -1
        while (bytes.size() <= limit) {
            val current = input.read()
            require(current >= 0) { "Unexpected end of request" }
            if (previous == 13 && current == 10) {
                val data = bytes.toByteArray()
                return String(data, 0, data.size - 1, StandardCharsets.ISO_8859_1)
            }
            bytes.write(current)
            previous = current
        }
        throw IllegalArgumentException("HTTP line is too long")
    }

    private fun BufferedInputStream.readExact(length: Int): ByteArray {
        val data = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val count = read(data, offset, length - offset)
            require(count > 0) { "Unexpected end of request body" }
            offset += count
        }
        return data
    }

    private fun writeResponse(output: BufferedOutputStream, response: HttpResponse) {
        val reason = mapOf(200 to "OK", 202 to "Accepted", 204 to "No Content", 400 to "Bad Request", 401 to "Unauthorized", 403 to "Forbidden", 404 to "Not Found", 405 to "Method Not Allowed", 409 to "Conflict", 413 to "Payload Too Large", 415 to "Unsupported Media Type", 429 to "Too Many Requests", 500 to "Internal Server Error", 503 to "Service Unavailable")[response.status] ?: "Response"
        val headers = linkedMapOf(
            "Content-Length" to response.body.size.toString(),
            "Cache-Control" to "no-store",
            "X-Content-Type-Options" to "nosniff",
            "Connection" to "close",
        ) + response.headers
        output.write("HTTP/1.1 ${response.status} $reason\r\n".toByteArray(StandardCharsets.US_ASCII))
        for ((name, value) in headers) output.write("$name: $value\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write("\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write(response.body)
        output.flush()
    }

    override fun close() {
        if (!running.compareAndSet(true, false)) return
        socket?.close()
        clients.shutdownNow()
        AppLog.info("$name.stopped")
    }

    private fun jsonString(value: String) = org.json.JSONObject.quote(value)
}
