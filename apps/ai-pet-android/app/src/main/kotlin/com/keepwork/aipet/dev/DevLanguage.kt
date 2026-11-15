package com.keepwork.aipet.dev

import android.content.Context
import android.content.res.Configuration
import com.keepwork.aipet.core.*
import java.util.Locale

object DevLanguage {
    const val KEY = "ui-language"
    fun prefs(context: Context) = context.getSharedPreferences("development-presentation", Context.MODE_PRIVATE)
    fun preference(context: Context) = LanguagePreference(object : LanguageStore {
        override fun read() = prefs(context).getString(KEY, null)
        override fun write(tag: String) = prefs(context).edit().putString(KEY, tag).commit()
    }, context.resources.configuration.locales[0].toLanguageTag())
    fun wrap(context: Context): Context {
        val config = Configuration(context.resources.configuration)
        config.setLocale(Locale.forLanguageTag(preference(context).locale.tag))
        return context.createConfigurationContext(config)
    }
}
