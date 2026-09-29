#if DEBUG
import Foundation
import Darwin

struct EventLine {
    let id: String
    let bytes: Data
    static func parse(_ line: String, maximumBytes: Int) throws -> EventLine {
        var text = line
        if text.hasSuffix("\n") { text.removeLast(); if text.hasSuffix("\r") { text.removeLast() } }
        guard text.utf8.count + 1 <= maximumBytes else { throw TransferError.eventTooLarge }
        guard !text.contains("\n"), !text.contains("\r"), let bytes = text.data(using: .utf8), !bytes.isEmpty,
              let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              let version = object["schema_version"] as? String, ["1.0", "1.1"].contains(version),
              let id = object["event_id"] as? String, !id.isEmpty,
              object["event_type"] is String, object["data"] is [String: Any] else { throw TransferError.invalidEvent }
        var terminated = bytes
        terminated.append(10)
        return EventLine(id: id, bytes: terminated)
    }
}

/// Actor-confined. The lock prevents two active sinks from racing on a directory.
final class DurableSpool {
    struct Batch: Sendable { let bytes: Data; let ids: [String]; let endOffset: Int }
    private struct Cursor: Codable {
        let version: Int
        let collectorID: String
        let offset: Int
        let prefixSHA256: String
    }
    let fileURL: URL
    private let cursorURL: URL
    private let collectorID: String
    private let limits: TransferLimits
    private var bytes: Data
    private(set) var acknowledgedOffset = 0
    private var lockFD: Int32 = -1
    private var writeFailed = false
    var pendingBytes: Int { bytes.count - acknowledgedOffset }

    init(directory: URL, collectorID: String, limits: TransferLimits) throws {
        self.collectorID = collectorID
        self.limits = limits
        fileURL = directory.appendingPathComponent("events.ndjson")
        cursorURL = directory.appendingPathComponent("cursor.json")
        bytes = Data()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                   attributes: [.posixPermissions: 0o700])
            lockFD = Darwin.open(directory.appendingPathComponent("writer.lock").path, O_CREAT | O_RDWR, 0o600)
            guard lockFD >= 0 else { throw TransferError.storageFailure }
            guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw TransferError.spoolBusy }
            if FileManager.default.fileExists(atPath: fileURL.path) {
                let size = try FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber
                guard let size, size.intValue <= limits.maximumSpoolBytes else { throw TransferError.spoolFull }
                bytes = try Data(contentsOf: fileURL)
                // Only an incomplete final append is repairable. Interior corruption is retained and reported.
                if bytes.last != 10, !bytes.isEmpty {
                    let completeEnd = bytes.lastIndex(of: 10).map { $0 + 1 } ?? 0
                    bytes = Data(bytes.prefix(completeEnd))
                    try atomicWrite(bytes, to: fileURL)
                }
            } else { try atomicWrite(bytes, to: fileURL) }
            if let data = try? Data(contentsOf: cursorURL), let cursor = try? JSONDecoder().decode(Cursor.self, from: data),
               cursor.version == 1, cursor.collectorID == collectorID,
               cursor.offset >= 0, cursor.offset <= bytes.count,
               cursor.offset == 0 || bytes[cursor.offset - 1] == 10,
               sha256(Data(bytes.prefix(cursor.offset))) == cursor.prefixSHA256 {
                acknowledgedOffset = cursor.offset
            }
        } catch {
            if lockFD >= 0 { Darwin.close(lockFD); lockFD = -1 }
            throw (error as? TransferError) ?? .storageFailure
        }
    }
    deinit { if lockFD >= 0 { Darwin.close(lockFD) } }

    func append(_ event: EventLine, allowCompaction: Bool) throws {
        guard !writeFailed else { throw TransferError.storageFailure }
        do {
            if bytes.count + event.bytes.count > limits.maximumSpoolBytes,
               acknowledgedOffset > 0, allowCompaction {
                let remaining = Data(bytes.dropFirst(acknowledgedOffset))
                // If the process dies before the cursor update, the old prefix hash cannot match this file.
                try atomicWrite(remaining, to: fileURL)
                bytes = remaining
                acknowledgedOffset = 0
                try persistCursor()
            }
            guard bytes.count + event.bytes.count <= limits.maximumSpoolBytes else { throw TransferError.spoolFull }
            let file = try FileHandle(forWritingTo: fileURL)
            defer { try? file.close() }
            try file.seekToEnd()
            try file.write(contentsOf: event.bytes)
            try file.synchronize()
            bytes.append(event.bytes)
        } catch {
            // A failed append may have written a prefix. Reopening repairs an incomplete tail;
            // continuing to append here could turn that tail into unrecoverable interior corruption.
            if (error as? TransferError) != .spoolFull { writeFailed = true }
            throw (error as? TransferError) ?? .storageFailure
        }
    }

    func nextBatch() throws -> Batch? {
        guard pendingBytes > 0 else { return nil }
        var end = acknowledgedOffset
        var result = Data()
        var ids: [String] = []
        while end < bytes.count && ids.count < limits.maximumBatchEvents {
            guard let newline = bytes[end...].firstIndex(of: 10),
                  let string = String(data: bytes[end..<newline], encoding: .utf8) else { throw TransferError.invalidEvent }
            let record = try EventLine.parse(string, maximumBytes: limits.maximumBatchBytes)
            if !result.isEmpty && result.count + record.bytes.count > limits.maximumBatchBytes { break }
            result.append(record.bytes)
            ids.append(record.id)
            end = newline + 1
        }
        return Batch(bytes: result, ids: ids, endOffset: end)
    }

    func acknowledge(_ batch: Batch) throws {
        let previous = acknowledgedOffset
        acknowledgedOffset = batch.endOffset
        do { try persistCursor() } catch {
            acknowledgedOffset = previous
            throw TransferError.storageFailure
        }
    }

    func exportData() -> Data { bytes }

    private func persistCursor() throws {
        let cursor = Cursor(version: 1, collectorID: collectorID, offset: acknowledgedOffset,
                            prefixSHA256: sha256(Data(bytes.prefix(acknowledgedOffset))))
        try atomicWrite(JSONEncoder().encode(cursor), to: cursorURL)
    }
}

private func atomicWrite(_ bytes: Data, to url: URL) throws {
    // Atomic replacement plus file synchronization. Losing a cursor update only causes safe replay.
    try bytes.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.synchronize()
    let directory = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY)
    if directory >= 0 { _ = fsync(directory); Darwin.close(directory) }
}
#endif
