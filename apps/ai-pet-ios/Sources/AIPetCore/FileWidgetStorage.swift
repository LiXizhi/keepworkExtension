import Foundation

public enum SnapshotStorageError: Error, Equatable {
    case unsafeFile, oversized, invalidSnapshot
}

/// Single app-process writer; widgets are read-only. The caller supplies a dedicated
/// app-owned directory (or an OS-resolved App Group container), never a URL from a link.
/// Atomic replacement prevents readers from observing partial JSON. No account IDs
/// or tokens are encoded, and identifiers never form filesystem paths.
@MainActor public final class FileWidgetStorage: WidgetSnapshotStorage {
    public let fileURL: URL
    nonisolated public static let maximumBytes = 16_384
    private let fileManager: FileManager

    public init(directory: URL, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        guard directory.isFileURL else { throw SnapshotStorageError.unsafeFile }
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
        let values = try directory.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw SnapshotStorageError.unsafeFile
        }
        fileURL = directory.appendingPathComponent("widget-snapshot.json")
    }

    private func inspectFile() throws -> Bool {
        do {
            // URL resource values may be cached across replacement/removal. Stat each
            // operation through FileManager so a reader observes the current inode.
            let attributes = try fileManager.attributesOfItem(atPath: fileURL.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else {
                throw SnapshotStorageError.unsafeFile
            }
            return true
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return false
        }
    }

    public var snapshot: WidgetSnapshot? {
        get throws { try Self.readSnapshot(at: fileURL) }
    }

    /// Read-only widget entry point: does not create directories or clear app state.
    nonisolated public static func readSnapshot(at fileURL: URL) throws -> WidgetSnapshot? {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else {
                throw SnapshotStorageError.unsafeFile
            }
            let handle = try FileHandle(forReadingFrom: fileURL)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
            guard data.count <= maximumBytes else { throw SnapshotStorageError.oversized }
            let result = try JSONDecoder().decode(WidgetSnapshot.self, from: data)
            try validate(result)
            return result
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return nil
        }
    }

    public func replace(with snapshot: WidgetSnapshot?) throws {
        let exists = try inspectFile()
        guard let snapshot else {
            if exists { try fileManager.removeItem(at: fileURL) }
            return
        }
        try Self.validate(snapshot)
        let data = try JSONEncoder().encode(snapshot)
        guard data.count <= Self.maximumBytes else { throw SnapshotStorageError.oversized }
        try data.write(to: fileURL, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    nonisolated private static func validate(_ snapshot: WidgetSnapshot) throws {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let ids = [snapshot.personaID, snapshot.appearanceID, snapshot.conversationID]
        guard snapshot.schemaVersion == 1, snapshot.updatedAt.timeIntervalSince1970.isFinite,
              ids.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 128 &&
                  $0.unicodeScalars.allSatisfy { allowed.contains($0) } }) else {
            throw SnapshotStorageError.invalidSnapshot
        }
    }
}

/// Deep links contain no conversation/account identity. The host resolves the current
/// authorized snapshot after opening; a link can never start voice or select an account.
public enum WidgetLink {
    public static let preview = URL(string: "aipet-development://preview")!
    public static func accepts(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return components.scheme == "aipet-development" && components.host == "preview" &&
            components.user == nil && components.password == nil && components.port == nil &&
            components.path.isEmpty && components.query == nil && components.fragment == nil
    }
}
