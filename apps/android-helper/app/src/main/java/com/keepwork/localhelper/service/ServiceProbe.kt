package com.keepwork.localhelper.service

import com.keepwork.localhelper.AppConstants
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object ServiceProbe {
    fun compatibleMcp(): Boolean = runCatching {
        val value = getJson("http://127.0.0.1:${AppConstants.MCP_PORT}/health")
        value.optBoolean("ok") && value.optString("name") == "keepwork-mcp"
    }.getOrDefault(false)

    fun compatibleModel(): Boolean = runCatching {
        val value = getJson("http://127.0.0.1:${AppConstants.MODEL_PORT}/v1/health")
        value.optString("service") == "keepwork-local-model" &&
            value.optString("protocolVersion") == AppConstants.MODEL_PROTOCOL_VERSION &&
            value.optString("status") == "ok" &&
            (0 until value.optJSONArray("models")!!.length()).any {
                val model = value.getJSONArray("models").getJSONObject(it)
                model.optString("id") == AppConstants.MODEL_ID && model.optBoolean("installed") && model.optBoolean("trusted")
            }
    }.getOrDefault(false)

    private fun getJson(value: String): JSONObject {
        val connection = URL(value).openConnection() as HttpURLConnection
        connection.connectTimeout = 800
        connection.readTimeout = 800
        connection.useCaches = false
        require(connection.responseCode == 200) { "HTTP ${connection.responseCode}" }
        return connection.inputStream.use { JSONObject(String(it.readBytes(), Charsets.UTF_8)) }
    }
}
