import Foundation

/// Development-domain values, NOT a production wire contract or locally granted quota.
public struct VoiceAdmission: Equatable, Sendable {
    public let context: ConversationContext
    public let sessionID: String
    public let fencingGeneration: UInt64
    public let expiresAt: Date
    public let microphoneAllowed: Bool
    public let entitlementAllowed: Bool
    public let audioSessionAvailable: Bool
    public let transportReady: Bool
    public let nativeStartEligible: Bool

    public init(context: ConversationContext, sessionID: String, fencingGeneration: UInt64,
                expiresAt: Date, microphoneAllowed: Bool, entitlementAllowed: Bool,
                audioSessionAvailable: Bool, transportReady: Bool, nativeStartEligible: Bool) {
        self.context = context
        self.sessionID = sessionID
        self.fencingGeneration = fencingGeneration
        self.expiresAt = expiresAt
        self.microphoneAllowed = microphoneAllowed
        self.entitlementAllowed = entitlementAllowed
        self.audioSessionAvailable = audioSessionAvailable
        self.transportReady = transportReady
        self.nativeStartEligible = nativeStartEligible
    }
}

public struct OutputFence: Equatable, Sendable {
    public let sessionID: String
    public let leaseGeneration: UInt64
    public let localEpoch: UUID
    public let turnID: UUID
}

public enum PauseReason: String, Sendable {
    case audioInterruption, networkLoss, routeChanged
}
public enum SessionState: Equatable, Sendable {
    case ended, active, paused(PauseReason)
}
public enum TurnState: String, Sendable { case idle, listening, generating, playing }
public enum AdmissionError: Error, Equatable { case invalidState, denied, staleLease }

/// Native adapters must synchronously stop/flush local resources; provider cancellation
/// is best effort. Adapters must not persist microphone bytes or untagged queued audio.
@MainActor public protocol NativeVoiceIO: AnyObject {
    func startCapture() throws
    func stopCapture()
    func stopAndFlushPlayback()
    func play(_ bytes: Data)
}
@MainActor public protocol VoiceProvider: AnyObject {
    func cancelOutput(_ fence: OutputFence)
    /// Production implementation must make release/settlement idempotent remotely.
    func release(_ admission: VoiceAdmission)
}

/// Serial native owner. Visibility and widget updates never grant microphone authority.
/// Caller must feed native interruptions and run checkLease from a monotonic watchdog.
@MainActor public final class VoiceSession {
    public private(set) var state: SessionState = .ended
    public private(set) var turn: TurnState = .idle
    public private(set) var muted = false
    public private(set) var context: ConversationContext?
    public private(set) var outputFence: OutputFence?
    private var admission: VoiceAdmission?
    private var lastSequence: Int = -1
    private var highestGeneration: [String: UInt64] = [:]
    private let io: any NativeVoiceIO
    private let provider: any VoiceProvider

    public init(io: any NativeVoiceIO, provider: any VoiceProvider) {
        self.io = io
        self.provider = provider
    }

    public func select(_ context: ConversationContext?) {
        guard self.context != context else { return }
        end()
        self.context = context
    }

    /// Call only from a deliberate user Start action after adapter admission.
    public func startByUser(_ candidate: VoiceAdmission, now: Date) throws {
        guard state == .ended else { throw AdmissionError.invalidState }
        try validate(candidate, now: now)
        muted = false
        try activate(candidate)
    }

    /// Recovery notifications alone do not call this method.
    public func resumeByUser(_ candidate: VoiceAdmission, now: Date) throws {
        guard case .paused = state else { throw AdmissionError.invalidState }
        try validate(candidate, now: now)
        if let previous = admission,
           previous.sessionID != candidate.sessionID || previous.fencingGeneration != candidate.fencingGeneration {
            provider.release(previous)
            admission = nil
        }
        try activate(candidate)
    }

