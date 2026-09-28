package com.keepwork.localhelper.policy

import android.content.Context
import android.content.RestrictionsManager
import java.security.MessageDigest

object AdminAccess {
    private const val HASH_KEY = "adminPinSha256"
    private const val STORE = "admin-access"

    fun configured(context: Context): Boolean = expectedHash(context) != null

    fun configureOnce(context: Context, pin: CharArray) {
        check(!configured(context)) { "Administrator PIN is already configured" }
        require(pin.size >= 8) { "管理员 PIN 至少需要 8 位" }
        val hash = hash(pin)
        context.createDeviceProtectedStorageContext().getSharedPreferences(STORE, Context.MODE_PRIVATE)
            .edit().putString(HASH_KEY, hash).commit()
    }

    fun verify(context: Context, pin: CharArray): Boolean {
        val expected = expectedHash(context) ?: return false
        val actual = hash(pin)
        return MessageDigest.isEqual(expected.toByteArray(), actual.toByteArray())
    }

    private fun expectedHash(context: Context): String? {
        val restrictions = context.getSystemService(RestrictionsManager::class.java).applicationRestrictions
        val managed = restrictions.getString(HASH_KEY)?.lowercase()?.takeIf { it.matches(Regex("[a-f0-9]{64}")) }
        return managed ?: context.createDeviceProtectedStorageContext().getSharedPreferences(STORE, Context.MODE_PRIVATE)
            .getString(HASH_KEY, null)?.lowercase()?.takeIf { it.matches(Regex("[a-f0-9]{64}")) }
    }

    private fun hash(pin: CharArray): String {
        val bytes = String(pin).toByteArray(Charsets.UTF_8)
        pin.fill('\u0000')
        return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
