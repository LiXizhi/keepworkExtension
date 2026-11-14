import Foundation
import AIPetCore

/// Empty by default. A developer must configure the SAME real development App Group
/// entitlement on both targets; no production identifier or entitlement is invented.
enum DevelopmentWidgetBridge {
    static let kind = "AIPetDevelopmentWidget"
    static func directory() -> URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "AIPetDevelopmentAppGroup") as? String,
              group.hasPrefix("group."), !group.contains("$("),
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return container.appendingPathComponent("AIPetDevelopmentSnapshots", isDirectory: true)
    }
    static func readPreview() -> WidgetSnapshot? {
        guard let directory = directory() else { return nil }
        // Widget remains generic/synthetic. Corrupt, absent or stale content is unavailable.
        guard let snapshot = try? FileWidgetStorage.readSnapshot(at: directory.appendingPathComponent("widget-snapshot.json")),
              snapshot.personaID == "dev-persona", snapshot.appearanceID == "dev-shape",
              snapshot.conversationID == "dev-conversation",
              Date().timeIntervalSince(snapshot.updatedAt) >= 0,
              Date().timeIntervalSince(snapshot.updatedAt) < 900 else { return nil }
        return snapshot
    }
}
