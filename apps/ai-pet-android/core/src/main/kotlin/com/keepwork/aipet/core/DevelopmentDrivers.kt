package com.keepwork.aipet.core

/** Records control events only, never raw audio or user content. */
class FakeAudio : AudioDriver {
    var capturing = false; private set
    val played = mutableListOf<Pair<TurnKey, Long>>()
    var releases = 0; private set
    override fun capture(enabled: Boolean) { capturing = enabled }
    override fun discardPlayback() { played.clear() }
    override fun play(key: TurnKey, sequence: Long) { played.add(key to sequence) }
    override fun release() { capturing = false; played.clear(); releases++ }
}
class FakeTransport(private val onRelease: (Lease) -> Unit = {}) : VoiceTransport {
    val cancelled = mutableListOf<TurnKey>()
    val released = mutableSetOf<Pair<String, Long>>()
    override fun cancel(key: TurnKey) { cancelled.add(key) }
    override fun release(lease: Lease) { if (released.add(lease.session to lease.fence)) onRelease(lease) }
}
/** Deterministic simulated server fencing. No account service, network, entitlement or billing claim. */
class FakeLeaseAuthority {
    private var generation = 0L
    private val owners = mutableMapOf<String, Lease>()
    @Synchronized fun acquire(binding: Binding, now: Long, explicitTakeover: Boolean = false): Lease? {
        val previous = owners[binding.account]
        if (previous != null && previous.expiresAt > now && !explicitTakeover) return null
        val fence = ++generation
        return Lease(binding, "dev-session-$fence", fence, now + 30_000).also { owners[binding.account] = it }
    }
    @Synchronized fun release(lease: Lease) { if (owners[lease.binding.account] == lease) owners.remove(lease.binding.account) }
    @Synchronized fun accepts(lease: Lease, now: Long): Boolean = owners[lease.binding.account] == lease && now < lease.expiresAt
}
