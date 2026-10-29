import Foundation
import Capacitor
import UIKit

@objc(PaperQuayIncomingSharePlugin)
public class PaperQuayIncomingSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PaperQuayIncomingSharePlugin"
    public let jsName = "PaperQuayIncomingShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]
    private let operations = DispatchQueue(label: "dev.paperquay.incoming.bridge")
    private var observer: NSObjectProtocol?
    private var activeObserver: NSObjectProtocol?

    override public func load() {
        observer = NotificationCenter.default.addObserver(forName: IncomingShareStore.changed, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("changed", data: [:])
        }
        activeObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("changed", data: [:])
        }
    }
    deinit {
        if let observer = observer { NotificationCenter.default.removeObserver(observer) }
        if let activeObserver = activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
    }
    private func owner(_ call: CAPPluginCall, fields: Set<String>) -> String? {
        guard Set(call.options.keys) == fields, let value = call.getString("owner"), IncomingShareStore.validOwner(value) else {
            call.reject("Invalid incoming share owner.", "INVALID"); return nil
        }
        return value
    }

    private func perform(_ call: CAPPluginCall, operation: @escaping () throws -> [String: Any]) {
        operations.async {
            do {
                let result = try operation()
                DispatchQueue.main.async { call.resolve(result) }
            } catch {
                let code = (error as? IncomingShareFailure)?.rawValue ?? IncomingShareFailure.readFailed.rawValue
                // Only fixed codes cross the bridge; provider URLs and file errors stay native.
                DispatchQueue.main.async { call.reject("Incoming share operation failed.", code) }
            }
        }
    }
    @objc func list(_ call: CAPPluginCall) {
        guard let owner = owner(call, fields: ["owner"]) else { return }
        perform(call) { IncomingShareStore.list(owner: owner) }
    }
    @objc func read(_ call: CAPPluginCall) {
        guard let owner = owner(call, fields: ["id", "owner"]) else { return }
        guard let id = call.getString("id"), IncomingShareStore.validID(id) else {
            call.reject("Invalid incoming share identifier.", "INVALID"); return
        }
        perform(call) { try IncomingShareStore.item(id, owner: owner) }
    }
    @objc func remove(_ call: CAPPluginCall) {
        guard let owner = owner(call, fields: ["id", "owner"]) else { return }
        guard let id = call.getString("id"), IncomingShareStore.validID(id) else {
            call.reject("Invalid incoming share identifier.", "INVALID"); return
        }
        perform(call) { try IncomingShareStore.remove(id, owner: owner); return [:] }
    }
    @objc func clear(_ call: CAPPluginCall) {
        guard let owner = owner(call, fields: ["owner"]) else { return }
        perform(call) { try IncomingShareStore.clear(owner: owner); return [:] }
    }
}

/// The OS document callback grants access only to its selected URL. Paths never enter JS.
enum IncomingShareDocumentOpen {
    private static let lock = NSLock()
    private static var active: UUID?
    private static var expired = false
    private static let reads = DispatchQueue(label: "dev.paperquay.incoming.documents", qos: .userInitiated)
    static func accept(_ url: URL) {
        guard url.isFileURL else { return }
        let request = UUID(), deadline = Date().addingTimeInterval(30)
        lock.lock()
        guard active == nil else { lock.unlock(); IncomingShareStore.notice(.readFailed); return }
        active = request; expired = false; lock.unlock()
        // A timed-out provider keeps its one slot until it returns. Never queue
        // unlimited blocked reads, and never commit a late provider result.
        DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
            lock.lock()
            let timedOut = active == request && !expired
            if timedOut { expired = true }
            lock.unlock()
            if timedOut { IncomingShareStore.notice(.readFailed) }
        }
        reads.async {
            let scoped = url.startAccessingSecurityScopedResource()
            defer {
                if scoped { url.stopAccessingSecurityScopedResource() }
                lock.lock(); if active == request { active = nil }; lock.unlock()
            }
            let inbox = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
                .appendingPathComponent("Inbox", isDirectory: true).resolvingSymlinksInPath()
            let resolved = url.resolvingSymlinksInPath()
            guard scoped || inbox.map({ resolved.path.hasPrefix($0.path + "/") }) == true else {
                IncomingShareStore.notice(.unsupported); return
            }
            do {
                let source = try IncomingShareStore.fileText(url)
                lock.lock(); defer { lock.unlock() }
                guard active == request, !expired, Date() < deadline else { return }
                try IncomingShareStore.enqueue(name: source.name, kind: "file", text: source.text)
            } catch { IncomingShareStore.notice(error as? IncomingShareFailure ?? .readFailed) }
        }
    }
}
