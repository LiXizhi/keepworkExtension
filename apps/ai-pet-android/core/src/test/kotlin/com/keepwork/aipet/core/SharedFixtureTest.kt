package com.keepwork.aipet.core

import java.io.File

fun sharedFixtures() {
    val input = File(System.getProperty("aiPet.fixtures", "build/shared-scenarios.tsv"))
    check(input.isFile) { "Run node scripts/prepare-shared-fixtures.mjs first" }
    var now = 0L
    var audio = FakeAudio()
    var voice = VoiceOwner(audio, FakeTransport()) { now }
    var scenario = ""
    var count = 0
    var epoch = 0L
    for (row in input.readLines()) {
        val cells = row.split('\t')
        if (cells[0] == "initial") {
            now = 0; audio = FakeAudio(); voice = VoiceOwner(audio, FakeTransport()) { now }
            scenario = cells[1]; count++
            val binding = Binding("dev-shared", "dev-character", "dev-conversation")
            val admission = Admission(true,true,true,true)
            check(voice.grant(voice.start(binding, admission)!!, Lease(binding,"shared",cells[2].toLong(),1000), admission))
            epoch = voice.key!!.localEpoch
            repeat(cells[3].toInt() - 1) { voice.spokenInterruption() }
            continue
        }
        check(cells[0] == "event")
        var accepted: Boolean? = null
        when (cells[1]) {
            "background", "lock" -> voice.visibilityChanged(false)
            "network-loss" -> voice.pause(PauseReason.NETWORK)
            "transport-restored" -> voice.transportRestored()
            "user-resume" -> {
                val checks = cells[4].split(',').map { it.toBooleanStrict() }
                if (!checks[1]) voice.end(StopReason.EXPIRED)
                voice.resume(Admission(checks[0],checks[2],checks[3],checks[4]))
            }
            "spoken-interruption" -> voice.spokenInterruption()
            "output" -> accepted = voice.audioChunk(TurnKey("shared",cells[2].toLong(),cells[3].toLong(),epoch),0)
            "lease-expired" -> { now = 1000; voice.tick() }
            "lease-revoked" -> voice.revoked("shared",voice.lease!!.fence)
            else -> error("Unknown event ${cells[1]}")
        }
        for (checkpoint in cells[5].split(',')) {
            val (field, expected) = checkpoint.split('=')
            val actual: String = when (field) {
                "session" -> voice.state.session.name.lowercase()
                "capture" -> audio.capturing.toString()
                "playback" -> audio.played.isNotEmpty().toString()
                "turnGeneration" -> voice.key!!.turn.toString()
                "accepted" -> checkNotNull(accepted).toString()
                else -> error("Unknown checkpoint $field")
            }
            check(actual == expected) { "$scenario ${cells[1]} $field: expected $expected, actual $actual" }
        }
    }
    check(count == 5)
    println("PASS $count shared fixture scenarios")
}
