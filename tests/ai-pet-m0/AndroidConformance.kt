package com.keepwork.aipet.qa

import com.keepwork.aipet.core.*

fun main() {
    val openGate = PreviewGate(true, true, true, true, false, false, true)
    for (blocked in listOf(openGate.copy(attached=false), openGate.copy(visible=false), openGate.copy(active=false), openGate.copy(interactive=false), openGate.copy(locked=true), openGate.copy(reducedMotion=true), openGate.copy(systemMotion=false))) {
        check(blocked.mouth(Pose.SPEAKING, 1f) == 0f)
    }
    for (level in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, -1f, 0f, 1f, 2f)) {
        val mouth = openGate.mouth(Pose.SPEAKING, level)
        check(mouth.isFinite() && mouth in 0f..1f)
        check(openGate.mouth(Pose.IDLE, level) == 0f)
    }
    val languageStore = object : LanguageStore {
        var saved: String? = null
        var writable = true
        override fun read() = saved
        override fun write(tag: String): Boolean { if (!writable) return false; saved=tag; return true }
    }
    val preference = LanguagePreference(languageStore, "ja-JP")
    check(preference.select(PetLocale.FRENCH))
    check(LanguagePreference(languageStore, "en-US").locale == PetLocale.FRENCH)
    languageStore.writable=false
    check(!preference.select(PetLocale.KOREAN) && preference.locale == PetLocale.FRENCH)

    val audio = FakeAudio()
    val voice = VoiceOwner(audio, FakeTransport()) { 0L }
    val admission = Admission(true, true, true, true)
    val a = Binding("qa-a", "qa-pet", "qa-chat")
    val b = Binding("qa-b", "qa-pet", "qa-chat")
    fun start(binding: Binding) {
        val ticket = checkNotNull(voice.start(binding, admission))
        check(voice.grant(ticket, Lease(binding, "collision", 1, 1000), admission))
    }
    start(a)
    val stale = checkNotNull(voice.key)
    voice.end(StopReason.SIGN_OUT)
    start(b)
    check(!voice.audioChunk(stale, 0)) { "Prior-account output accepted after session/fence/turn collision" }
    check(audio.played.isEmpty())
    voice.visibilityChanged(false)
    check(audio.capturing)
    voice.pause(PauseReason.NETWORK)
    voice.transportRestored()
    check(!audio.capturing)
    check(voice.resume(admission))
    check(audio.capturing)
    val overlayDriver = object : OverlayDriver {
        var attached = 0
        var detached = 0
        override fun attach(): Boolean { attached++; return true }
        override fun detach() { detached++ }
    }
    val overlay = OverlayOwner(overlayDriver)
    overlay.reconcile(true, true)
    check(!overlay.showing && overlayDriver.attached == 0) // permission return alone never starts it
    check(!overlay.show(false, true))
    check(overlay.show(true, true))
    overlay.reconcile(true, true) // service remains alive while the Activity is hidden
    check(overlay.showing && overlayDriver.detached == 0)
    overlay.reconcile(false, true) // permission revocation removes service-owned presentation
    check(!overlay.showing && overlayDriver.detached == 1)
    check(audio.capturing) // presentation lifecycle does not authorize/stop the voice core
    overlay.stop()
    check(overlayDriver.detached == 1)
    val gate = OverlayStartGate("qa-process-a")
    check(!gate.consume(null))
    val superseded = gate.issue()
    val current = gate.issue()
    check(!gate.consume(superseded))
    check(gate.consume(current))
    check(!gate.consume(current)) // OS redelivery cannot reuse admission
    val cancelled = gate.issue()
    gate.cancel()
    check(!gate.consume(cancelled))
    val priorProcess = gate.issue()
    val recreated = OverlayStartGate("qa-process-b")
    check(!recreated.consume(priorProcess))
    val fresh = recreated.issue()
    check(!recreated.consume(priorProcess)) // stale token must not consume a fresh grant
    check(recreated.consume(fresh))
    overlay.reconcile(true, true)
    check(!overlay.showing) // permission return with service alive is not explicit show
    println("PASS independent Android account-fence, manual-resume, service-overlay and one-use admission")
}
