import Foundation

/// Deliberately no message, account ID, token, URL, raw audio, or arbitrary display text.
/// Resolve opaque conversation IDs only after validating the current signed-in scope.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let personaID: String
    public let appearanceID: String
    public let conversationID: String
    public let locale: PetLocale
    public let updatedAt: Date

    public init(personaID: String, appearanceID: String, conversationID: String,
                locale: PetLocale, updatedAt: Date) {
        self.schemaVersion = 1
        self.personaID = personaID
        self.appearanceID = appearanceID
        self.conversationID = conversationID
        self.locale = locale
        self.updatedAt = updatedAt
    }
}

/// App Group users must request WidgetCenter reload after successful changes.
@MainActor public protocol WidgetSnapshotStorage: AnyObject {
    func replace(with snapshot: WidgetSnapshot?) throws
    var snapshot: WidgetSnapshot? { get throws }
}
@MainActor public final class MemoryWidgetStorage: WidgetSnapshotStorage {
    public private(set) var snapshot: WidgetSnapshot?
    public init() {}
    public func replace(with snapshot: WidgetSnapshot?) { self.snapshot = snapshot }
}

@MainActor public final class WidgetSnapshotStore {
    private let storage: any WidgetSnapshotStorage
    private var context: ConversationContext?
    public private(set) var lastStorageError: Error?
    private var storageReady = false
    public private(set) var scopeToken = UUID()

    public init(storage: any WidgetSnapshotStorage) {
        self.storage = storage
        // Never expose a prior process/account snapshot before authorization is known.
        clearStorage()
    }

    public func select(_ context: ConversationContext?) {
        guard self.context != context || !storageReady else { return }
        self.context = context
        scopeToken = UUID()
        clearStorage()
    }

    @discardableResult
    public func publish(_ snapshot: WidgetSnapshot, scopeToken: UUID) -> Bool {
        guard storageReady, self.scopeToken == scopeToken, let context,
              snapshot.personaID == context.personaID,
              snapshot.conversationID == context.conversationID else { return false }
        do {
            try storage.replace(with: snapshot)
            lastStorageError = nil
            return true
        } catch {
            lastStorageError = error
            storageReady = false
            return false
        }
    }

    public var snapshot: WidgetSnapshot? {
        guard context != nil, storageReady else { return nil }
        do { return try storage.snapshot }
        catch { lastStorageError = error; storageReady = false; return nil }
    }

    private func clearStorage() {
        storageReady = false
        do {
            try storage.replace(with: nil)
            storageReady = true
            lastStorageError = nil
        } catch { lastStorageError = error }
    }

    /// Must be called for sign-out even when the account is already absent.
    public func signOut() {
        context = nil
        scopeToken = UUID()
        clearStorage()
    }
}

/// One account/persona transition entry point clears both native voice and widget scope.
@MainActor public final class PetSession {
    public let voice: VoiceSession
    public let widget: WidgetSnapshotStore
    public init(voice: VoiceSession, widget: WidgetSnapshotStore) {
        self.voice = voice
        self.widget = widget
    }
    public func select(_ context: ConversationContext?) {
        voice.select(context)
        widget.select(context)
    }
    public func signOut() {
        voice.select(nil)
        widget.signOut()
    }
}
