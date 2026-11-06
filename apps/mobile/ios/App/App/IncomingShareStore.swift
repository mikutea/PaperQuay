import Foundation
import CryptoKit
import CoreFoundation
import Darwin

enum IncomingShareFailure: String, Error, Hashable {
    case full = "FULL", unsupported = "UNSUPPORTED", tooLarge = "TOO_LARGE"
    case invalid = "INVALID", readFailed = "READ_FAILED", unavailable = "STORAGE_UNAVAILABLE"
}

/// An unassigned device inbox. It contains no account, token, endpoint or model setting.
/// Both targets coordinate every snapshot access using the same private POSIX lock.
final class IncomingShareStore {
    static let group = "group.dev.paperquay.mobile.incoming"
    static let changed = Notification.Name("PaperQuayIncomingShareChanged")
    static let maxText = 64 * 1024, maxFile = 4 * 1024 * 1024, maxTotal = 8 * 1024 * 1024
    private static let maxDisk = 17 * 1024 * 1024
    private static let fields: Set<String> = ["version", "id", "name", "kind", "mediaType", "sizeBytes", "createdAt", "text"]
    static let media: [String: String] = ["json": "application/json", "md": "text/markdown", "markdown": "text/markdown",
        "bib": "application/x-bibtex", "bibtex": "application/x-bibtex", "ris": "application/x-research-info-systems"]
    private struct Snapshot {
        var items: [[String: Any]] = []
        var owners: [String: String] = [:]
    }
    static func validOwner(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    private static func root() throws -> URL {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw IncomingShareFailure.unavailable
        }
        let root = container.appendingPathComponent("PaperQuayIncoming", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let values = try root.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw IncomingShareFailure.unavailable }
        return root
    }

