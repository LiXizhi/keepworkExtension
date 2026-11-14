import Foundation
import AIPetCore

@MainActor final class FakeIO: NativeVoiceIO {
    var capture = false
    var starts = 0
    var plays = 0
    var playback = false
    var flushes = 0
    var failStart = false
    func startCapture() throws {
        if failStart { throw AdmissionError.denied }
        capture = true; starts += 1
    }
    func stopCapture() { capture = false }
    func stopAndFlushPlayback() { flushes += 1; playback = false }
    func play(_ bytes: Data) { plays += 1; playback = true }
}
@MainActor final class FakeProvider: VoiceProvider {
    var cancelled: [OutputFence] = []
    var released: [VoiceAdmission] = []
    func cancelOutput(_ fence: OutputFence) { cancelled.append(fence) }
    func release(_ admission: VoiceAdmission) { released.append(admission) }
}

@MainActor struct Rig {
    let io = FakeIO()
    let provider = FakeProvider()
    let voice: VoiceSession
    let now = Date(timeIntervalSince1970: 1_000)
    let context = ConversationContext(accountID: "dev-account", homeRegion: "dev-region",
                                      personaID: "dev-persona", conversationID: "dev-conversation")
    init() {
        voice = VoiceSession(io: io, provider: provider)
        voice.select(context)
    }
    func admission(generation: UInt64 = 1, permission: Bool = true, entitlement: Bool = true,
                   audio: Bool = true, transport: Bool = true, nativeEligible: Bool = true, expiry: TimeInterval = 60) -> VoiceAdmission {
        VoiceAdmission(context: context, sessionID: "dev-session-\(generation)", fencingGeneration: generation,
                       expiresAt: now.addingTimeInterval(expiry), microphoneAllowed: permission,
                       entitlementAllowed: entitlement, audioSessionAvailable: audio, transportReady: transport, nativeStartEligible: nativeEligible)
    }
    func start() throws { try voice.startByUser(admission(), now: now) }
}

@MainActor struct VoiceSessionTests {
    func admissionRequiresEveryAuthority() throws {
        let r = Rig()
        let denied = [r.admission(permission: false), r.admission(entitlement: false),
                      r.admission(nativeEligible: false), r.admission(audio: false), r.admission(transport: false), r.admission(expiry: 0)]
        for admission in denied {
            try expect(throws: AdmissionError.denied) { try r.voice.startByUser(admission, now: r.now) }
            try expect(!r.io.capture)
        }
        try r.start()
        try expect(r.io.capture)
        try expect(throws: AdmissionError.invalidState) { try r.start() }
    }

    func recoveryNeedsUserAndFreshValidation(reason: PauseReason) throws {
        let r = Rig(); try r.start()
        let old = try require(r.voice.outputFence)
        r.voice.pause(reason)
        r.voice.interruptionEnded()
        r.voice.visibilityChanged(isVisible: true)
        try expect(!r.io.capture)
        try expect(r.voice.state == .paused(reason))
        try expect(throws: AdmissionError.denied) {
            try r.voice.resumeByUser(r.admission(permission: false), now: r.now)
        }
        try r.voice.resumeByUser(r.admission(), now: r.now)
        try expect(r.io.capture)
        try expect(r.voice.outputFence != old)
        try expect(!r.voice.receiveAudio(Data([1]), fence: old, sequence: 2, now: r.now))
    }

    func spokenInterruptionAndNextTurnFenceLateAudio() throws {
        let r = Rig(); try r.start()
        let old = try require(r.voice.outputFence)
        r.voice.userTurnCompleted(fence: old)
        try expect(r.voice.receiveAudio(Data([1]), fence: old, sequence: 0, now: r.now))
        try expect(!r.voice.receiveAudio(Data([1]), fence: old, sequence: 0, now: r.now))
        r.voice.spokenInterruption(fence: old)
        let next = try require(r.voice.outputFence)
        try expect(next != old)
        try expect(r.provider.cancelled.contains(old))
        try expect(r.io.capture)
        try expect(!r.voice.receiveAudio(Data([2]), fence: old, sequence: 1, now: r.now))
        r.voice.playbackCompleted(fence: old)
        try expect(r.voice.outputFence == next)
        r.voice.userTurnCompleted(fence: next)
        try expect(r.voice.receiveAudio(Data([3]), fence: next, sequence: 0, now: r.now))
        r.voice.playbackCompleted(fence: next)
        try expect(r.voice.turn == .listening)
        try expect(!r.voice.receiveAudio(Data([4]), fence: next, sequence: 1, now: r.now))
    }

