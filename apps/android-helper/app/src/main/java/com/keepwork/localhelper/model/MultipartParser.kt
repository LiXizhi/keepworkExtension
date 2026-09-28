package com.keepwork.localhelper.model

import com.keepwork.localhelper.net.HttpRequest
import org.json.JSONObject
import java.nio.charset.StandardCharsets

data class InferenceParts(val metadata: JSONObject, val audio: ByteArray)

object MultipartParser {
    fun parse(request: HttpRequest): InferenceParts {
        val contentType = request.headers["content-type"].orEmpty()
        require(contentType.lowercase().startsWith("multipart/form-data")) { "Expected multipart/form-data" }
        val boundary = contentType.split(';').map { it.trim() }
            .firstOrNull { it.startsWith("boundary=") }?.substringAfter('=')?.trim('"')
            ?.takeIf { it.length in 1..200 } ?: throw IllegalArgumentException("Multipart boundary is missing")
        val delimiter = "--$boundary".toByteArray(StandardCharsets.ISO_8859_1)
        val parts = split(request.body, delimiter)
        var metadata: JSONObject? = null
        var audio: ByteArray? = null
        for (part in parts) {
            if (part.size < 4) continue
            val headersEnd = indexOf(part, byteArrayOf(13, 10, 13, 10))
            if (headersEnd < 0) continue
            val headers = String(part, 0, headersEnd, StandardCharsets.ISO_8859_1)
            var bodyStart = headersEnd + 4
            var bodyEnd = part.size
            if (bodyEnd >= 2 && part[bodyEnd - 2] == 13.toByte() && part[bodyEnd - 1] == 10.toByte()) bodyEnd -= 2
            val body = part.copyOfRange(bodyStart, bodyEnd)
            when {
                Regex("name=\"metadata\"", RegexOption.IGNORE_CASE).containsMatchIn(headers) -> {
                    require(metadata == null) { "Duplicate metadata part" }
                    metadata = JSONObject(String(body, StandardCharsets.UTF_8))
                }
                Regex("name=\"audio\"", RegexOption.IGNORE_CASE).containsMatchIn(headers) -> {
                    require(audio == null) { "Duplicate audio part" }
                    audio = body
                }
            }
        }
        return InferenceParts(metadata ?: throw IllegalArgumentException("Metadata part is required"), audio ?: throw IllegalArgumentException("Audio part is required"))
    }

    private fun split(data: ByteArray, delimiter: ByteArray): List<ByteArray> {
        val result = mutableListOf<ByteArray>()
        var offset = 0
        while (true) {
            val start = indexOf(data, delimiter, offset)
            if (start < 0) break
            val bodyStart = start + delimiter.size
            val next = indexOf(data, delimiter, bodyStart)
            if (next < 0) break
            val normalizedStart = if (bodyStart + 2 <= next && data[bodyStart] == 13.toByte() && data[bodyStart + 1] == 10.toByte()) bodyStart + 2 else bodyStart
            result += data.copyOfRange(normalizedStart, next)
            offset = next
        }
        return result
    }

    private fun indexOf(haystack: ByteArray, needle: ByteArray, from: Int = 0): Int {
        if (needle.isEmpty()) return from
        outer@ for (index in from..haystack.size - needle.size) {
            for (offset in needle.indices) if (haystack[index + offset] != needle[offset]) continue@outer
            return index
        }
        return -1
    }
}
