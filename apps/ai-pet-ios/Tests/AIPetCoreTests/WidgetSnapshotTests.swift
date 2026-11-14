import Foundation
import AIPetCore

@MainActor struct WidgetSnapshotTests {
    func signoutClearsStorageAndRejectsInFlightPublish() throws {
        let r = Rig()
        let storage = MemoryWidgetStorage()
        let widget = WidgetSnapshotStore(storage: storage)
        let session = PetSession(voice: r.voice, widget: widget)
        session.select(r.context)
        try r.start()
        let token = widget.scopeToken
        let snapshot = WidgetSnapshot(personaID: r.context.personaID, appearanceID: "dev-shape",
                                      conversationID: r.context.conversationID, locale: .english, updatedAt: r.now)
        try expect(widget.publish(snapshot, scopeToken: token))
        session.signOut()
        try expect(storage.snapshot == nil && widget.snapshot == nil)
        try expect(!r.io.capture && r.voice.state == .ended)
        try expect(!widget.publish(snapshot, scopeToken: token))
        session.select(r.context)
        try expect(!widget.publish(snapshot, scopeToken: token))
        try expect(widget.publish(snapshot, scopeToken: widget.scopeToken))
    }

    func transitionAndColdLaunchClearPriorSnapshot() throws {
        let r = Rig(); let storage = MemoryWidgetStorage()
        let widget = WidgetSnapshotStore(storage: storage)
        widget.select(r.context)
        let snapshot = WidgetSnapshot(personaID: "dev-persona", appearanceID: "dev-shape",
                                      conversationID: "dev-conversation", locale: .japanese, updatedAt: r.now)
        try expect(widget.publish(snapshot, scopeToken: widget.scopeToken))
        let newProcess = WidgetSnapshotStore(storage: storage)
        try expect(newProcess.snapshot == nil && storage.snapshot == nil)
        widget.select(ConversationContext(accountID: "other", homeRegion: "dev-region", personaID: "other", conversationID: "other"))
        try expect(!widget.publish(snapshot, scopeToken: widget.scopeToken))
    }

    func snapshotHasOnlyAllowlistedFieldsAndSixLocales() throws {
        let snapshot = WidgetSnapshot(personaID: "dev-persona", appearanceID: "dev-shape", conversationID: "dev-conversation", locale: .english, updatedAt: Date())
        let encoded = try JSONEncoder().encode(snapshot)
        let fields = try require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        try expect(Set(fields.keys) == ["schemaVersion", "personaID", "appearanceID", "conversationID", "locale", "updatedAt"])
        try expect(try JSONDecoder().decode(WidgetSnapshot.self, from: encoded) == snapshot)
        try expect(Set(PetLocale.allCases.map(\.rawValue)) == ["zh-CN", "en-US", "es-ES", "ko-KR", "ja-JP", "fr-FR"])
    }
}
