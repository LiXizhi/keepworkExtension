import Foundation
import AIPetCore

@MainActor struct FileWidgetStorageTests {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ai-pet-widget-tests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }
    private func sample(_ id: String = "dev-conversation") -> WidgetSnapshot {
        WidgetSnapshot(personaID: "dev-persona", appearanceID: "dev-shape", conversationID: id,
                       locale: .english, updatedAt: Date(timeIntervalSince1970: 1000))
    }

    func durableAtomicReplacementAndRemoval() throws {
        try withDirectory { directory in
            let writer = try FileWidgetStorage(directory: directory)
            let reader = try FileWidgetStorage(directory: directory)
            try expect(try reader.snapshot == nil)
            for index in 0..<40 {
                let value = sample("dev-conversation-\(index)")
                try writer.replace(with: value)
                try expect(try reader.snapshot == value)
            }
            let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            try expect(names == ["widget-snapshot.json"])
            let permissions = try FileManager.default.attributesOfItem(atPath: writer.fileURL.path)[.posixPermissions] as? NSNumber
            try expect(permissions?.intValue == 0o600)
            try writer.replace(with: nil)
            try writer.replace(with: nil)
            try expect(try reader.snapshot == nil)
        }
    }

    func concurrentReadersNeverObservePartialReplacement() throws {
        try withDirectory { directory in
            let storage = try FileWidgetStorage(directory: directory)
            let first = sample("dev-first"), second = sample("dev-second")
            try storage.replace(with: first)
            let url = storage.fileURL
            let observations = ReadObservations()
            let group = DispatchGroup()
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave() }
                for _ in 0..<500 {
                    do {
                        let snapshot = try FileWidgetStorage.readSnapshot(at: url)
                        if snapshot != first && snapshot != second { observations.fail("partial/missing snapshot") }
                    } catch { observations.fail(String(describing: error)) }
                }
            }
            for index in 0..<100 { try storage.replace(with: index.isMultiple(of: 2) ? second : first) }
            group.wait()
            try expect(observations.failure == nil)
        }
    }

    func diskAccountInvalidationAndColdStart() throws {
        try withDirectory { directory in
            let storage = try FileWidgetStorage(directory: directory)
            let widget = WidgetSnapshotStore(storage: storage)
            let r = Rig()
            widget.select(r.context)
            let oldToken = widget.scopeToken
            try expect(widget.publish(sample(), scopeToken: oldToken))
            let reader = try FileWidgetStorage(directory: directory)
            try expect(try reader.snapshot != nil)
            widget.signOut()
            try expect(try reader.snapshot == nil)
            try expect(!widget.publish(sample(), scopeToken: oldToken))
            widget.select(r.context)
            try expect(!widget.publish(sample(), scopeToken: oldToken))
            try expect(widget.publish(sample(), scopeToken: widget.scopeToken))
            let restarted = WidgetSnapshotStore(storage: try FileWidgetStorage(directory: directory))
            try expect(restarted.snapshot == nil)
            try expect(try reader.snapshot == nil)
        }
    }

    func corruptOversizedAndUnsupportedDataFailClosed() throws {
        try withDirectory { directory in
            let storage = try FileWidgetStorage(directory: directory)
            try Data("not JSON".utf8).write(to: storage.fileURL)
            do { _ = try storage.snapshot; throw CheckFailure(description: "corrupt file accepted") }
            catch is DecodingError {}
            try Data(repeating: 65, count: FileWidgetStorage.maximumBytes + 1).write(to: storage.fileURL)
            try expect(throws: SnapshotStorageError.oversized) { _ = try storage.snapshot }
            var object = try require(JSONSerialization.jsonObject(with: JSONEncoder().encode(sample())) as? [String: Any])
            object["schemaVersion"] = 99
            try JSONSerialization.data(withJSONObject: object).write(to: storage.fileURL)
            try expect(throws: SnapshotStorageError.invalidSnapshot) { _ = try storage.snapshot }
            try expect(throws: SnapshotStorageError.invalidSnapshot) { try storage.replace(with: sample("../../private")) }
        }
    }

    func failedDeletionIsVisibleAndBlocksPublicationUntilRetry() throws {
        try withDirectory { directory in
            let storage = try FileWidgetStorage(directory: directory)
            let widget = WidgetSnapshotStore(storage: storage)
            let r = Rig(); widget.select(r.context)
            let oldToken = widget.scopeToken
            try expect(widget.publish(sample(), scopeToken: oldToken))
            try storage.replace(with: nil)
            // Deterministic filesystem failure without depending on host user permissions.
            try FileManager.default.createDirectory(at: storage.fileURL, withIntermediateDirectories: false)
            widget.signOut()
            try expect(widget.lastStorageError != nil && widget.snapshot == nil)
            widget.select(r.context)
            try expect(!widget.publish(sample(), scopeToken: widget.scopeToken))
            try FileManager.default.removeItem(at: storage.fileURL)
            widget.select(r.context)
            try expect(widget.lastStorageError == nil)
            try expect(!widget.publish(sample(), scopeToken: oldToken))
            try expect(widget.publish(sample(), scopeToken: widget.scopeToken))
        }
    }

    func symlinkDoesNotReadWriteOrRemoveItsTarget() throws {
        try withDirectory { directory in
            let storage = try FileWidgetStorage(directory: directory)
            let target = directory.appendingPathComponent("synthetic-sensitive-file")
            let sentinel = Data("synthetic-private-value".utf8)
            try sentinel.write(to: target)
            try FileManager.default.createSymbolicLink(at: storage.fileURL, withDestinationURL: target)
            try expect(throws: SnapshotStorageError.unsafeFile) { _ = try storage.snapshot }
            try expect(throws: SnapshotStorageError.unsafeFile) { try storage.replace(with: sample()) }
            try expect(throws: SnapshotStorageError.unsafeFile) { try storage.replace(with: nil) }
            try expect(try Data(contentsOf: target) == sentinel)
        }
    }

    func linksCannotSupplyAccountOrStartVoice() throws {
        try expect(WidgetLink.accepts(WidgetLink.preview))
        for value in ["https://preview", "aipet-development://voice", "aipet-development://preview?account=other",
                      "aipet-development://preview/path", "aipet-development://user@preview", "aipet-development://preview#voice",
                      "aipet-development://preview:80"] {
            try expect(!WidgetLink.accepts(try require(URL(string: value))))
        }
    }
}

private final class ReadObservations: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    func fail(_ message: String) { lock.lock(); defer { lock.unlock() }; value = message }
    var failure: String? { lock.lock(); defer { lock.unlock() }; return value }
}
