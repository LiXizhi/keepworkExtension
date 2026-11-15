package com.keepwork.aipet.core

fun developmentPresentationTests(): Int {
    class Store : LanguageStore {
        var value: String? = null; var allowed = true
        override fun read() = value
        override fun write(tag: String): Boolean { if (!allowed) return false; value = tag; return true }
    }
    run {
        val store = Store()
        check(LanguagePreference(store,"fr-CA").locale == PetLocale.FRENCH)
        check(LanguagePreference(store,"zz-Unknown").locale == PetLocale.ENGLISH)
        check(PetLocale.resolve(" ES_mx ") == PetLocale.SPANISH)
        for (language in PetLocale.entries) {
            check(LanguagePreference(store,"en-US").select(language))
            check(LanguagePreference(store,"ja-JP").locale == language)
            check(store.value == language.tag)
        }
        store.value = "unsupported"
        check(LanguagePreference(store,"ko-KR").locale == PetLocale.ENGLISH)
        val preference = LanguagePreference(store,"en-US"); store.allowed = false
        check(!preference.select(PetLocale.CHINESE) && preference.locale == PetLocale.ENGLISH)
        println("PASS six UI locales persist independently, normalize fallback and handle failed writes")
    }
    run {
        val enabled = PreviewGate(true,true,true,true,false,false,true)
        check(enabled.mouth(Pose.SPEAKING,2f) == 1f)
        check(enabled.mouth(Pose.SPEAKING,-1f) == 0f)
        for (pose in Pose.entries.filter { it != Pose.SPEAKING }) check(enabled.mouth(pose,1f) == 0f)
        for (gate in listOf(enabled.copy(attached=false),enabled.copy(visible=false),enabled.copy(active=false),
            enabled.copy(interactive=false),enabled.copy(locked=true),enabled.copy(reducedMotion=true),enabled.copy(systemMotion=false))) {
            check(gate.mouth(Pose.SPEAKING,1f) == 0f)
        }
        check(enabled.mouth(Pose.SPEAKING,Float.NaN) == 0f)
        check(enabled.mouth(Pose.SPEAKING,Float.POSITIVE_INFINITY) == 0f)
        println("PASS seven poses and bounded synthetic mouth respect lifecycle, lock and motion gates")
    }
    return 2
}
