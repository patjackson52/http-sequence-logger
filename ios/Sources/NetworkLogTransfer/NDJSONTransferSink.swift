#if DEBUG
import Foundation

/// Development-only transfer for already-sanitized schema 1.0/1.1 records.
/// It never instruments network traffic or regenerates event IDs/timestamps.
public actor NDJSONTransferSink {
    private struct Acknowledgement: Decodable {
        let version: Int
        let collector_id: String
        let acknowledged_event_ids: [String]
    }
    private let connection: TransferConnection
    private let limits: TransferLimits
    private let transport: any BatchTransport
    private var spool: DurableSpool?
    private var state: TransferStatus.State = .idle
    private var diagnostic: String?
    private var lastHTTPStatus: Int?
    private var retryAttempt = 0
    private var scheduled: Task<Void, Never>?
    private var draining: Task<TransferStatus, Never>?
    private var isClosed = false

    public init(connection: TransferConnection, spoolDirectory: URL, limits: TransferLimits = TransferLimits()) throws {
        try Self.validate(limits)
        self.connection = connection
        self.limits = limits
        spool = try DurableSpool(directory: spoolDirectory, collectorID: connection.collectorID, limits: limits)
        transport = CollectorTransport(connection: connection)
        state = spool!.pendingBytes > 0 ? .queued : .idle
    }

    init(connection: TransferConnection, spoolDirectory: URL, limits: TransferLimits, transport: any BatchTransport) throws {
        try Self.validate(limits)
        self.connection = connection
        self.limits = limits
        self.transport = transport
        spool = try DurableSpool(directory: spoolDirectory, collectorID: connection.collectorID, limits: limits)
        state = spool!.pendingBytes > 0 ? .queued : .idle
    }

    deinit { scheduled?.cancel(); transport.close() }

    private static func validate(_ value: TransferLimits) throws {
        guard (1...1_048_576).contains(value.maximumBatchBytes), (1...500).contains(value.maximumBatchEvents),
              value.maximumSpoolBytes >= value.maximumBatchBytes, value.maximumSpoolBytes <= 256 * 1024 * 1024,
              value.flushDelay >= 0, value.flushDelay <= 0.25,
              value.initialRetryDelay > 0, value.maximumRetryDelay >= value.initialRetryDelay,
              value.maximumRetryDelay <= 300 else { throw TransferError.invalidLimits }
    }

    /// Persist before returning. A full spool rejects new data without deleting unacknowledged records.
    /// Callers may continue their original file sink when this method reports an error.
    public func appendSanitizedLine(_ line: String) throws {
        guard !isClosed, let spool else { throw TransferError.closed }
        guard !line.contains(connection.token) else { throw TransferError.invalidEvent }
        let event = try EventLine.parse(line, maximumBytes: limits.maximumBatchBytes)
        try spool.append(event, allowCompaction: draining == nil)
        if state != .blocked && state != .retrying {
            state = .queued
            schedule(after: limits.flushDelay)
        }
    }

    /// Relays complete lines only. Replaying a file preserves IDs; the collector deduplicates acknowledged events.
    /// An unfinished final line is deliberately left for a later import. Call this on sanitized capture files only.
    @discardableResult public func relaySanitizedFile(_ url: URL) throws -> Int {
        guard !isClosed else { throw TransferError.closed }
        let handle: FileHandle
        do { handle = try FileHandle(forReadingFrom: url) } catch { throw TransferError.storageFailure }
        defer { try? handle.close() }
        var pending = Data()
        var count = 0
        do {
            while let chunk = try handle.read(upToCount: 65536), !chunk.isEmpty {
                pending.append(chunk)
                while let newline = pending.firstIndex(of: 10) {
                    let raw = Data(pending[..<newline])
                    pending = Data(pending.dropFirst(newline + 1))
                    guard let line = String(data: raw, encoding: .utf8) else { throw TransferError.invalidEvent }
                    try appendSanitizedLine(line.hasSuffix("\r") ? String(line.dropLast()) : line)
                    count += 1
                }
                guard pending.count <= limits.maximumBatchBytes else { throw TransferError.eventTooLarge }
            }
        } catch { throw (error as? TransferError) ?? .storageFailure }
        return count
    }

    /// Trigger after opening a sink on a persisted spool or after correcting a permanent collector error.
    public func resume() {
        guard !isClosed else { return }
        diagnostic = nil
        retryAttempt = 0
        state = (spool?.pendingBytes ?? 0) > 0 ? .queued : .idle
        schedule(after: 0)
    }

    /// Attempts delivery of all currently queued batches. On failure it returns a status and retains the spool.
    /// Concurrent calls share one drain; it never waits through an unbounded reconnect loop.
    @discardableResult public func flush() async -> TransferStatus {
        scheduled?.cancel()
        scheduled = nil
        if let draining { return await draining.value }
        guard !isClosed, state != .blocked else { return status() }
        let task = Task { await self.drain() }
        draining = task
        let result = await task.value
        draining = nil
        return result
    }

    public func status() -> TransferStatus {
        TransferStatus(state: state, pendingBytes: spool?.pendingBytes ?? 0,
                       diagnostic: diagnostic, lastHTTPStatus: lastHTTPStatus)
    }

    /// Contains capture records only, never pairing configuration or HTTP transport diagnostics.
    public func exportSpool() -> Data { spool?.exportData() ?? Data() }

    /// Stops transfer without deleting pending records. Call flush first when graceful delivery is desired.
    public func close() async {
        isClosed = true
        scheduled?.cancel()
        scheduled = nil
        transport.close()
        if let draining { _ = await draining.value }
        draining = nil
        state = .closed
        spool = nil // Releases the exclusive writer lock for a new sink/process.
    }

    private func drain() async -> TransferStatus {
        while !isClosed, let spool, spool.pendingBytes > 0 {
            let batch: DurableSpool.Batch
            do {
                guard let next = try spool.nextBatch() else { break }
                batch = next
            } catch { block("spool_invalid"); break }
            state = .sending
            do {
                let response = try await transport.upload(batch.bytes)
                guard !isClosed else { break }
                lastHTTPStatus = response.status
                if response.status == 200 {
                    guard response.body.count <= TransferProtocolLimits.maximumAcknowledgementBytes,
                          let ack = try? JSONDecoder().decode(Acknowledgement.self, from: response.body),
                          ack.version == 1, ack.collector_id == connection.collectorID,
                          Set(batch.ids).isSubset(of: Set(ack.acknowledged_event_ids)) else {
                        block("invalid_acknowledgement"); break
                    }
                    do { try spool.acknowledge(batch) } catch { block("cursor_write_failed"); break }
                    retryAttempt = 0
                    diagnostic = nil
                } else if response.status == 408 || response.status == 429 || response.status >= 500 {
                    retry("collector_unavailable")
                    break
                } else {
                    // Includes redirects: never forward the token or silently accept a redirected upload.
                    block("collector_rejected")
                    break
                }
            } catch {
                guard !isClosed else { break }
                if error is CollectorResponseError { block("acknowledgement_too_large") }
                else { retry("connection_failed") }
                break
            }
        }
        if isClosed { state = .closed }
        else if spool?.pendingBytes == 0 { state = .idle }
        return status()
    }

    private func block(_ code: String) { state = .blocked; diagnostic = code }
    private func retry(_ code: String) {
        state = .retrying
        diagnostic = code
        let delay = min(limits.maximumRetryDelay, limits.initialRetryDelay * pow(2, Double(min(retryAttempt, 20))))
        retryAttempt += 1
        schedule(after: delay * Double.random(in: 0.8...1.0))
    }
    private func schedule(after delay: TimeInterval) {
        guard !isClosed, state != .blocked, scheduled == nil, (spool?.pendingBytes ?? 0) > 0 else { return }
        scheduled = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
            await self?.scheduledFlush()
        }
    }
    private func scheduledFlush() async {
        scheduled = nil
        await flush()
    }
}
#endif
