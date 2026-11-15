import Foundation
import AIPetCore

@MainActor struct PresentationTests {
    func resourceCoverage() throws {
        try expect(DevelopmentCopy.catalog.count == 6)
        for locale in PetLocale.allCases {
            let copy = try require(DevelopmentCopy.catalog[locale.rawValue])
            for key in CopyKey.allCases { try expect(!(copy[key.rawValue] ?? "").isEmpty) }
        }
        try expect(Set(PetLocale.allCases.map { DevelopmentCopy.text(.offline, $0) }).count == 6)
    }
    func preferenceAndWidgetIsolation() throws {
        let suite = "AIPetTests.\(UUID().uuidString)"
        let defaults = try require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(PetLocale.french.rawValue, forKey: LanguagePreference.key)
        let reopened = try require(UserDefaults(suiteName: suite))
        try expect(LanguagePreference.resolve(reopened.string(forKey: LanguagePreference.key), system: ["ja-JP"]) == .french)
        try expect(LanguagePreference.resolve("invalid", system: ["xx", "ko_KR"]) == .korean)
        try expect(PetLocale.system(["xx"]) == .english)
        let now = Date()
        try expect(WidgetLanguage.resolve(authorizedSnapshot: nil, system: ["ja-JP"], now: now) == .japanese)
        for age in [0.0, 899.0, 900.0, -1.0] {
            let snapshot = WidgetSnapshot(personaID: "dev-persona", appearanceID: "dev-shape", conversationID: "dev-conversation", locale: .french, updatedAt: now.addingTimeInterval(-age))
            try expect(WidgetLanguage.resolve(authorizedSnapshot: snapshot, system: ["ja-JP"], now: now) == ((0..<900).contains(age) ? .french : .japanese))
        }
    }
    func presentationPolicy() throws {
        try expect(DemoPose.allCases.count == 7)
        try expect(DemoPresentation.mouthOpening(0.7, pose: .speaking, sceneActive: true, reduceMotion: true) == 0)
        try expect(DemoPresentation.mouthOpening(0.7, pose: .speaking, sceneActive: true, visible: false) == 0)
        for reduced in [true, false] { for active in [true, false] { for visible in [true, false] {
            try expect(DemoPresentation.allowsMotion(reduceMotion: reduced, sceneActive: active, visible: visible) == (!reduced && active && visible))
        } } }
        for pose in DemoPose.allCases {
            try expect(DemoPresentation.mouthOpening(0.7, pose: pose, sceneActive: true) == (pose == .speaking ? 0.7 : 0))
            try expect(DemoPresentation.mouthOpening(0.7, pose: pose, sceneActive: false) == 0)
        }
        try expect(DemoPresentation.mouthOpening(.nan, pose: .speaking, sceneActive: true) == 0)
        try expect(DemoPresentation.mouthOpening(2, pose: .speaking, sceneActive: true) == 1)
        try expect(DemoPresentation.mouthOpening(-2, pose: .speaking, sceneActive: true) == 0)
    }
}
