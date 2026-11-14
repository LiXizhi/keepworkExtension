package com.keepwork.aipet.core

private val allowed = Admission(true, true, true, true)
private val binding = Binding("dev-a", "dev-character", "dev-conversation")
private class Rig {
    var now = 100L
    val audio = FakeAudio()
    val transport = FakeTransport()
    val voice = VoiceOwner(audio, transport) { now }
    fun start(fence: Long = 1): Lease {
        val lease = Lease(binding, "s$fence", fence, now + 1000)
        check(voice.grant(voice.start(binding, allowed)!!, lease, allowed))
        return lease
    }
}
fun main() {
    var passed = 0
    fun test(name: String, body: () -> Unit) { body(); passed++; println("PASS $name") }
    test("explicit start and every admission dimension") {
        for (denied in listOf(allowed.copy(permission=false), allowed.copy(entitlement=false),
            allowed.copy(audioFocus=false), allowed.copy(serviceStartEligible=false))) {
            val r = Rig(); check(r.voice.start(binding, denied) == null); check(!r.audio.capturing)
        }
        val r = Rig(); check(!r.audio.capturing); r.start(); check(r.audio.capturing)
        check(r.voice.start(binding, allowed) == null)
    }
    test("background and lock preserve capture and session") {
        val r = Rig(); val lease = r.start(); r.voice.visibilityChanged(false); r.voice.visibilityChanged(true)
        check(r.voice.lease == lease && r.audio.capturing && r.audio.releases == 0)
    }
    test("all interruptions require deliberate eligible resume") {
        for (reason in PauseReason.entries) {
            val r = Rig(); r.start(); val old = r.voice.key!!; r.voice.audioChunk(old, 0)
            r.voice.pause(reason); check(!r.audio.capturing && r.audio.played.isEmpty())
            r.voice.transportRestored(); check(r.voice.state.session == Session.PAUSED)
            check(!r.voice.resume(allowed.copy(serviceStartEligible=false)))
            check(!r.voice.audioChunk(old, 1)); check(r.voice.resume(allowed)); check(r.audio.capturing)
            check(!r.voice.audioChunk(old, 2))
        }
    }
    test("spoken interruption fences delayed and duplicate chunks") {
        val r = Rig(); r.start(); val old = r.voice.key!!
        check(r.voice.audioChunk(old, 4)); check(!r.voice.audioChunk(old, 4)); check(!r.voice.audioChunk(old, 3))
        val current = r.voice.spokenInterruption()!!
        check(r.audio.played.isEmpty() && old in r.transport.cancelled)
        check(!r.voice.audioChunk(old, 10)); check(r.voice.audioChunk(current, 0))
        check(!r.voice.audioChunk(current.copy(fence=99), 1)); check(!r.voice.audioChunk(current.copy(session="other"), 1))
    }
    test("mute persists through interruption and resume") {
        val r = Rig(); r.start(); r.voice.mute(true); check(!r.audio.capturing)
        r.voice.pause(PauseReason.NETWORK); r.voice.transportRestored(); check(r.voice.resume(allowed))
        check(!r.audio.capturing && r.voice.spokenInterruption() == null)
        r.voice.mute(false); check(r.audio.capturing)
    }
    test("all terminal causes clean once and never resurrect") {
        for (reason in StopReason.entries) {
            val r = Rig(); r.start(); val old = r.voice.key!!; r.voice.audioChunk(old, 0)
            r.voice.end(reason); r.voice.end(reason); r.voice.transportRestored()
            check(!r.voice.resume(allowed)); check(!r.voice.audioChunk(old, 1))
            check(!r.audio.capturing && r.audio.played.isEmpty() && r.audio.releases == 1)
            check(r.transport.released.size == 1 && r.voice.lease == null)
        }
    }
    test("expiry at exact deadline fences audio and paused capture") {
        for (paused in listOf(false, true)) {
            val r = Rig(); val lease = r.start(); val old = r.voice.key!!
            if (paused) r.voice.pause(PauseReason.PHONE_CALL)
            r.now = lease.expiresAt; r.voice.tick()
            check(r.voice.state.stopReason == StopReason.EXPIRED && !r.audio.capturing)
            check(!r.voice.audioChunk(old, 0) && !r.voice.resume(allowed))
        }
    }
    test("delayed grant after stop and new attempt is rejected") {
        val r = Rig(); val ticket = r.voice.start(binding, allowed)!!; r.voice.end()
        val next = r.voice.start(binding, allowed)!!
        val old = Lease(binding, "old", 1, 900)
        check(!r.voice.grant(ticket, old, allowed)); check(!r.audio.capturing)
        check(r.voice.grant(next, old.copy(session="new", fence=2), allowed))
        check(!r.voice.grant(ticket, old, allowed)); check(r.voice.lease?.session == "new")
    }
    test("grant revalidates native eligibility") {
        val r = Rig(); val ticket = r.voice.start(binding, allowed)!!
        check(!r.voice.grant(ticket, Lease(binding, "s", 1, 900), allowed.copy(permission=false)))
        check(!r.audio.capturing && r.voice.state.session == Session.ENDED)
    }
    test("explicit takeover fences old sender; partition ends at local expiry") {
        val server = FakeLeaseAuthority(); val r = Rig()
        val old = server.acquire(binding, r.now)!!
        check(r.voice.grant(r.voice.start(binding, allowed)!!, old, allowed))
        check(server.acquire(binding, r.now) == null)
        val next = server.acquire(binding, r.now, explicitTakeover=true)!!
        check(!server.accepts(old, r.now) && server.accepts(next, r.now))
        r.now = old.expiresAt; r.voice.tick(); check(!r.audio.capturing)
        r.voice.transportRestored(); check(!r.voice.resume(allowed))
    }
    test("revocation ignores stale notification but releases current owner") {
        val r = Rig(); val lease = r.start(3)
        r.voice.revoked("wrong", 9); r.voice.revoked(lease.session, 2); check(r.audio.capturing)
        r.voice.revoked(lease.session, 4); check(!r.audio.capturing)
        val ticket = r.voice.start(binding, allowed)!!
        check(!r.voice.grant(ticket, lease, allowed))
    }
    test("locale is independent of home region; catalog cannot select withdrawn/private entries") {
        val r = Rig(); val selection = Selection(r.voice); val account = DevAccount("dev-a", "dev-home")
        selection.signIn(account); selection.language(PetLocale.JAPANESE); check(selection.account == account)
        check(PetLocale.entries.map { it.tag }.toSet().size == 6); check(PetLocale.resolve("fr-CA") == PetLocale.FRENCH)
        check(!selection.choose("private", OfflineCatalog().catalog(account)))
        check(!selection.choose("x", CatalogResult.Available(listOf(Character("x",1,"a",true,true)))))
        check(!selection.choose("dev-placeholder", CatalogResult.Offline))
        check(selection.choose("dev-placeholder", OfflineCatalog().catalog(account)))
        r.start(); selection.signOut(); check(selection.character == null && !r.audio.capturing)
    }
    test("presentation is bounded and cannot affect voice") {
        val r = Rig(); r.start(); r.voice.audioChunk(r.voice.key!!, 0)
        check(presentation(r.voice.state,true,false,false,2f).mouth == 1f)
        for (value in listOf(Float.NaN, Float.POSITIVE_INFINITY)) check(presentation(r.voice.state,true,false,false,value).mouth == 0f)
        check(!presentation(r.voice.state,false,true,false,1f).animate)
        check(presentation(r.voice.state,true,false,true,1f).mouth == 0f && r.audio.capturing)
    }
    test("account switch cannot reuse an old output identity") {
        val r = Rig(); val first = r.start(); val old = r.voice.key!!
        r.voice.end(StopReason.SIGN_OUT)
        val other = binding.copy(account="dev-other")
        check(r.voice.grant(r.voice.start(other, allowed)!!, first.copy(binding=other), allowed))
        val current = r.voice.key!!
        check(current.session == old.session && current.fence == old.fence && current.turn == old.turn)
        check(current.localEpoch != old.localEpoch)
        check(!r.voice.audioChunk(old, 0)); check(r.voice.audioChunk(current, 0))
    }
    test("duplicate active grant does not release live lease") {
        val r = Rig(); val ticket = r.voice.start(binding, allowed)!!
        val lease = Lease(binding,"same",1,1000)
        check(r.voice.grant(ticket,lease,allowed)); check(!r.voice.grant(ticket,lease,allowed))
        check(r.audio.capturing && r.transport.released.isEmpty())
    }
    test("concurrent late output and revoke converge to clean terminal state") {
        repeat(100) {
            val r = Rig(); val lease = r.start(); val old = r.voice.key!!
            val gate = java.util.concurrent.CountDownLatch(1)
            val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
            val workers = listOf<() -> Unit>(
                { r.voice.audioChunk(old, 0) },
                { r.voice.revoked(lease.session, lease.fence) }
            ).map { action -> Thread {
                try { gate.await(); action() } catch (error: Throwable) { failure.set(error) }
            }.apply { start() } }
            gate.countDown(); workers.forEach { it.join() }; failure.get()?.let { throw it }
            check(r.voice.state.session == Session.ENDED && !r.audio.capturing && r.audio.played.isEmpty())
            check(r.audio.releases == 1 && r.transport.released.size == 1)
        }
    }
    passed += overlayTests()
    sharedFixtures()
    println("$passed deterministic Kotlin scenario groups passed")
}