    private static func locked<T>(_ operation: (URL) throws -> T) throws -> T {
        let folder = try root(), lock = folder.appendingPathComponent("inbox.lock")
        let descriptor = open(lock.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, mode_t(0o600))
        guard descriptor >= 0 else { throw IncomingShareFailure.unavailable }
        defer { close(descriptor) }
        let deadline = Date().addingTimeInterval(1)
        while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            guard Date() < deadline else { throw IncomingShareFailure.unavailable }
            Thread.sleep(forTimeInterval: 0.01)
        }
        defer { flock(descriptor, LOCK_UN) }
        return try operation(folder)
    }

    private static func json(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let result = number.doubleValue
        return result.isFinite && result.rounded() == result && abs(result) <= 9_007_199_254_740_991 ? Int(result) : nil
    }
    static func validID(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
    }
    private static func validText(_ value: String) -> Bool {
        !value.unicodeScalars.contains { scalar in
            (scalar.value < 32 && ![9, 10, 13].contains(scalar.value)) || (127...159).contains(scalar.value)
        }
    }
    private static func validName(_ value: String) -> Bool {
        let whitespace = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))
        return !value.isEmpty && value.utf16.count <= 128 && value != "." && value != ".."
            && value.trimmingCharacters(in: whitespace) == value && !value.contains("/") && !value.contains("\\") && !value.contains(":")
            && !value.unicodeScalars.contains(where: { $0.value < 32 || (127...159).contains($0.value) })
    }
    static func validateText(_ text: String, kind: String) throws {
        let bytes = text.utf8.count
        guard bytes > 0, validText(text) else { throw IncomingShareFailure.invalid }
        guard bytes <= (kind == "text" ? maxText : maxFile) else { throw IncomingShareFailure.tooLarge }
    }
    static func fileName(_ proposed: String) throws -> String {
        let name = proposed
        guard let mime = media[URL(fileURLWithPath: name).pathExtension.lowercased()], !mime.isEmpty,
              validName(name) else {
            throw IncomingShareFailure.unsupported
        }
        return name
    }
    private static func checked(_ entry: [String: Any]) throws -> [String: Any] {
        guard Set(entry.keys) == fields, integer(entry["version"]) == 1,
              let id = entry["id"] as? String, validID(id),
              let name = entry["name"] as? String, validName(name),
              let kind = entry["kind"] as? String, ["text", "file"].contains(kind),
              let mime = entry["mediaType"] as? String,
              let text = entry["text"] as? String,
              let count = integer(entry["sizeBytes"]), count == text.utf8.count,
              let time = integer(entry["createdAt"]), time >= 1, time <= 8_640_000_000_000_000 else { throw IncomingShareFailure.invalid }
        try validateText(text, kind: kind)
        if kind == "text" {
            guard mime == "text/plain" else { throw IncomingShareFailure.invalid }
        } else {
            guard try fileName(name) == name, media[URL(fileURLWithPath: name).pathExtension.lowercased()] == mime else {
                throw IncomingShareFailure.invalid
            }
        }
        return entry
    }
    private static func boundedRead(_ url: URL, limit: Int) throws -> Data {
        let fd = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw IncomingShareFailure.readFailed }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var information = stat()
        guard fstat(fd, &information) == 0, (information.st_mode & S_IFMT) == S_IFREG else { throw IncomingShareFailure.readFailed }
        guard information.st_size >= 0, information.st_size <= limit else { throw IncomingShareFailure.tooLarge }
        let data = try handle.read(upToCount: limit + 1) ?? Data()
        guard data.count <= limit else { throw IncomingShareFailure.tooLarge }
        return data
    }
    static func fileText(_ url: URL, displayName: String? = nil) throws -> (name: String, text: String) {
        guard url.isFileURL else { throw IncomingShareFailure.unsupported }
        let name = try fileName(displayName ?? url.lastPathComponent), data = try boundedRead(url, limit: maxFile)
        guard let text = String(data: data, encoding: .utf8) else { throw IncomingShareFailure.invalid }
        try validateText(text, kind: "file")
        return (name, text)
    }
    private static func read(_ folder: URL) throws -> Snapshot {
        let file = folder.appendingPathComponent("inbox.json")
        if !FileManager.default.fileExists(atPath: file.path) { return Snapshot() }
        let data = try boundedRead(file, limit: maxDisk)
        guard let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              Set(envelope.keys) == ["version", "items", "owners", "sha256"], integer(envelope["version"]) == 1,
              let entries = envelope["items"] as? [[String: Any]], entries.count <= 4,
              let owners = envelope["owners"] as? [String: String], owners.count <= 4,
              let digest = envelope["sha256"] as? String,
              hash(try json(["items": entries, "owners": owners])) == digest else { throw IncomingShareFailure.invalid }
        var seen = Set<String>(), total = 0
        for item in entries {
            _ = try checked(item)
            guard seen.insert(item["id"] as! String).inserted else { throw IncomingShareFailure.invalid }
            total += item["sizeBytes"] as! Int
        }
        guard total <= maxTotal, owners.allSatisfy({ seen.contains($0.key) && validOwner($0.value) }) else { throw IncomingShareFailure.invalid }
        return Snapshot(items: entries, owners: owners)
    }
    private static func write(_ snapshot: Snapshot, to folder: URL) throws {
        let body: [String: Any] = ["items": snapshot.items, "owners": snapshot.owners]
        let data = try json(["version": 1, "items": snapshot.items, "owners": snapshot.owners, "sha256": hash(try json(body))])
        guard data.count <= maxDisk else { throw IncomingShareFailure.full }
        try data.write(to: folder.appendingPathComponent("inbox.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func enqueue(name: String, kind: String, text: String) throws {
        let name = try (kind == "text" ? "分享的文字或链接" : fileName(name))
        let entry: [String: Any] = ["version": 1, "id": UUID().uuidString.lowercased(), "name": name,
            "kind": kind, "mediaType": kind == "text" ? "text/plain" : media[URL(fileURLWithPath: name).pathExtension.lowercased()]!,
            "text": text, "sizeBytes": text.utf8.count, "createdAt": Int(Date().timeIntervalSince1970 * 1000)]
        _ = try checked(entry)
        try locked { folder in
            var previous = try read(folder)
            if previous.items.contains(where: { previous.owners[$0["id"] as! String] == nil && $0["name"] as? String == name && $0["kind"] as? String == kind
                && $0["mediaType"] as? String == entry["mediaType"] as? String && $0["text"] as? String == text }) { return }
            guard previous.items.count < 4, previous.items.reduce(0, { $0 + ($1["sizeBytes"] as! Int) }) + text.utf8.count <= maxTotal else {
                throw IncomingShareFailure.full
            }
            previous.items.append(entry)
            try write(previous, to: folder)
        }
        DispatchQueue.main.async { NotificationCenter.default.post(name: changed, object: nil) }
    }
    static func notice(_ failure: IncomingShareFailure) {
        try? locked { folder in try Data(failure.rawValue.utf8).write(to: folder.appendingPathComponent("notice"), options: .atomic) }
        DispatchQueue.main.async { NotificationCenter.default.post(name: changed, object: nil) }
    }
    static func list(owner: String) -> [String: Any] {
        guard validOwner(owner) else { return ["items": [], "notice": IncomingShareFailure.invalid.rawValue] }
        do {
            return try locked { folder in
                let noticeURL = folder.appendingPathComponent("notice")
                let stored = (try? boundedRead(noticeURL, limit: 64)).flatMap { String(data: $0, encoding: .utf8) }
                let notice = stored.flatMap(IncomingShareFailure.init(rawValue:))?.rawValue
                try? FileManager.default.removeItem(at: noticeURL)
                do {
                    let snapshot = try read(folder)
                    let metadata = snapshot.items.filter { snapshot.owners[$0["id"] as! String].map { $0 == owner } ?? true }
                        .map { item -> [String: Any] in var copy = item; copy.removeValue(forKey: "text"); return copy }
                    return ["items": metadata, "notice": notice as Any? ?? NSNull()]
                } catch { return ["items": [], "notice": IncomingShareFailure.invalid.rawValue] }
            }
        } catch { return ["items": [], "notice": IncomingShareFailure.unavailable.rawValue] }
    }
    static func item(_ id: String, owner: String) throws -> [String: Any] {
        guard validID(id), validOwner(owner) else { throw IncomingShareFailure.invalid }
        return try locked { folder in
            var snapshot = try read(folder)
            guard snapshot.owners[id].map({ $0 == owner }) ?? true,
                  let item = snapshot.items.first(where: { $0["id"] as? String == id }) else { throw IncomingShareFailure.readFailed }
            if snapshot.owners[id] == nil {
                snapshot.owners[id] = owner
                // Claim must be durable before any private text is returned to JS.
                try write(snapshot, to: folder)
            }
            return item
        }
    }
    static func remove(_ id: String, owner: String) throws {
        guard validID(id), validOwner(owner) else { throw IncomingShareFailure.invalid }
        try locked { folder in
            var snapshot = try read(folder)
            guard snapshot.owners[id].map({ $0 == owner }) ?? true,
                  snapshot.items.contains(where: { $0["id"] as? String == id }) else { throw IncomingShareFailure.readFailed }
            snapshot.items.removeAll { $0["id"] as? String == id }
            snapshot.owners.removeValue(forKey: id)
            try write(snapshot, to: folder)
        }
        DispatchQueue.main.async { NotificationCenter.default.post(name: changed, object: nil) }
    }
    static func clear(owner: String) throws {
        guard validOwner(owner) else { throw IncomingShareFailure.invalid }
        try locked { folder in
            do {
                var snapshot = try read(folder)
                snapshot.items.removeAll { snapshot.owners[$0["id"] as! String].map { $0 == owner } ?? true }
                let retained = Set(snapshot.items.map { $0["id"] as! String })
                snapshot.owners = snapshot.owners.filter { retained.contains($0.key) }
                try write(snapshot, to: folder)
            } catch let failure as IncomingShareFailure where failure == .invalid || failure == .tooLarge {
                // An explicit corrupt-inbox rebuild keeps its exact old bytes for recovery.
                let backup = folder.appendingPathComponent("inbox.corrupt.json")
                guard !FileManager.default.fileExists(atPath: backup.path) else { throw IncomingShareFailure.unavailable }
                try FileManager.default.moveItem(at: folder.appendingPathComponent("inbox.json"), to: backup)
                try write(Snapshot(), to: folder)
            }
            try? FileManager.default.removeItem(at: folder.appendingPathComponent("notice"))
        }
        DispatchQueue.main.async { NotificationCenter.default.post(name: changed, object: nil) }
    }
}
