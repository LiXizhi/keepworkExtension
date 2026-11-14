package com.keepwork.aipet.core

/** Development domain types, not a production wire protocol. Time is monotonic milliseconds. */
data class Binding(val account: String, val character: String, val conversation: String)
data class Lease(val binding: Binding, val session: String, val fence: Long, val expiresAt: Long)
data class TurnKey(val session: String, val fence: Long, val turn: Long, val localEpoch: Long)
data class Admission(val permission: Boolean, val entitlement: Boolean, val audioFocus: Boolean,
                     val serviceStartEligible: Boolean) {
    val allowed get() = permission && entitlement && audioFocus && serviceStartEligible
}
enum class Session { ENDED, CONNECTING, ACTIVE, PAUSED }
enum class Turn { IDLE, LISTENING, GENERATING, PLAYING, INTERRUPTED }
enum class Transport { UNAVAILABLE, READY, RECONNECTING, EXPIRED }
enum class StopReason { USER, SIGN_OUT, PERMISSION_REVOKED, EXPIRED, TAKEOVER, ALLOWANCE, DRIVER_FAILURE }
enum class PauseReason { PHONE_CALL, COMPETING_RECORDER, NETWORK, AUDIO_FOCUS }
data class VoiceState(val session: Session = Session.ENDED, val turn: Turn = Turn.IDLE,
    val transport: Transport = Transport.UNAVAILABLE, val muted: Boolean = false,
    val pauseReason: PauseReason? = null, val stopReason: StopReason? = null)

/** Implementations must be nonblocking, nonthrowing, and must not call back inline. Serialized by VoiceOwner. */
interface AudioDriver {
    fun capture(enabled: Boolean)
    fun discardPlayback()
    fun play(key: TurnKey, sequence: Long)
    fun release()
}
interface VoiceTransport {
    fun cancel(key: TurnKey)
    /** Idempotency key is the lease session + fence; settlement belongs to the service. */
    fun release(lease: Lease)
}

/** One native owner, independent of renderer visibility. No microphone implementation is supplied. */
class VoiceOwner(private val audio: AudioDriver, private val transport: VoiceTransport,
                 private val now: () -> Long) {
    var state = VoiceState(); private set
    var lease: Lease? = null; private set
    private var pending: Binding? = null
    private var attempt = 0L
    private var localEpoch = 0L
    private var turn = 0L
    private var sequence = -1L
    private val highestFence = mutableMapOf<String, Long>()
    val key: TurnKey? get() = lease?.let { TurnKey(it.session, it.fence, turn, localEpoch) }

    @Synchronized fun start(binding: Binding, admission: Admission): Long? {
        if (state.session != Session.ENDED || !admission.allowed) return null
        if (listOf(binding.account, binding.character, binding.conversation).any { it.isBlank() }) return null
        pending = binding
        state = VoiceState(session = Session.CONNECTING)
        return ++attempt
    }

    /** A delayed grant cannot restart an ended/newer session. Revalidate all native admission at delivery. */
    @Synchronized fun grant(ticket: Long, candidate: Lease, admission: Admission): Boolean {
        if (ticket != attempt || state.session != Session.CONNECTING || candidate.binding != pending) {
            // Releasing a duplicate of the current grant would accidentally revoke our live session.
            if (candidate.session != lease?.session || candidate.fence != lease?.fence) transport.release(candidate)
            return false
        }
        if (!admission.allowed || candidate.session.isBlank() || candidate.expiresAt <= now() ||
            candidate.fence <= (highestFence[candidate.binding.account] ?: 0L)) {
            transport.release(candidate)
            end(StopReason.EXPIRED)
            return false
        }
        localEpoch++
        lease = candidate
        highestFence[candidate.binding.account] = candidate.fence
        pending = null
        turn = 1; sequence = -1
        state = VoiceState(Session.ACTIVE, Turn.LISTENING, Transport.READY)
        audio.capture(true)
        return true
    }

    /** App switching and lock change drawing only; they never convey capture authority. */
    @Synchronized fun visibilityChanged(visible: Boolean) { /* deliberately no voice effect */ }

    @Synchronized fun pause(reason: PauseReason) {
        if (!live() || state.session != Session.ACTIVE) return
        invalidateTurn()
        audio.capture(false)
        state = state.copy(session = Session.PAUSED, turn = Turn.INTERRUPTED, pauseReason = reason,
            transport = if (reason == PauseReason.NETWORK) Transport.RECONNECTING else state.transport)
    }
    @Synchronized fun transportRestored() {
        if (live() && state.session == Session.PAUSED) state = state.copy(transport = Transport.READY)
    }
    @Synchronized fun resume(admission: Admission): Boolean {
        if (!live() || state.session != Session.PAUSED || state.transport != Transport.READY || !admission.allowed) return false
        state = state.copy(session = Session.ACTIVE, turn = Turn.LISTENING, pauseReason = null)
        audio.capture(!state.muted)
        return true
    }
    @Synchronized fun mute(muted: Boolean) {
        if (!live()) return
        state = state.copy(muted = muted)
        audio.capture(state.session == Session.ACTIVE && !muted)
    }
    @Synchronized fun spokenInterruption(): TurnKey? {
        if (!live() || state.session != Session.ACTIVE || state.muted) return null
        invalidateTurn()
        state = state.copy(turn = Turn.LISTENING)
        return key
    }
    @Synchronized fun generating() {
        if (live() && state.session == Session.ACTIVE) state = state.copy(turn = Turn.GENERATING)
    }
    @Synchronized fun audioChunk(incoming: TurnKey, seq: Long): Boolean {
        if (!live() || state.session != Session.ACTIVE || incoming != key || seq < 0 || seq <= sequence) return false
        sequence = seq
        state = state.copy(turn = Turn.PLAYING)
        audio.play(incoming, seq)
        return true
    }
    /** Call from an independent monotonic watchdog even when the UI is hidden. */
    @Synchronized fun tick() { live() }
    @Synchronized fun revoked(session: String, fence: Long) {
        val current = lease ?: return
        if (current.session == session && fence >= current.fence) end(StopReason.TAKEOVER)
    }
    @Synchronized fun end(reason: StopReason = StopReason.USER) {
        if (state.session == Session.ENDED) return
        invalidateTurn()
        audio.capture(false)
        audio.release()
        lease?.let { transport.release(it) }
        lease = null; pending = null; attempt++
        state = VoiceState(stopReason = reason,
            transport = if (reason == StopReason.EXPIRED) Transport.EXPIRED else Transport.UNAVAILABLE)
    }
    private fun live(): Boolean {
        val current = lease ?: return false
        if (now() >= current.expiresAt) { end(StopReason.EXPIRED); return false }
        return true
    }
    private fun invalidateTurn() {
        key?.let { transport.cancel(it) }
        audio.discardPlayback()
        turn++; sequence = -1
    }
}
