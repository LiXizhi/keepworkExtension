import Foundation

public enum CopyKey: String, CaseIterable, Sendable {
    case title, offline, offlineDetail, language, languageNote, pet, petNote, pose, mouth, motionPaused
    case widget, sharingUnavailable, sharingReady, cleanupFailed, storageUnavailable, saved, writeFailed
    case cleared, removalFailed, publish, clear, unsupported, previewMissing, previewOpened
    case voice, voiceDetail, widgetReady, widgetUnavailable, widgetOpen, widgetDescription
    case idle, happy, listening, thinking, speaking, sleeping, error
}

/// Resource-backed development copy shared by the app and extension. No network fallback.
public enum DevelopmentCopy {
    public static let catalog: [String: [String: String]] = {
        #if SWIFT_PACKAGE
        let resourceBundle = Bundle.module
        #else
        let resourceBundle = Bundle.main
        #endif
        guard let url = resourceBundle.url(forResource: "development-copy", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let values = try? JSONDecoder().decode([String: [String: String]].self, from: data) else { return [:] }
        return values
    }()
    public static func text(_ key: CopyKey, _ locale: PetLocale) -> String {
        catalog[locale.rawValue]?[key.rawValue] ?? catalog[PetLocale.english.rawValue]?[key.rawValue] ?? key.rawValue
    }
}

public extension PetLocale {
    var nativeName: String {
        switch self {
        case .simplifiedChinese: "简体中文"
        case .english: "English"
        case .spanish: "Español"
        case .korean: "한국어"
        case .japanese: "日本語"
        case .french: "Français"
        }
    }
    static func system(_ preferredLanguages: [String]) -> PetLocale {
        for id in preferredLanguages {
            switch id.lowercased().replacingOccurrences(of: "_", with: "-").split(separator: "-").first {
            case "zh": return .simplifiedChinese
            case "en": return .english
            case "es": return .spanish
            case "ko": return .korean
            case "ja": return .japanese
            case "fr": return .french
            default: continue
            }
        }
        return .english
    }
}

/// This preference has no account/region APIs and is not an App Group value.
public enum LanguagePreference {
    public static let key = "ai-pet.development.locale.v1"
    public static func resolve(_ stored: String?, system: [String]) -> PetLocale {
        stored.flatMap(PetLocale.init(rawValue:)) ?? PetLocale.system(system)
    }
}

public enum DemoPose: String, CaseIterable, Sendable {
    case idle, happy, listening, thinking, speaking, sleeping, error
    public var labelKey: CopyKey { CopyKey(rawValue: rawValue)! }
}
public enum DemoPresentation {
    public static func allowsMotion(reduceMotion: Bool, sceneActive: Bool, visible: Bool) -> Bool {
        !reduceMotion && sceneActive && visible
    }
    public static func mouthOpening(_ level: Double, pose: DemoPose, sceneActive: Bool, reduceMotion: Bool = false, visible: Bool = true) -> Double {
        guard pose == .speaking, allowsMotion(reduceMotion: reduceMotion, sceneActive: sceneActive, visible: visible), level.isFinite else { return 0 }
        return min(1, max(0, level))
    }
}

/// The caller supplies only a snapshot already validated for its current authorization scope.
/// Widget system language is deliberately independent of the app's persisted preference.
public enum WidgetLanguage {
    public static func resolve(authorizedSnapshot: WidgetSnapshot?, system: [String], now: Date) -> PetLocale {
        if let snapshot = authorizedSnapshot, snapshot.schemaVersion == 1,
           (0..<900).contains(now.timeIntervalSince(snapshot.updatedAt)) { return snapshot.locale }
        return PetLocale.system(system)
    }
}
