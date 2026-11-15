package com.keepwork.aipet.core

interface LanguageStore { fun read(): String?; fun write(tag: String): Boolean }
/** UI preference only: deliberately no account, region, session or service dependencies. */
class LanguagePreference(private val store: LanguageStore, systemTag: String) {
    var locale = PetLocale.resolve(store.read() ?: systemTag); private set
    fun select(value: PetLocale): Boolean {
        if (!store.write(value.tag)) return false
        locale = value
        return true
    }
}
data class PreviewGate(val attached: Boolean, val visible: Boolean, val active: Boolean,
    val interactive: Boolean, val locked: Boolean, val reducedMotion: Boolean, val systemMotion: Boolean) {
    fun mouth(pose: Pose, level: Float): Float = if (attached && visible && active && interactive && !locked &&
        !reducedMotion && systemMotion && pose == Pose.SPEAKING && level.isFinite()) level.coerceIn(0f, 1f) else 0f
}
