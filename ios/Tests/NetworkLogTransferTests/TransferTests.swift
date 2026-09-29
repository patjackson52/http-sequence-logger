import XCTest
import Foundation
import Security
@testable import NetworkLogTransfer

private actor FakeTransport: BatchTransport {
    enum Response: Sendable { case ack, status(Int), wrongCollector, partial, offline }
    var responses: [Response]
    var batches: [Data] = []
    var acknowledgementSizes: [Int] = []
    let collectorID: String
    init(_ responses: [Response] = [.ack], collectorID: String = "collector-test") {
        self.responses = responses
        self.collectorID = collectorID
    }
    func upload(_ bytes: Data) async throws -> UploadResponse {
        batches.append(bytes)
        let response = responses.isEmpty ? .ack : responses.removeFirst()
        if case .offline = response { throw URLError(.notConnectedToInternet) }
        if case .status(let code) = response { return UploadResponse(status: code, body: Data()) }
        let ids = try String(decoding: bytes, as: UTF8.self).split(separator: "\n").map {
            (try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any])["event_id"] as! String
        }
        var ackIDs = ids
        if case .partial = response { ackIDs = [] }
        var collector = collectorID
        if case .wrongCollector = response { collector = "other-collector" }
        let acknowledgement = try JSONSerialization.data(withJSONObject: [
            "version": 1, "collector_id": collector, "acknowledged_event_ids": ackIDs
        ])
        acknowledgementSizes.append(acknowledgement.count)
        return UploadResponse(status: 200, body: acknowledgement)
    }
    nonisolated func close() {}
    func count() -> Int { batches.count }
    func delivered() -> [Data] { batches }
    func acknowledgementByteCounts() -> [Int] { acknowledgementSizes }
}

