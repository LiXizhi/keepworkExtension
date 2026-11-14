import Foundation

public enum Development {
    public static let version = "0.1.0-dev.3"
    public static let contract = "ios-offline-policy-v1"
    public static let isOffline = true
}

/// Language never assigns or changes an account's home service region.
public enum PetLocale: String, CaseIterable, Codable, Sendable {
    case simplifiedChinese = "zh-CN"
    case english = "en-US"
    case spanish = "es-ES"
    case korean = "ko-KR"
    case japanese = "ja-JP"
    case french = "fr-FR"
}

public struct ConversationContext: Equatable, Sendable {
    public let accountID: String
    public let homeRegion: String
    public let personaID: String
    public let conversationID: String

    public init(accountID: String, homeRegion: String, personaID: String, conversationID: String) {
        self.accountID = accountID
        self.homeRegion = homeRegion
        self.personaID = personaID
        self.conversationID = conversationID
    }
}
