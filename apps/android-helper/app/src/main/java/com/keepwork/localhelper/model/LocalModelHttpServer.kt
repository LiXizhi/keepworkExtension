package com.keepwork.localhelper.model

import com.keepwork.localhelper.AppConstants
import com.keepwork.localhelper.BuildConfig
import com.keepwork.localhelper.net.HttpRequest
import com.keepwork.localhelper.net.HttpResponse
import com.keepwork.localhelper.net.LoopbackHttpServer
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import kotlin.system.measureTimeMillis

class LocalModelHttpServer(private val engine: SpeakerEngine) : AutoCloseable {
    private val server = LoopbackHttpServer(AppConstants.MODEL_PORT, "local-model", 32 * 1024 * 1024, ::handle)

    fun start() = server.start()
    override fun close() = server.close()

    private fun handle(request: HttpRequest): HttpResponse {
        val cors = cors(request) ?: return failure(403, "ORIGIN_FORBIDDEN", "Origin is not allowed")
        val requestId = request.headers["x-request-id"]?.takeIf { it.matches(Regex("[A-Za-z0-9._:-]{1,100}")) } ?: UUID.randomUUID().toString()
        val headers = cors + ("X-Request-Id" to requestId)
        if (request.method == "OPTIONS") return HttpResponse(204, headers = headers)
        return try {
            val path = request.path.substringBefore('?')
            when {
                request.method == "GET" && path == "/v1/health" -> HttpResponse.json(200, health(requestId).toString(), headers)
                request.method == "GET" && path == "/v1/models" -> HttpResponse.json(200, JSONObject().put("requestId", requestId).put("models", JSONArray().put(modelInfo())).toString(), headers)
                request.method == "GET" && path == "/v1/models/${AppConstants.MODEL_ID}" -> HttpResponse.json(200, JSONObject().put("requestId", requestId).put("model", modelInfo()).toString(), headers)
                request.method == "POST" && path == "/v1/models/${AppConstants.MODEL_ID}/load" -> {
                    engine.loadModel()
                    HttpResponse.json(200, JSONObject().put("requestId", requestId).put("model", modelInfo()).toString(), headers)
                }
                request.method == "POST" && path == "/v1/models/${AppConstants.MODEL_ID}/unload" -> {
                    engine.unloadModel()
                    HttpResponse.json(200, JSONObject().put("requestId", requestId).put("model", modelInfo()).toString(), headers)
                }
                request.method == "POST" && (path == "/v1/speaker/embedding" || path == "/v1/speaker/compare") -> inference(request, requestId, path.endsWith("compare"), headers)
                else -> failure(404, "NOT_FOUND", "Endpoint not found", headers)
            }
        } catch (error: Throwable) {
            failure(400, "MODEL_REQUEST_INVALID", error.message ?: "Model request failed", headers)
        }
    }

    private fun inference(request: HttpRequest, requestId: String, compare: Boolean, headers: Map<String, String>): HttpResponse {
        val parts = MultipartParser.parse(request)
        val modelId = parts.metadata.optString("modelId", AppConstants.MODEL_ID)
        require(modelId == AppConstants.MODEL_ID) { "Unknown model: $modelId" }
        val decoded = AudioDecoder.decode(parts.audio, parts.metadata)
        var embedding: FloatArray? = null
        var score: Float? = null
        val elapsed = measureTimeMillis {
            if (compare) {
                val values = parts.metadata.getJSONArray("template")
                val template = FloatArray(values.length()) { values.getDouble(it).toFloat() }
                score = engine.compare(decoded.samples, decoded.sampleRate, template)
            } else {
                embedding = engine.embedding(decoded.samples, decoded.sampleRate)
            }
        }
        val result = JSONObject().apply {
            put("requestId", requestId)
            put("modelId", AppConstants.MODEL_ID)
            put("modelVersion", AppConstants.MODEL_VERSION)
            put("formatVersion", 1)
            put("durationMs", decoded.samples.size * 1000.0 / decoded.sampleRate)
            put("processingMs", elapsed)
            if (embedding != null) {
                put("dimension", AppConstants.MODEL_DIMENSION)
                put("normalized", true)
                put("embedding", JSONArray(embedding!!.toList()))
            } else put("score", score)
        }
        return HttpResponse.json(200, result.toString(), headers)
    }

    private fun health(requestId: String) = JSONObject().apply {
        put("requestId", requestId)
        put("service", "keepwork-local-model")
        put("version", BuildConfig.VERSION_NAME)
        put("protocolVersion", AppConstants.MODEL_PROTOCOL_VERSION)
        put("status", "ok")
        put("models", JSONArray().put(JSONObject().apply {
            put("id", AppConstants.MODEL_ID)
            put("state", engine.state())
            put("installed", true)
            put("trusted", true)
        }))
    }

    private fun modelInfo() = JSONObject().apply {
        put("id", AppConstants.MODEL_ID)
        put("version", AppConstants.MODEL_VERSION)
        put("capability", "speaker-embedding")
        put("state", engine.state())
        put("installed", true)
        put("trusted", true)
        put("operations", JSONArray(listOf("embedding", "compare")))
        put("input", JSONObject().put("encodings", JSONArray(listOf("pcm_f32le", "pcm_s16le", "wav"))).put("sampleRate", 16000).put("channels", 1).put("minDurationMs", 300).put("maxDurationMs", 15000))
        put("output", JSONObject().put("type", "float32").put("dimension", AppConstants.MODEL_DIMENSION).put("normalized", true).put("formatVersion", 1))
    }

    private fun cors(request: HttpRequest): Map<String, String>? {
        val origin = request.headers["origin"].orEmpty()
        val allowed = origin.isBlank() || origin == "https://keepwork.com" || origin == "https://www.keepwork.com" ||
            origin.matches(Regex("http://(127\\.0\\.0\\.1|localhost):300[01]"))
        if (!allowed) return null
        val result = linkedMapOf(
            "Vary" to "Origin, Access-Control-Request-Private-Network",
            "Access-Control-Allow-Methods" to "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers" to "Content-Type, X-Request-Id",
            "Access-Control-Max-Age" to "600",
        )
        if (origin.isNotBlank()) result["Access-Control-Allow-Origin"] = origin
        if (request.headers["access-control-request-private-network"] == "true") result["Access-Control-Allow-Private-Network"] = "true"
        return result
    }

    private fun failure(status: Int, code: String, message: String, headers: Map<String, String> = emptyMap()) = HttpResponse.json(
        status,
        JSONObject().put("requestId", headers["X-Request-Id"] ?: UUID.randomUUID().toString()).put("error", JSONObject().put("code", code).put("message", message).put("retryable", status >= 500)).toString(),
        headers,
    )
}
