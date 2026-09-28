package com.keepwork.localhelper.mcp

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.work.Data
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.keepwork.localhelper.AppConstants
import com.keepwork.localhelper.BuildConfig
import com.keepwork.localhelper.R
import com.keepwork.localhelper.net.HttpRequest
import com.keepwork.localhelper.net.HttpResponse
import com.keepwork.localhelper.net.LoopbackHttpServer
import com.keepwork.localhelper.service.NotificationFactory
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.TimeUnit

class McpServer(private val context: Context) : AutoCloseable {
    private val tokenStore = McpTokenStore(context)
    private val files = SafRepository(context)
    private val server = LoopbackHttpServer(AppConstants.MCP_PORT, "mcp", 2 * 1024 * 1024, ::handle)

    fun start() = server.start()

    override fun close() = server.close()

    private fun handle(request: HttpRequest): HttpResponse {
        val cors = cors(request) ?: return error(403, "ORIGIN_FORBIDDEN", "Origin is not allowed")
        if (request.method == "OPTIONS") return HttpResponse(204, headers = cors)
        if (request.path.substringBefore('?') == "/health" && request.method == "GET") {
            return HttpResponse.json(200, JSONObject().apply {
                put("ok", true)
                put("name", "keepwork-mcp")
                put("version", "0.1.2")
                put("hostKind", "android-helper")
                put("hostVersion", BuildConfig.VERSION_NAME)
                put("requireAuth", true)
                put("platform", "android")
                put("arch", "arm64-v8a")
                put("workspaceRoot", "/android-saf/default")
                put("fsApi", "android-saf-v1")
                put("capabilities", JSONArray(listOf("mcp", "local-model")))
                put("localModelProtocolVersion", AppConstants.MODEL_PROTOCOL_VERSION)
            }.toString(), cors)
        }
        if (request.path.substringBefore('?') != "/mcp") return error(404, "NOT_FOUND", "Endpoint not found", cors)
        if (request.headers["authorization"] != "Bearer ${tokenStore.current()}") {
            return error(401, "UNAUTHORIZED", "A valid pairing token is required", cors + ("WWW-Authenticate" to "Bearer"))
        }
        if (request.method != "POST") return error(405, "METHOD_NOT_ALLOWED", "Use POST /mcp", cors)
        val rpc = JSONObject(String(request.body, StandardCharsets.UTF_8))
        val id = rpc.opt("id")
        val method = rpc.optString("method")
        if (id == null || id == JSONObject.NULL) return HttpResponse(202, headers = cors)
        return try {
            val result = when (method) {
                "initialize" -> initializeResult()
                "ping" -> JSONObject()
                "tools/list" -> JSONObject().put("tools", tools())
                "tools/call" -> callTool(rpc.optJSONObject("params") ?: JSONObject())
                else -> return rpcError(id, -32601, "Method not found", cors)
            }
            HttpResponse.json(200, JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result).toString(), cors)
        } catch (error: Throwable) {
            HttpResponse.json(200, JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", toolError(error)).toString(), cors)
        }
    }

    private fun initializeResult() = JSONObject().apply {
        put("protocolVersion", AppConstants.MCP_PROTOCOL_VERSION)
        put("capabilities", JSONObject().put("tools", JSONObject().put("listChanged", false)))
        put("serverInfo", JSONObject().put("name", "kp-local-helper-android").put("version", BuildConfig.VERSION_NAME))
    }

    private fun tools() = JSONArray().apply {
        put(tool("mcp_status", "查看 Android MCP、授权目录和本地模型状态"))
        put(tool("list_files", "列出用户通过 Android 文件夹授权选择的目录", properties("path", "string")))
        put(tool("read_file", "读取授权目录内不超过 1 MB 的 UTF-8 文件", requiredProperties("path" to "string")))
        put(tool("write_file", "写入授权目录内不超过 1 MB 的 UTF-8 文件", requiredProperties("path" to "string", "content" to "string")))
        put(tool("search_files", "按名称搜索授权目录", requiredProperties("query" to "string")))
        put(tool("web_search", "搜索公开网页", requiredProperties("query" to "string")))
        put(tool("fetch_url", "抓取公开 HTTP(S) 页面正文，拒绝本机和内网地址", requiredProperties("url" to "string")))
        put(tool("show_notification", "显示一条本机通知", requiredProperties("title" to "string", "text" to "string")))
        put(tool("set_reminder", "创建一次本机提醒", JSONObject().apply {
            put("type", "object")
            put("properties", JSONObject().put("title", type("string")).put("text", type("string")).put("delaySeconds", type("integer")))
            put("required", JSONArray(listOf("title", "text", "delaySeconds")))
        }))
    }

    private fun callTool(params: JSONObject): JSONObject {
        val name = params.optString("name")
        val args = params.optJSONObject("arguments") ?: JSONObject()
        val result: Any = when (name) {
            "mcp_status" -> JSONObject().apply {
                put("service", "keepwork-mcp")
                put("platform", "android")
                put("port", AppConstants.MCP_PORT)
                put("safRoot", files.rootLabel())
                put("modelPort", AppConstants.MODEL_PORT)
            }
            "list_files" -> JSONArray(files.list(args.optString("path")))
            "read_file" -> String(files.read(args.requiredString("path")), StandardCharsets.UTF_8)
            "write_file" -> {
                files.write(args.requiredString("path"), args.requiredString("content").toByteArray(StandardCharsets.UTF_8))
                JSONObject().put("written", true)
            }
            "search_files" -> JSONArray(files.search(args.requiredString("query")))
            "web_search" -> fetchPublic("https://www.bing.com/search?q=${URLEncoder.encode(args.requiredString("query"), "UTF-8")}")
            "fetch_url" -> fetchPublic(args.requiredString("url"))
            "show_notification" -> showNotification(args.requiredString("title"), args.requiredString("text"))
            "set_reminder" -> setReminder(args.requiredString("title"), args.requiredString("text"), args.getLong("delaySeconds"))
            else -> throw IllegalArgumentException("Unknown tool: $name")
        }
        return toolResult(if (result is String) result else result.toString())
    }

