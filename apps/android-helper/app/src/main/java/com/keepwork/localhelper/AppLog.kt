package com.keepwork.localhelper

import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object AppLog {
    private const val LIMIT = 500
    private val entries = ArrayDeque<String>()
    private val formatter = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    @Synchronized
    fun info(event: String, detail: String = "") = append("I", event, detail)

    @Synchronized
    fun warn(event: String, detail: String = "") = append("W", event, detail)

    @Synchronized
    fun error(event: String, throwable: Throwable) {
        append("E", event, throwable.message ?: throwable.javaClass.simpleName)
        Log.e("KPHelper", event, throwable)
    }

    @Synchronized
    fun snapshot(): String = entries.joinToString(separator = "\n", postfix = "\n")

    private fun append(level: String, event: String, detail: String) {
        val line = "${formatter.format(Date())} $level $event${if (detail.isBlank()) "" else " $detail"}"
        entries.addLast(line)
        while (entries.size > LIMIT) entries.removeFirst()
        Log.println(if (level == "E") Log.ERROR else if (level == "W") Log.WARN else Log.INFO, "KPHelper", line)
    }
}
