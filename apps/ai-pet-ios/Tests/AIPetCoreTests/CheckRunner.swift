import Foundation
import AIPetCore

struct CheckFailure: Error, CustomStringConvertible {
    let description: String
}
@MainActor func expect(_ condition: @autoclosure () throws -> Bool,
                       file: StaticString = #filePath, line: UInt = #line) throws {
    guard try condition() else { throw CheckFailure(description: "\(file):\(line): expectation failed") }
}
@MainActor func expect<E: Error & Equatable>(throws expected: E,
    file: StaticString = #filePath, line: UInt = #line, _ operation: () throws -> Void) throws {
    do { try operation() }
    catch {
        guard let actual = error as? E, actual == expected else {
            throw CheckFailure(description: "\(file):\(line): expected \(expected), got \(error)")
        }
        return
    }
    throw CheckFailure(description: "\(file):\(line): expected error \(expected)")
}
@MainActor func require<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    guard let value else { throw CheckFailure(description: "\(file):\(line): required value missing") }
    return value
}

/// Standard-library assertions so the suite runs on CommandLineTools without XCTest/Testing.
@main struct CheckRunner {
    @MainActor static func main() throws {
        let voice = VoiceSessionTests()
        let widget = WidgetSnapshotTests()
        let shared = SharedScenarioTests()
        let disk = FileWidgetStorageTests()
        let presentation = PresentationTests()
        let checks: [(String, () throws -> Void)] = [
            ("six language resources", presentation.resourceCoverage),
            ("persisted preference and widget isolation", presentation.preferenceAndWidgetIsolation),
            ("motion and mouth policy", presentation.presentationPolicy),
            ("admission authorities", voice.admissionRequiresEveryAuthority),
            ("audio interruption", { try voice.recoveryNeedsUserAndFreshValidation(reason: .audioInterruption) }),
            ("network interruption", { try voice.recoveryNeedsUserAndFreshValidation(reason: .networkLoss) }),
            ("route interruption", { try voice.recoveryNeedsUserAndFreshValidation(reason: .routeChanged) }),
            ("spoken interruption and stale output", voice.spokenInterruptionAndNextTurnFenceLateAudio),
            ("lock and sticky mute", voice.lockDoesNotRestartAndMuteSurvivesRecovery),
            ("expiry and idempotent release", voice.expiryAndRevocationFenceSessionsAndReleaseOnce),
            ("account/persona switch", voice.accountAndPersonaChangesStopBeforeNewContext),
            ("native start failure and cold process", voice.nativeStartFailureReleasesResourcesAndDoesNotReplayOnNewProcess),
            ("revocation and renewed lease", voice.revokedLeaseCannotResumeAndRenewalDoesNotReleaseSameLease),
            ("stale revoke callback", voice.staleRevocationDoesNotTerminateNewLease),
            ("expired unmute", voice.expiredLeaseCannotRestartCaptureThroughUnmute),
            ("permission and allowance", voice.permissionAndAllowanceEndCapture),
            ("signout snapshot and delayed write", widget.signoutClearsStorageAndRejectsInFlightPublish),
            ("snapshot cold launch", widget.transitionAndColdLaunchClearPriorSnapshot),
            ("snapshot privacy and six locales", widget.snapshotHasOnlyAllowlistedFieldsAndSixLocales),
            ("five shared voice fixtures", shared.portableVoiceScenarios),
            ("durable atomic snapshot", disk.durableAtomicReplacementAndRemoval),
            ("concurrent atomic readers", disk.concurrentReadersNeverObservePartialReplacement),
            ("disk signout and cold launch", disk.diskAccountInvalidationAndColdStart),
            ("corrupt and oversized snapshots", disk.corruptOversizedAndUnsupportedDataFailClosed),
            ("failed deletion and retry", disk.failedDeletionIsVisibleAndBlocksPublicationUntilRetry),
            ("symlink isolation", disk.symlinkDoesNotReadWriteOrRemoveItsTarget),
            ("safe widget links", disk.linksCannotSupplyAccountOrStartVoice)
        ]
        var failures: [String] = []
        for (name, run) in checks {
            do { try run(); print("PASS \(name)") }
            catch { failures.append(name); print("FAIL \(name): \(error)") }
        }
        print("\(checks.count - failures.count)/\(checks.count) checks passed (offline doubles; no device/services)")
        fflush(nil)
        guard failures.isEmpty else { throw CheckFailure(description: failures.joined(separator: ", ")) }
    }
}
