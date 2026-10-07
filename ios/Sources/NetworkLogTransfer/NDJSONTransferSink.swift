#if DEBUG
import Foundation

/// Development-only transfer for already-sanitized schema 1.3 records.
/// It never instruments network traffic or regenerates event IDs/timestamps.
public actor NDJSONTransferSink {
    private struct Acknowledgement: Decodable {
        let version: Int
        let collector_id: String
        let source_id: String
        let accepted: Int
        let duplicates: Int
        let cursor: Int
        let acknowledged_event_ids: [String]
    }
    public nonisolated let captureURL: URL
    private var connection: TransferConnection?
    private let limits: TransferLimits
    private var transport: (any BatchTransport)?
    private var generation=0
    private nonisolated let journal:DurableSpool
    nonisolated var queuedBytes:Int { journal.queuedBytes }
    private var spool: DurableSpool?
    private var state: TransferStatus.State = .idle
    private var diagnostic: String?
    private var lastHTTPStatus: Int?
    private var retryAttempt = 0
    private var scheduled: Task<Void, Never>?
    private var draining: Task<TransferStatus, Never>?
    private var drainingEpoch:Int?
    private var closing:Task<Void,Never>?
    private var isClosed = false

    public init(connection: TransferConnection? = nil, spoolDirectory: URL, limits: TransferLimits = TransferLimits()) throws {
        try Self.validate(limits)
        captureURL=spoolDirectory.appendingPathComponent("capture.ndjson")
        self.connection = connection
        self.limits = limits
        journal = try DurableSpool(directory: spoolDirectory, collectorID: connection?.collectorID ?? "unpaired", sourceID: connection?.sourceID ?? "unpaired", limits: limits)
        spool=journal
        transport = connection.map { CollectorTransport(connection: $0) }
        state = spool!.pendingBytes > 0 ? .queued : .idle
    }

    init(connection: TransferConnection, spoolDirectory: URL, limits: TransferLimits, transport: any BatchTransport) throws {
        try Self.validate(limits)
        captureURL=spoolDirectory.appendingPathComponent("capture.ndjson")
        self.connection = connection
        self.limits = limits
        self.transport = transport
        journal = try DurableSpool(directory: spoolDirectory, collectorID: connection.collectorID, sourceID: connection.sourceID, limits: limits)
        spool=journal
        state = spool!.pendingBytes > 0 ? .queued : .idle
    }

    deinit { scheduled?.cancel(); transport?.close() }

    private static func validate(_ value: TransferLimits) throws {
        guard (1...1_048_576).contains(value.maximumBatchBytes), (1...500).contains(value.maximumBatchEvents),
              value.maximumSpoolBytes >= value.maximumBatchBytes, value.maximumSpoolBytes <= 256 * 1024 * 1024,
              value.flushDelay >= 0, value.flushDelay <= 0.25,
              value.initialRetryDelay > 0, value.maximumRetryDelay >= value.initialRetryDelay,
              value.maximumRetryDelay <= 300 else { throw TransferError.invalidLimits }
    }

    /// Enqueue into bounded memory. Call flush() to wait for durable canonical storage.
    /// Callers may continue their original file sink when this method reports an error.
    public func appendSanitizedLine(_ line: String) throws {
        guard !isClosed, let spool else { throw TransferError.closed }
        if let connection, line.contains(connection.token) { throw TransferError.invalidEvent }
        let event = try EventLine.parse(line, maximumBytes: limits.maximumBatchBytes)
        try spool.append(event)
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
    @discardableResult public func deliverNow() async -> TransferStatus {
        scheduled?.cancel();scheduled=nil
        if let draining { _=await draining.value;return status() }
        guard !isClosed,state != .blocked else { return status() }
        let epoch=generation
        let task=Task { await self.drain() };draining=task;drainingEpoch=epoch
        _=await task.value
        if drainingEpoch==epoch { draining=nil;drainingEpoch=nil }
        return status()
    }
    public func rebind(_ next:TransferConnection?) async throws {
        guard !isClosed else { throw TransferError.closed }
        generation+=1;let epoch=generation
        scheduled?.cancel();scheduled=nil;transport?.close()
        if let draining { _=await draining.value }
        guard !isClosed else { throw TransferError.closed };guard epoch==generation else { return }
        draining=nil;drainingEpoch=nil
        try await spool?.rebind(collectorID:next?.collectorID ?? "unpaired",sourceID:next?.sourceID ?? "unpaired")
        guard !isClosed else { throw TransferError.closed };guard epoch==generation else { return }
        connection=next;transport=next.map { CollectorTransport(connection:$0) }
        state = .queued;diagnostic=nil;retryAttempt=0;schedule(after:0)
    }

    public func status() -> TransferStatus {
        TransferStatus(state: state, pendingBytes: spool?.pendingBytes ?? 0,
                       diagnostic: diagnostic, lastHTTPStatus: lastHTTPStatus)
    }

    /// Contains capture records only, never pairing configuration or HTTP transport diagnostics.
    public func exportSpool() async -> Data { await spool?.exportData() ?? Data() }

    public func flush() async throws { guard let spool else { throw TransferError.closed }; try await spool.flushPersistence() }

    /// Stops transfer without deleting pending records. Call flush first when graceful delivery is desired.
    public func close() async {
        if let closing { await closing.value;return }
        guard !isClosed else { return }
        isClosed=true;generation+=1;state = .closed
        scheduled?.cancel();scheduled=nil;transport?.close()
        let active=draining;let journal=spool
        let task=Task { if let active { _=await active.value };try? await journal?.close() }
        closing=task;await task.value
        draining=nil;drainingEpoch=nil;spool=nil;state = .closed
    }

    private func drain() async -> TransferStatus {
        let epoch=generation
        guard let connection, let transport else { state = .queued; return status() }
        while !isClosed, let spool, spool.pendingBytes > 0 {
            let batch: DurableSpool.Batch
            do {
                guard let next = try await spool.nextBatch() else { break }
                batch = next
            } catch { if !isClosed,epoch==generation { block("spool_invalid") };break }
            guard !isClosed,epoch==generation else { break }
            state = .sending
            do {
                let response = try await transport.upload(batch.bytes)
                guard !isClosed, epoch==generation else { break }
                lastHTTPStatus = response.status
                if response.status == 200 {
                    guard response.body.count <= TransferProtocolLimits.maximumAcknowledgementBytes,
                          let ack = try? JSONDecoder().decode(Acknowledgement.self, from: response.body),
                          ack.version == 2, ack.collector_id == connection.collectorID, ack.source_id == connection.sourceID,
                          ack.accepted + ack.duplicates == batch.ids.count, ack.cursor >= 0, ack.acknowledged_event_ids.count == batch.ids.count,
                          Set(batch.ids) == Set(ack.acknowledged_event_ids) else {
                        block("invalid_acknowledgement"); break
                    }
                    do { try await spool.acknowledge(batch) } catch { if !isClosed,epoch==generation { block("cursor_write_failed") };break }
                    guard !isClosed,epoch==generation else { break }
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
                guard !isClosed, epoch==generation else { break }
                if error is CollectorResponseError { block("acknowledgement_too_large") }
                else { retry("connection_failed") }
                break
            }
        }
        if isClosed { state = .closed }
        else if epoch==generation,spool?.pendingBytes == 0 { state = .idle }
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
        guard connection != nil, !isClosed, state != .blocked, scheduled == nil, (spool?.pendingBytes ?? 0) > 0 else { return }
        let epoch=generation
        scheduled = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
            await self?.scheduledFlush(epoch:epoch)
        }
    }
    private func scheduledFlush(epoch:Int) async {
        guard !isClosed,epoch==generation else { return }
        scheduled = nil
        await deliverNow()
    }
}
#endif