final class TransferTests: XCTestCase, @unchecked Sendable {
    private let token = "unit-test-pairing-secret-never-a-capture-value"
    private func directory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("transfer-test-\(UUID().uuidString)")
    }
    private func connection(endpoint: String = "http://127.0.0.1:4319", collector: String = "collector-test", pin: String? = nil) throws -> TransferConnection {
        var json: [String: Any] = ["version": 1, "endpoint": endpoint, "token": token, "collector_id": collector]
        json["certificate_sha256"] = pin
        return try TransferConnection.parse(json: JSONSerialization.data(withJSONObject: json))
    }
    private func line(_ id: String = "event-1", version: String = "1.0") -> String {
        "{\"schema_version\":\"\(version)\",\"event_id\":\"\(id)\",\"event_type\":\"session.started\",\"data\":{}}"
    }
    private func sink(_ dir: URL, transport: FakeTransport, limits: TransferLimits = TransferLimits(), collector: String = "collector-test") throws -> NDJSONTransferSink {
        try NDJSONTransferSink(connection: connection(collector: collector), spoolDirectory: dir, limits: limits, transport: transport)
    }

    func testPairingRejectsNonloopbackHTTPAndCredentialBearingURLs() throws {
        for endpoint in ["http://example.com", "http://localhost.evil.test", "http://192.168.1.8", "https://u:p@example.com", "https://example.com/path", "https://example.com?token=x", "https://example.com#token", "file:///tmp/a"] {
            XCTAssertThrowsError(try connection(endpoint: endpoint))
        }
        for endpoint in ["http://127.0.0.1:4319", "http://localhost:4319", "http://[::1]:4319", "https://collector.example"] {
            XCTAssertNoThrow(try connection(endpoint: endpoint))
        }
        let value = try connection()
        XCTAssertFalse(String(describing: value).contains(token))
        XCTAssertFalse(String(reflecting: value).contains(token))
    }

    func testDurableACKAndRestartResume() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let first = try sink(dir, transport: FakeTransport())
        try await first.appendSanitizedLine(line())
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("events.ndjson"), encoding: .utf8), line() + "\n")
        let done = await first.flush()
        XCTAssertEqual(done.state, .idle)
        XCTAssertEqual(done.pendingBytes, 0)
        await first.close()
        let transport = FakeTransport()
        let reopened = try sink(dir, transport: transport)
        let status = await reopened.flush()
        let count = await transport.count()
        XCTAssertEqual(status.pendingBytes, 0)
        XCTAssertEqual(count, 0)
        await reopened.close()
    }

    func testValidUnicodeIDsAcceptACKLargerThan512KiBAndPersistCursor() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let lines = (0..<300).map { line("\($0)-" + String(repeating: "😀", count: 450)) }
        let data = Data((lines.joined(separator: "\n") + "\n").utf8)
        XCTAssertLessThan(data.count, 1024 * 1024)
        let source = dir.appendingPathComponent("source.ndjson")
        try data.write(to: source)
        let transport = FakeTransport()
        let transfer = try sink(dir.appendingPathComponent("spool"), transport: transport)
        // File relay queues the entire batch without yielding to the automatic-flush timer.
        let relayed = try await transfer.relaySanitizedFile(source)
        XCTAssertEqual(relayed, 300)
        let result = await transfer.flush()
        let sizes = await transport.acknowledgementByteCounts()
        XCTAssertEqual(sizes.count, 1)
        XCTAssertGreaterThan(try XCTUnwrap(sizes.first), 512 * 1024)
        XCTAssertLessThan(try XCTUnwrap(sizes.first), TransferProtocolLimits.maximumAcknowledgementBytes)
        XCTAssertEqual(result.state, .idle)
        XCTAssertEqual(result.pendingBytes, 0)
        await transfer.close()
        let reopened = try sink(dir.appendingPathComponent("spool"), transport: FakeTransport())
        let restored = await reopened.status()
        XCTAssertEqual(restored.pendingBytes, 0)
        await reopened.close()
    }

    func testNewCollectorReplaysAcknowledgedSpool() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let first = try sink(dir, transport: FakeTransport())
        try await first.appendSanitizedLine(line())
        await first.flush(); await first.close()
        let transport = FakeTransport(collectorID: "collector-new")
        let second = try sink(dir, transport: transport, collector: "collector-new")
        let before = await second.status()
        XCTAssertGreaterThan(before.pendingBytes, 0)
        let after = await second.flush()
        XCTAssertEqual(after.pendingBytes, 0)
        await second.close()
    }

    func testReplacedFilePrefixCannotReuseCursor() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let first = try sink(dir, transport: FakeTransport())
        try await first.appendSanitizedLine(line("event-1"))
        await first.flush(); await first.close()
        try (line("event-9") + "\n").write(to: dir.appendingPathComponent("events.ndjson"), atomically: true, encoding: .utf8)
        let transport = FakeTransport()
        let second = try sink(dir, transport: transport)
        await second.flush()
        let batches = await transport.delivered()
        XCTAssertEqual(batches.map { String(decoding: $0, as: UTF8.self) }, [line("event-9") + "\n"])
        await second.close()
    }

    func testPartialAppendIsRecoveredAtRestart() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try (line() + "\n{\"event_id\":").write(to: dir.appendingPathComponent("events.ndjson"), atomically: true, encoding: .utf8)
        let transfer = try sink(dir, transport: FakeTransport())
        let exported = await transfer.exportSpool()
        XCTAssertEqual(String(decoding: exported, as: UTF8.self), line() + "\n")
        await transfer.close()
    }

    func testWrongCollectorAndPartialACKNeverAdvanceCursor() async throws {
        for response in [FakeTransport.Response.wrongCollector, .partial] {
            let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
            let transfer = try sink(dir, transport: FakeTransport([response]))
            try await transfer.appendSanitizedLine(line())
            let result = await transfer.flush()
            XCTAssertEqual(result.state, .blocked)
            XCTAssertEqual(result.diagnostic, "invalid_acknowledgement")
            XCTAssertGreaterThan(result.pendingBytes, 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("cursor.json").path))
            await transfer.close()
        }
    }

    func testOfflineRetryPreservesExactBytesAndEventuallyFlushes() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        var limits = TransferLimits(); limits.initialRetryDelay = 0.02; limits.maximumRetryDelay = 0.03
        let transport = FakeTransport([.offline, .status(503), .ack])
        let transfer = try sink(dir, transport: transport, limits: limits)
        try await transfer.appendSanitizedLine(line(version: "1.1"))
        let failure = await transfer.flush()
        XCTAssertEqual(failure.state, .retrying)
        try await Task.sleep(nanoseconds: 200_000_000)
        let delivered = await transport.delivered()
        let final = await transfer.status()
        XCTAssertEqual(delivered.count, 3)
        XCTAssertTrue(delivered.allSatisfy { $0 == delivered.first })
        XCTAssertEqual(final.pendingBytes, 0)
        await transfer.close()
    }

    func testPermanentRejectionRetainsSpoolWithoutRetryLoop() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let transport = FakeTransport([.status(401)])
        let transfer = try sink(dir, transport: transport)
        try await transfer.appendSanitizedLine(line())
        let failed = await transfer.flush()
        XCTAssertEqual(failed.state, .blocked)
        try await Task.sleep(nanoseconds: 300_000_000)
        let count = await transport.count()
        XCTAssertEqual(count, 1)
        XCTAssertGreaterThan(failed.pendingBytes, 0)
        await transfer.close()
    }

    func testAutomaticSmallBatchFlush() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let transport = FakeTransport()
        let transfer = try sink(dir, transport: transport)
        try await transfer.appendSanitizedLine(line())
        try await Task.sleep(nanoseconds: 400_000_000)
        let status = await transfer.status()
        let count = await transport.count()
        XCTAssertEqual(status.pendingBytes, 0)
        XCTAssertEqual(count, 1)
        await transfer.close()
    }

    func testBoundedSpoolRejectsUnacknowledgedOverflowAndCompactsAcknowledgedData() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        var limits = TransferLimits(); limits.maximumBatchBytes = 150; limits.maximumSpoolBytes = 220
        let transfer = try sink(dir, transport: FakeTransport(), limits: limits)
        try await transfer.appendSanitizedLine(line("event-1"))
        try await transfer.appendSanitizedLine(line("event-2"))
        do { try await transfer.appendSanitizedLine(line("event-3")); XCTFail("Expected full spool") }
        catch { XCTAssertEqual(error as? TransferError, .spoolFull) }
        await transfer.flush()
        try await transfer.appendSanitizedLine(line("event-3"))
        let exported = await transfer.exportSpool()
        XCTAssertLessThanOrEqual(exported.count, 220)
        await transfer.close()
    }

    func testOnlyOneWriterCanOwnSpool() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let transfer = try sink(dir, transport: FakeTransport())
        XCTAssertThrowsError(try sink(dir, transport: FakeTransport())) { XCTAssertEqual($0 as? TransferError, .spoolBusy) }
        await transfer.close()
    }

    func testRelayPreservesIDsAndIgnoresIncompleteTail() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let source = directory(); defer { try? FileManager.default.removeItem(at: source) }
        try (line("event-1") + "\r\n" + line("event-2", version: "1.1") + "\n{incomplete").write(to: source, atomically: true, encoding: .utf8)
        let transfer = try sink(dir, transport: FakeTransport())
        let count = try await transfer.relaySanitizedFile(source)
        XCTAssertEqual(count, 2)
        let data = await transfer.exportSpool()
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("incomplete"))
        await transfer.close()
    }

    func testRejectsTokenAndMalformedMultilineInput() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let transfer = try sink(dir, transport: FakeTransport())
        for text in [line(token), line() + "\n" + line(), "not json", line(version: "9.0")] {
            do { try await transfer.appendSanitizedLine(text); XCTFail("Invalid line accepted") }
            catch { XCTAssertEqual(error as? TransferError, .invalidEvent) }
        }
        await transfer.close()
    }

    func testPinnedLeafStillRequiresHostnameValidityAndExactPin() throws {
        #if SWIFT_PACKAGE
        let resource = Bundle.module.url(forResource: "localhost", withExtension: "der", subdirectory: "Fixtures")!
        #else
        let resource = Bundle(for: TransferTests.self).url(forResource: "localhost", withExtension: "der")!
        #endif
        let der = try Data(contentsOf: resource)
        let certificate = SecCertificateCreateWithData(nil, der as CFData)!
        let validity = try XCTUnwrap(CertificateValidity.read(der))
        let midpoint = validity.start.addingTimeInterval(validity.end.timeIntervalSince(validity.start) / 2)
        func trust() -> SecTrust {
            var value: SecTrust?
            XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, "localhost" as CFString), &value), errSecSuccess)
            return value!
        }
        XCTAssertTrue(PairedTrust.accepts(trust: trust(), host: "localhost", pin: sha256(der), now: midpoint))
        XCTAssertFalse(PairedTrust.accepts(trust: trust(), host: "wrong.example", pin: sha256(der), now: midpoint))
        XCTAssertFalse(PairedTrust.accepts(trust: trust(), host: "localhost", pin: String(repeating: "0", count: 64), now: midpoint))
        XCTAssertFalse(PairedTrust.accepts(trust: trust(), host: "localhost", pin: sha256(der), now: validity.end.addingTimeInterval(1)))
        XCTAssertFalse(PairedTrust.accepts(trust: trust(), host: "localhost", pin: sha256(der), now: validity.start.addingTimeInterval(-1)))
    }
}
