import Foundation

@MainActor final class QAIO: NativeVoiceIO {
    var capture = false
    var playback = false
    func startCapture() throws { capture = true }
    func stopCapture() { capture = false }
    func stopAndFlushPlayback() { playback = false }
    func play(_ bytes: Data) { playback = true }
}
@MainActor final class QAProvider: VoiceProvider {
    var releases = 0
    func cancelOutput(_ fence: OutputFence) {}
    func release(_ admission: VoiceAdmission) { releases += 1 }
}
@main struct QAConformance {
    @MainActor static func main() throws {
        let a = ConversationContext(accountID: "qa-a", homeRegion: "qa-region", personaID: "qa-pet", conversationID: "qa-chat")
        let b = ConversationContext(accountID: "qa-b", homeRegion: "qa-region", personaID: "qa-pet", conversationID: "qa-chat")
        let now = Date(timeIntervalSince1970: 100)
        let io = QAIO(), provider = QAProvider()
        let voice = VoiceSession(io: io, provider: provider)
        let storage = MemoryWidgetStorage(), widget: WidgetSnapshotStore
        widget = WidgetSnapshotStore(storage: storage)
        let owner = PetSession(voice: voice, widget: widget)
        owner.select(a)
        let lease = VoiceAdmission(context: a, sessionID: "qa-session", fencingGeneration: 1,
            expiresAt: now.addingTimeInterval(60), microphoneAllowed: true, entitlementAllowed: true,
            audioSessionAvailable: true, transportReady: true, nativeStartEligible: true)
        try voice.startByUser(lease, now: now)
        voice.visibilityChanged(isVisible: false)
        precondition(io.capture && voice.state == .active)
        let old = voice.outputFence!
        voice.userTurnCompleted(fence: old)
        precondition(voice.receiveAudio(Data([0]), fence: old, sequence: 0, now: now))
        voice.spokenInterruption(fence: old)
        precondition(!io.playback && io.capture)
        precondition(!voice.receiveAudio(Data([0]), fence: old, sequence: 1, now: now))
        voice.pause(.networkLoss)
        voice.interruptionEnded()
        precondition(!io.capture && !io.playback)
        try voice.resumeByUser(lease, now: now)
        precondition(io.capture)
        voice.leaseRevoked(sessionID: "old-session", fencingGeneration: 1)
        precondition(io.capture && voice.state == .active)
        voice.leaseRevoked(sessionID: "qa-session", fencingGeneration: 0)
        precondition(io.capture && voice.state == .active)
        let snapshot = WidgetSnapshot(personaID: a.personaID, appearanceID: "qa-art",
            conversationID: a.conversationID, locale: .english, updatedAt: now)
        let token = widget.scopeToken
        precondition(widget.publish(snapshot, scopeToken: token))
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as! [String: Any]
        precondition(Set(object.keys) == ["schemaVersion", "personaID", "appearanceID", "conversationID", "locale", "updatedAt"])
        owner.signOut()
        precondition(storage.snapshot == nil && !io.capture && !io.playback && provider.releases == 1)
        owner.select(b)
        precondition(!widget.publish(snapshot, scopeToken: token) && widget.snapshot == nil)
        owner.signOut()
        owner.select(a)
        precondition(!widget.publish(snapshot, scopeToken: token))
        try durableSnapshotChecks(context: a, snapshot: snapshot)
        print("PASS independent Swift voice/visibility/interruption and widget account-isolation conformance")
    }
}

@MainActor private func durableSnapshotChecks(context: ConversationContext, snapshot: WidgetSnapshot) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ai-pet-qa-snapshot-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let disk = try FileWidgetStorage(directory: directory)
    let store = WidgetSnapshotStore(storage: disk)
    store.select(context)
    let oldToken = store.scopeToken
    precondition(store.publish(snapshot, scopeToken: oldToken))
    let reopened = try FileWidgetStorage(directory: directory)
    let saved = try reopened.snapshot
    precondition(saved == snapshot)
    let data = try Data(contentsOf: disk.fileURL)
    let fields = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    precondition(Set(fields.keys) == ["schemaVersion", "personaID", "appearanceID", "conversationID", "locale", "updatedAt"])
    store.signOut()
    precondition(!FileManager.default.fileExists(atPath: disk.fileURL.path))
    let removed = try reopened.snapshot
    precondition(removed == nil)
    store.select(context)
    precondition(!store.publish(snapshot, scopeToken: oldToken))
    try Data("{truncated".utf8).write(to: disk.fileURL)
    do { _ = try reopened.snapshot; preconditionFailure("Corrupt file accepted") } catch {}
    var unsupported = fields
    unsupported["schemaVersion"] = 999
    try JSONSerialization.data(withJSONObject: unsupported).write(to: disk.fileURL)
    do { _ = try reopened.snapshot; preconditionFailure("Unknown schema accepted") } catch {}
    try disk.replace(with: nil)
    try disk.replace(with: snapshot)
    let coldStore = WidgetSnapshotStore(storage: try FileWidgetStorage(directory: directory))
    precondition(coldStore.snapshot == nil && !FileManager.default.fileExists(atPath: disk.fileURL.path))
    precondition(WidgetLink.accepts(WidgetLink.preview))
    for link in ["aipet-development://preview?account=qa-a", "aipet-development://preview#qa-chat", "aipet-development://start-voice", "aipet-development://preview/qa-chat"] {
        precondition(!WidgetLink.accepts(URL(string: link)!))
    }
    print("PASS independent durable snapshot reopen/delete/corruption and identity-free links")
}