    private func validate(_ candidate: VoiceAdmission, now: Date) throws {
        guard candidate.context == context, !candidate.sessionID.isEmpty,
              candidate.expiresAt > now, candidate.microphoneAllowed,
              candidate.entitlementAllowed, candidate.audioSessionAvailable,
              candidate.transportReady, candidate.nativeStartEligible else { throw AdmissionError.denied }
        // A released or replaced lease cannot be reused, even on a return to this account.
        if let highest = highestGeneration[candidate.context.accountID] {
            let sameLiveLease = admission?.sessionID == candidate.sessionID &&
                admission?.fencingGeneration == candidate.fencingGeneration
            guard candidate.fencingGeneration > highest ||
                    (candidate.fencingGeneration == highest && sameLiveLease) else {
                throw AdmissionError.staleLease
            }
        }
    }

    private func activate(_ candidate: VoiceAdmission) throws {
        admission = candidate
        highestGeneration[candidate.context.accountID] = candidate.fencingGeneration
        do {
            if !muted { try io.startCapture() }
        } catch {
            end()
            throw error
        }
        state = .active
        turn = .listening
        newFence()
    }

    private func invalidateOutput() {
        io.stopAndFlushPlayback()
        if let outputFence { provider.cancelOutput(outputFence) }
        outputFence = nil
        lastSequence = -1
    }

    private func newFence() {
        guard let admission else { return }
        outputFence = OutputFence(sessionID: admission.sessionID,
                                  leaseGeneration: admission.fencingGeneration,
                                  localEpoch: UUID(), turnID: UUID())
        lastSequence = -1
    }

    public func pause(_ reason: PauseReason) {
        guard state != .ended else { return }
        io.stopCapture()
        invalidateOutput()
        state = .paused(reason)
        turn = .idle
    }

    /// Deliberately does nothing: transport/OS recovery is not user consent to resume.
    public func interruptionEnded() {}
    public func visibilityChanged(isVisible: Bool) {}

    public func checkLease(now: Date) {
        if let admission, admission.expiresAt <= now { end() }
    }

    public func permissionRevoked() { end() }
    public func allowanceExhausted() { end() }
    /// Callback identity must match the currently admitted lease; delayed revocation
    /// from an earlier transport/session must not terminate its replacement.
    public func leaseRevoked(sessionID: String, fencingGeneration: UInt64) {
        guard let admission, admission.sessionID == sessionID,
              admission.fencingGeneration == fencingGeneration else { return }
        end()
    }

    public func setMuted(_ value: Bool, now: Date) throws {
        checkLease(now: now)
        guard state == .active else { return }
        guard muted != value else { return }
        if value {
            io.stopCapture()
            muted = true
        } else {
            do { try io.startCapture(); muted = false }
            catch { pause(.audioInterruption); throw error }
        }
    }

    /// Speech detector events are accepted only from the current capture generation.
    public func spokenInterruption(fence: OutputFence) {
        guard state == .active, !muted, outputFence == fence else { return }
        invalidateOutput()
        newFence()
        turn = .listening
    }

    public func userTurnCompleted(fence: OutputFence) {
        guard state == .active, !muted, outputFence == fence, turn == .listening else { return }
        turn = .generating
    }

    @discardableResult
    public func receiveAudio(_ bytes: Data, fence: OutputFence, sequence: Int, now: Date) -> Bool {
        checkLease(now: now)
        guard state == .active, outputFence == fence,
              turn == .generating || turn == .playing,
              sequence >= 0, sequence > lastSequence else { return false }
        lastSequence = sequence
        turn = .playing
        io.play(bytes)
        return true
    }

    public func playbackCompleted(fence: OutputFence) {
        guard state == .active, outputFence == fence, turn == .playing else { return }
        invalidateOutput()
        newFence()
        turn = .listening
    }

    public func end() {
        io.stopCapture()
        invalidateOutput()
        if let admission { provider.release(admission) }
        admission = nil
        state = .ended
        turn = .idle
        muted = false
    }
}
