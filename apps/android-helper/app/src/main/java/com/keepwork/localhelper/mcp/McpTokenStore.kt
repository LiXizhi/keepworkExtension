package com.keepwork.localhelper.mcp

import android.content.Context
import android.util.Base64
import java.security.SecureRandom

class McpTokenStore(context: Context) {
    private val protectedContext = context.createDeviceProtectedStorageContext()
    private val preferences = protectedContext.getSharedPreferences("mcp-auth", Context.MODE_PRIVATE)

    fun current(): String {
        val existing = preferences.getString("token", null)
        if (!existing.isNullOrBlank()) return existing
        return regenerate()
    }

    fun regenerate(): String {
        val bytes = ByteArray(32).also(SecureRandom()::nextBytes)
        val token = Base64.encodeToString(bytes, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)
        preferences.edit().putString("token", token).commit()
        return token
    }
}
