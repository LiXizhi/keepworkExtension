package com.keepwork.aipet.core

enum class PetLocale(val tag: String) {
    CHINESE("zh-CN"), ENGLISH("en-US"), SPANISH("es-ES"), KOREAN("ko-KR"), JAPANESE("ja-JP"), FRENCH("fr-FR");
    companion object {
        fun resolve(tag: String): PetLocale = resolveNormalized(tag.trim().replace('_', '-'))
        private fun resolveNormalized(tag: String): PetLocale = entries.firstOrNull { it.tag.equals(tag, true) }
            ?: entries.firstOrNull { it.tag.substringBefore('-').equals(tag.substringBefore('-'), true) }
            ?: ENGLISH
    }
}
data class DevAccount(val id: String, val homeRegion: String)
data class Character(val id: String, val version: Int, val appearance: String, val eligible: Boolean,
                     val withdrawn: Boolean = false)
sealed interface CatalogResult {
    data class Available(val characters: List<Character>) : CatalogResult
    data object Offline : CatalogResult
}
interface CatalogService { fun catalog(account: DevAccount): CatalogResult }
/** Synthetic developer fixture; never represents the official launch catalog or licensed assets. */
class OfflineCatalog : CatalogService {
    override fun catalog(account: DevAccount) = CatalogResult.Available(listOf(
        Character("dev-placeholder", 1, "dev-geometric-placeholder", true)))
}
class Selection(private val voice: VoiceOwner) {
    var account: DevAccount? = null; private set
    var character: Character? = null; private set
    var locale = PetLocale.ENGLISH; private set
    fun language(value: PetLocale) { locale = value }
    fun signIn(value: DevAccount) {
        if (account != value) { voice.end(StopReason.SIGN_OUT); character = null }
        account = value
    }
    fun choose(id: String, catalog: CatalogResult): Boolean {
        if (account == null || catalog !is CatalogResult.Available) return false
        val choice = catalog.characters.singleOrNull { it.id == id && it.eligible && !it.withdrawn } ?: return false
        if (character?.id != choice.id) voice.end()
        character = choice
        return true
    }
    fun signOut() { voice.end(StopReason.SIGN_OUT); account = null; character = null }
}
enum class Pose { IDLE, HAPPY, LISTENING, THINKING, SPEAKING, SLEEPING, ERROR }
data class Presentation(val pose: Pose, val mouth: Float, val animate: Boolean)
fun presentation(state: VoiceState, visible: Boolean, locked: Boolean, reducedMotion: Boolean, amplitude: Float): Presentation {
    val animate = visible && !locked && !reducedMotion
    val pose = when {
        state.session == Session.PAUSED -> Pose.ERROR
        state.session == Session.ENDED -> Pose.IDLE
        state.turn == Turn.PLAYING -> Pose.SPEAKING
        state.turn == Turn.GENERATING -> Pose.THINKING
        else -> Pose.LISTENING
    }
    return Presentation(pose, if (animate && pose == Pose.SPEAKING && amplitude.isFinite()) amplitude.coerceIn(0f, 1f) else 0f, animate)
}
