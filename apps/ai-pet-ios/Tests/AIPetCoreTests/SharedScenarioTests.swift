import Foundation
import AIPetCore

/// Reads shared JSON as data; no cross-app imports or copied fixture drift.
@MainActor struct SharedScenarioTests {
    struct Fixture: Decodable { let format: String; let scenarios: [Scenario] }
    struct Scenario: Decodable { let id: String; let initial: Initial; let steps: [Step] }
    struct Initial: Decodable { let session: String?; let capture: Bool?; let leaseGeneration: UInt64?; let turnGeneration: Int? }
    struct Step: Decodable {
        let event: String
        let checks: [String: Bool]?
        let leaseGeneration: UInt64?
        let turnGeneration: Int?
        let expect: Checkpoint
    }
    struct Checkpoint: Decodable {
        let session: String?; let capture: Bool?; let playback: Bool?
        let turnGeneration: Int?; let accepted: Bool?
    }
    enum FixtureError: Error { case unknownScenario(String), unknownEvent(String), invalidInitial }

    func portableVoiceScenarios() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("contracts/ai-pet/fixtures/voice-lifecycle-scenarios.json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        try expect(fixture.format == "ai-pet.dev.scenarios.v1")
        let supported: Set<String> = ["background-lock-continuation", "interruption-deliberate-resume", "stale-turn-output", "lease-expiry", "lease-revoked"]
        try expect(Set(fixture.scenarios.map(\.id)) == supported.union(["wrong-account-migration"]))
        for scenario in fixture.scenarios {
            // Explicitly outside this native voice foundation; migration belongs to its owner.
            if scenario.id == "wrong-account-migration" { continue }
            guard supported.contains(scenario.id) else { throw FixtureError.unknownScenario(scenario.id) }
            guard scenario.initial.session == "active", scenario.initial.capture == true,
                  let lease = scenario.initial.leaseGeneration,
                  var turn = scenario.initial.turnGeneration else { throw FixtureError.invalidInitial }
            let r = Rig()
            try r.voice.startByUser(r.admission(generation: lease), now: r.now)
            var fences = [turn: try require(r.voice.outputFence)]
            for step in scenario.steps {
                var accepted: Bool?
                switch step.event {
                case "background", "lock": r.voice.visibilityChanged(isVisible: false)
                case "network-loss": r.voice.pause(.networkLoss)
                case "transport-restored": r.voice.interruptionEnded()
                case "user-resume":
                    let checks = try require(step.checks)
                    try expect(Set(checks.keys) == ["permission", "lease", "entitlement", "audioFocus", "nativeStartEligible"])
                    try r.voice.resumeByUser(r.admission(generation: lease,
                        permission: checks["permission"] == true,
                        entitlement: checks["entitlement"] == true,
                        audio: checks["audioFocus"] == true,
                        nativeEligible: checks["nativeStartEligible"] == true,
                        expiry: checks["lease"] == true ? 60 : 0), now: r.now)
                case "spoken-interruption":
                    let previous = try require(r.voice.outputFence)
                    r.voice.spokenInterruption(fence: previous)
                    let next = try require(r.voice.outputFence)
                    try expect(next != previous)
                    turn += 1; fences[turn] = next
                case "output":
                    let fence = try require(fences[try require(step.turnGeneration)])
                    try expect(fence.leaseGeneration == step.leaseGeneration)
                    accepted = r.voice.receiveAudio(Data([0]), fence: fence, sequence: 0, now: r.now)
                case "lease-expired": r.voice.checkLease(now: r.now.addingTimeInterval(60))
                case "lease-revoked": r.voice.leaseRevoked(sessionID: "dev-session-\(lease)", fencingGeneration: lease)
                default: throw FixtureError.unknownEvent(step.event)
                }
                let checkpoint = step.expect
                if let session = checkpoint.session {
                    let actual: String
                    switch r.voice.state { case .active: actual = "active"; case .paused: actual = "paused"; case .ended: actual = "ended" }
                    try expect(actual == session)
                }
                if let capture = checkpoint.capture { try expect(r.io.capture == capture) }
                if let playback = checkpoint.playback { try expect(r.io.playback == playback) }
                if let expectedTurn = checkpoint.turnGeneration { try expect(turn == expectedTurn) }
                if let expectedAccepted = checkpoint.accepted { try expect(accepted == expectedAccepted) }
            }
        }
    }
}