    private fun fetchPublic(value: String): String {
        val uri = URI(value)
        require(uri.scheme == "https" || uri.scheme == "http") { "Only HTTP(S) URLs are allowed" }
        require(uri.userInfo == null && !uri.host.isNullOrBlank()) { "Invalid public URL" }
        for (address in InetAddress.getAllByName(uri.host)) {
            require(!address.isAnyLocalAddress && !address.isLoopbackAddress && !address.isLinkLocalAddress && !address.isSiteLocalAddress && !address.isMulticastAddress) {
                "Local and private network URLs are not allowed"
            }
        }
        val connection = uri.toURL().openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 8_000
        connection.readTimeout = 12_000
        connection.setRequestProperty("User-Agent", "KP-Local-Helper-Android/${BuildConfig.VERSION_NAME}")
        connection.inputStream.use { input ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (output.size() < 512_000) {
                val count = input.read(buffer, 0, minOf(buffer.size, 512_000 - output.size()))
                if (count < 0) break
                output.write(buffer, 0, count)
            }
            val source = String(output.toByteArray(), StandardCharsets.UTF_8)
            return source.replace(Regex("<script[\\s\\S]*?</script>|<style[\\s\\S]*?</style>", RegexOption.IGNORE_CASE), " ")
                .replace(Regex("<[^>]+>"), " ")
                .replace(Regex("\\s+"), " ")
                .trim().take(100_000)
        }
    }

    private fun showNotification(title: String, text: String): JSONObject {
        NotificationFactory.ensureChannel(context)
        val notification = NotificationCompat.Builder(context, AppConstants.NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_keepwork).setContentTitle(title.take(100)).setContentText(text.take(500)).setAutoCancel(true).build()
        context.getSystemService(NotificationManager::class.java).notify(UUID.randomUUID().hashCode(), notification)
        return JSONObject().put("shown", true)
    }

    private fun setReminder(title: String, text: String, delaySeconds: Long): JSONObject {
        require(delaySeconds in 1..(7 * 24 * 3600)) { "delaySeconds must be between 1 and 604800" }
        val request = OneTimeWorkRequestBuilder<ReminderWorker>()
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setInputData(Data.Builder().putString("title", title.take(100)).putString("text", text.take(500)).build())
            .build()
        WorkManager.getInstance(context).enqueue(request)
        return JSONObject().put("scheduled", true).put("id", request.id.toString())
    }

    private fun cors(request: HttpRequest): Map<String, String>? {
        val origin = request.headers["origin"].orEmpty()
        val allowed = origin.isBlank() || origin == "https://keepwork.com" || origin == "https://www.keepwork.com" ||
            origin.matches(Regex("http://(127\\.0\\.0\\.1|localhost):300[01]"))
        if (!allowed) return null
        val headers = linkedMapOf(
            "Vary" to "Origin, Access-Control-Request-Private-Network",
            "Access-Control-Allow-Methods" to "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers" to "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id",
            "Access-Control-Max-Age" to "600",
        )
        if (origin.isNotBlank()) headers["Access-Control-Allow-Origin"] = origin
        if (request.headers["access-control-request-private-network"] == "true") headers["Access-Control-Allow-Private-Network"] = "true"
        return headers
    }

    private fun tool(name: String, description: String, inputSchema: JSONObject = properties()) = JSONObject()
        .put("name", name).put("description", description).put("inputSchema", inputSchema)

    private fun properties(vararg values: String) = JSONObject().put("type", "object").put("properties", JSONObject().apply {
        values.toList().chunked(2).forEach { put(it[0], type(it[1])) }
    })

    private fun requiredProperties(vararg values: Pair<String, String>) = JSONObject().apply {
        put("type", "object")
        put("properties", JSONObject().apply { values.forEach { put(it.first, type(it.second)) } })
        put("required", JSONArray(values.map { it.first }))
    }

    private fun type(value: String) = JSONObject().put("type", value)
    private fun JSONObject.requiredString(name: String): String = getString(name).takeIf { it.isNotBlank() }
        ?: throw IllegalArgumentException("$name is required")

    private fun toolResult(text: String) = JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", text))).put("isError", false)
    private fun toolError(error: Throwable) = JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", error.message ?: "Tool failed"))).put("isError", true)
    private fun error(status: Int, code: String, message: String, headers: Map<String, String> = emptyMap()) =
        HttpResponse.json(status, JSONObject().put("error", JSONObject().put("code", code).put("message", message)).toString(), headers)
    private fun rpcError(id: Any, code: Int, message: String, headers: Map<String, String>) = HttpResponse.json(
        200, JSONObject().put("jsonrpc", "2.0").put("id", id).put("error", JSONObject().put("code", code).put("message", message)).toString(), headers,
    )
}
