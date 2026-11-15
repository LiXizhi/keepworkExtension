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

import SwiftUI

/// Original geometric study drawn from primitives; no character catalog or audio input.
/// No timeline, timer, repeating animation, or lifecycle-owned work.
struct DeveloperPetView: View {
    let pose: DemoPose
    let mouth: Double
    let locale: PetLocale
    private var color: Color { pose == .error ? .orange : .teal }
    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width, proxy.size.height)
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.32)
                    .fill(color.gradient)
                    .frame(width: size * 0.8, height: size * 0.78)
                    .rotationEffect(.degrees(pose == .thinking ? -8 : pose == .happy ? 5 : 0))
                HStack(spacing: size * 0.19) {
                    eye(size: size)
                    eye(size: size)
                }.offset(y: -size * 0.08)
                Capsule().fill(.black.opacity(0.8))
                    .frame(width: size * (pose == .happy ? 0.28 : 0.15), height: size * (pose == .speaking ? 0.04 + mouth * 0.18 : 0.035))
                    .offset(y: size * 0.15)
                if pose == .listening {
                    Circle().stroke(color, lineWidth: 3).frame(width: size * 0.96, height: size * 0.96)
                }
                if pose == .thinking || pose == .error || pose == .sleeping {
                    Text(pose == .thinking ? "···" : pose == .error ? "!" : "z")
                        .font(.system(size: size * 0.19, weight: .bold, design: .rounded))
                        .foregroundStyle(.primary)
                        .offset(x: size * 0.36, y: -size * 0.34)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(DevelopmentCopy.text(.pet, locale) + ", " + DevelopmentCopy.text(pose.labelKey, locale))
    }
    private func eye(size: CGFloat) -> some View {
        Capsule().fill(.black.opacity(0.8))
            .frame(width: size * 0.07, height: size * (pose == .sleeping || pose == .happy ? 0.025 : 0.1))
    }
}