    func lockDoesNotRestartAndMuteSurvivesRecovery() throws {
        let r = Rig(); try r.start()
        r.voice.visibilityChanged(isVisible: false)
        try expect(r.io.capture && r.io.starts == 1)
        try r.voice.setMuted(true, now: r.now)
        r.voice.pause(.routeChanged)
        try r.voice.resumeByUser(r.admission(), now: r.now)
        try expect(r.voice.muted && !r.io.capture)
        try r.voice.setMuted(false, now: r.now)
        try expect(r.io.capture && r.io.starts == 2)
    }

    func expiryAndRevocationFenceSessionsAndReleaseOnce() throws {
        let r = Rig(); try r.start()
        let old = try require(r.voice.outputFence)
        r.voice.checkLease(now: r.now.addingTimeInterval(60))
        try expect(r.voice.state == .ended)
        try expect(!r.io.capture)
        r.voice.leaseRevoked(sessionID: "dev-session-1", fencingGeneration: 1)
        r.voice.end()
        try expect(r.provider.released.count == 1)
        try expect(throws: AdmissionError.staleLease) { try r.start() }
        try r.voice.startByUser(r.admission(generation: 2), now: r.now)
        try expect(!r.voice.receiveAudio(Data([1]), fence: old, sequence: 99, now: r.now))
    }

    func accountAndPersonaChangesStopBeforeNewContext() throws {
        for context in [ConversationContext(accountID: "other", homeRegion: "dev-region", personaID: "dev-persona", conversationID: "other"),
                        ConversationContext(accountID: "dev-account", homeRegion: "dev-region", personaID: "other", conversationID: "other")] {
            let r = Rig(); try r.start()
            r.voice.select(context)
            try expect(!r.io.capture && r.voice.state == .ended)
            try expect(r.provider.released.count == 1)
            try expect(throws: AdmissionError.denied) { try r.start() }
        }
    }

    func nativeStartFailureReleasesResourcesAndDoesNotReplayOnNewProcess() throws {
        let r = Rig(); r.io.failStart = true
        try expect(throws: AdmissionError.denied) { try r.start() }
        try expect(r.voice.state == .ended && !r.io.capture)
        try expect(r.provider.released.count == 1)
        let fresh = VoiceSession(io: r.io, provider: r.provider)
        try expect(fresh.state == .ended && fresh.outputFence == nil)
        fresh.interruptionEnded()
        try expect(r.io.starts == 0)
    }

    func revokedLeaseCannotResumeAndRenewalDoesNotReleaseSameLease() throws {
        let r = Rig(); try r.start()
        r.voice.pause(.networkLoss)
        try r.voice.resumeByUser(r.admission(expiry: 120), now: r.now)
        try expect(r.provider.released.isEmpty)
        r.voice.leaseRevoked(sessionID: "dev-session-1", fencingGeneration: 1)
        try expect(r.voice.state == .ended)
        try expect(throws: AdmissionError.staleLease) {
            try r.voice.startByUser(r.admission(), now: r.now)
        }
        try r.voice.startByUser(r.admission(generation: 2), now: r.now)
        try expect(r.io.capture)
    }

    func staleRevocationDoesNotTerminateNewLease() throws {
        let r = Rig(); try r.start()
        r.voice.end()
        try r.voice.startByUser(r.admission(generation: 2), now: r.now)
        r.voice.leaseRevoked(sessionID: "dev-session-1", fencingGeneration: 1)
        r.voice.leaseRevoked(sessionID: "dev-session-2", fencingGeneration: 1)
        try expect(r.voice.state == .active && r.io.capture)
        r.voice.leaseRevoked(sessionID: "dev-session-2", fencingGeneration: 2)
        try expect(r.voice.state == .ended && !r.io.capture)
    }

    func expiredLeaseCannotRestartCaptureThroughUnmute() throws {
        let r = Rig(); try r.start()
        try r.voice.setMuted(true, now: r.now)
        try r.voice.setMuted(false, now: r.now.addingTimeInterval(60))
        try expect(!r.io.capture && r.voice.state == .ended)
    }

    func permissionAndAllowanceEndCapture() throws {
        let r = Rig(); try r.start()
        r.voice.permissionRevoked()
        try expect(!r.io.capture && r.voice.state == .ended)
        try r.voice.startByUser(r.admission(generation: 2), now: r.now)
        r.voice.allowanceExhausted()
        try expect(!r.io.capture && r.provider.released.count == 2)
    }
}
