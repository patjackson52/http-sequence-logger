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
            "version": 2, "collector_id": collector, "source_id":"source-test", "accepted":ids.count, "duplicates":0, "cursor":ids.count, "acknowledged_event_ids": ackIDs
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
        var json: [String: Any] = ["version": 2, "endpoint": endpoint, "source_token": token, "source_id":"source-test", "collector_id": collector]
        json["certificate_sha256"] = pin
        return try TransferConnection.parse(json: JSONSerialization.data(withJSONObject: json))
    }
    private func line(_ id: String = "event-1", version: String = "1.3") -> String {
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
        try await first.flush()
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("capture.ndjson"), encoding: .utf8), line() + "\n")
        let done = await first.deliverNow()
        XCTAssertEqual(done.state, .idle)
        XCTAssertEqual(done.pendingBytes, 0)
        await first.close()
        let transport = FakeTransport()
        let reopened = try sink(dir, transport: transport)
        let status = await reopened.deliverNow()
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
        let result = await transfer.deliverNow()
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
        await first.deliverNow(); await first.close()
        let transport = FakeTransport(collectorID: "collector-new")
        let second = try sink(dir, transport: transport, collector: "collector-new")
        let before = await second.status()
        XCTAssertGreaterThan(before.pendingBytes, 0)
        let after = await second.deliverNow()
        XCTAssertEqual(after.pendingBytes, 0)
        await second.close()
    }

    func testReplacedFilePrefixCannotReuseCursor() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let first = try sink(dir, transport: FakeTransport())
        try await first.appendSanitizedLine(line("event-1"))
        await first.deliverNow(); await first.close()
        try (line("event-9") + "\n").write(to: dir.appendingPathComponent("capture.ndjson"), atomically: true, encoding: .utf8)
        let transport = FakeTransport()
        let second = try sink(dir, transport: transport)
        await second.deliverNow()
        let batches = await transport.delivered()
        XCTAssertEqual(batches.map { String(decoding: $0, as: UTF8.self) }, [line("event-9") + "\n"])
        await second.close()
    }

    func testPartialAppendIsRecoveredAtRestart() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try (line() + "\n{\"event_id\":").write(to: dir.appendingPathComponent("capture.ndjson"), atomically: true, encoding: .utf8)
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
            let result = await transfer.deliverNow()
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
        try await transfer.appendSanitizedLine(line(version: "1.3"))
        let failure = await transfer.deliverNow()
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
        let failed = await transfer.deliverNow()
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

    func testCanonicalJournalRetainsAcknowledgedDataAtCapacity() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        var limits = TransferLimits(); limits.maximumBatchBytes = 150; limits.maximumSpoolBytes = 220
        let transfer = try sink(dir, transport: FakeTransport(), limits: limits)
        try await transfer.appendSanitizedLine(line("event-1"))
        try await transfer.appendSanitizedLine(line("event-2"))
        do { try await transfer.appendSanitizedLine(line("event-3")); XCTFail("Expected full spool") }
        catch { XCTAssertEqual(error as? TransferError, .spoolFull) }
        await transfer.deliverNow()
        do { try await transfer.appendSanitizedLine(line("event-3")); XCTFail("Canonical journal must retain acknowledged records") }
        catch { XCTAssertEqual(error as? TransferError,.spoolFull) }
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
        try (line("event-1") + "\r\n" + line("event-2", version: "1.3") + "\n{incomplete").write(to: source, atomically: true, encoding: .utf8)
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

    func testConcurrentAdmissionCloseAndCanonicalPersistence() async throws {
        let dir=directory();defer { try? FileManager.default.removeItem(at:dir) }
        let transfer=try NDJSONTransferSink(spoolDirectory:dir)
        try await withThrowingTaskGroup(of:Void.self) { group in
            for index in 0..<1000 { group.addTask { try await transfer.appendSanitizedLine(self.line("parallel-\(index)")) } }
            try await group.waitForAll()
        }
        try await transfer.flush()
        await transfer.close()
        let lines=try String(contentsOf:dir.appendingPathComponent("capture.ndjson"),encoding:.utf8).split(separator:"\n")
        XCTAssertEqual(lines.count,1000)
        XCTAssertEqual(Set(lines).count,1000)
        do { try await transfer.appendSanitizedLine(line("after-close"));XCTFail("Closed journal accepted a record") }
        catch { XCTAssertEqual(error as? TransferError,.closed) }
    }

    func testRebindFencesLateAckWhileCaptureContinues() async throws {
        let dir=directory();defer { try? FileManager.default.removeItem(at:dir) }
        let transport=StalledTransport()
        let transfer=try NDJSONTransferSink(connection:connection(),spoolDirectory:dir,limits:TransferLimits(),transport:transport)
        try await transfer.appendSanitizedLine(line("old-route"))
        let draining=Task { await transfer.deliverNow() }
        while !(await transport.started) { await Task.yield() }
        let rebinding=Task { try await transfer.rebind(nil) }
        while !transport.closed.value { await Task.yield() }
        try await transfer.appendSanitizedLine(line("during-rebind"))
        try await transfer.flush()
        XCTAssertTrue(try String(contentsOf:dir.appendingPathComponent("capture.ndjson"),encoding:.utf8).contains("during-rebind"))
        await transport.release()
        _=await draining.value;try await rebinding.value
        XCTAssertFalse(FileManager.default.fileExists(atPath:dir.appendingPathComponent("cursor.json").path))
        let state=await transfer.status();XCTAssertGreaterThan(state.pendingBytes,0)
        await transfer.close()
    }

    func testBootstrapWithoutCollectorPublishesFixedDescriptorAndRetainsIdentity() async throws {
        let root=directory();defer { try? FileManager.default.removeItem(at:root) }
        let first=try await DebugCapture.start(appID:"example.custom.debug",directory:root)
        let descriptor=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("source.json"))) as! [String:Any]
        XCTAssertEqual(descriptor["app_id"] as? String,"example.custom.debug")
        XCTAssertEqual(descriptor["journal_directory"] as? String,"journals")
        await first.close()
        let second=try await DebugCapture.start(appID:"example.custom.debug",directory:root)
        let replacement=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("source.json"))) as! [String:Any]
        XCTAssertEqual(descriptor["installation_id"] as? String,replacement["installation_id"] as? String)
        XCTAssertNotEqual(first.journalID,second.journalID)
        await second.close()
    }

    func testStalledDiskAdmissionReportsLatencyAndQueueHighWater() async throws {
        let dir=directory();defer { try? FileManager.default.removeItem(at:dir) }
        let io=InjectedDiskIO(mode:.stall);let spool=try DurableSpool(directory:dir,collectorID:"c",sourceID:"s",limits:TransferLimits(),diskIO:io)
        try spool.append(EventLine.parse(line(),maximumBytes:1024));let barrier=Task { try await spool.flushPersistence() }
        let entered=await Task.detached { io.waitUntilEntered() }.value;XCTAssertTrue(entered)
        var accepted=0;var maximum:UInt64=0
        while true {
            let event=try EventLine.parse(line("queue-\(accepted)-"+String(repeating:"x",count:4096)),maximumBytes:65536)
            let started=DispatchTime.now().uptimeNanoseconds
            do { try spool.append(event);accepted+=1 } catch { XCTAssertEqual(error as? TransferError,.spoolFull);break }
            maximum=max(maximum,DispatchTime.now().uptimeNanoseconds-started)
        }
        let highWater=spool.queuedBytes;XCTAssertLessThanOrEqual(highWater,2*1024*1024);XCTAssertGreaterThan(highWater,2*1024*1024-8192)
        print("NATIVE_ADMISSION_METRICS ios accepted=\(accepted) maximum_ns=\(maximum) queue_high_water_bytes=\(highWater) queue_limit_bytes=2097152")
        io.release.signal();try await barrier.value;try await spool.close()
    }
    func testPublishedWatermarkIsCoalescedAndSealForcesIt() async throws {
        let dir=directory();defer { try? FileManager.default.removeItem(at:dir) }
        let spool=try DurableSpool(directory:dir,collectorID:"c",sourceID:"s",limits:TransferLimits())
        try spool.append(EventLine.parse(line(),maximumBytes:1024));try await spool.flushPersistence()
        let metadata=dir.appendingPathComponent("journal.json")
        let early=try JSONSerialization.jsonObject(with:Data(contentsOf:metadata)) as! [String:Any]
        XCTAssertEqual(early["durable_bytes"] as? Int,0)
        try await spool.close()
        let sealed=try JSONSerialization.jsonObject(with:Data(contentsOf:metadata)) as! [String:Any]
        XCTAssertEqual(sealed["durable_bytes"] as? Int,line().utf8.count+1)
    }
    func testInstallationReservationCoversWriterAcquisition() async throws {
        let root=directory();defer { try? FileManager.default.removeItem(at:root) }
        try FileManager.default.createDirectory(at:root.appendingPathComponent("journals"),withIntermediateDirectories:true)
        let limits=NativeJournalLimits(generationBytes:220,installationBytes:220)
        let budget=try InstallationJournalBudget(root:root,limits:limits)
        let entered=DispatchSemaphore(value:0);let release=DispatchSemaphore(value:0)
        let owner=Task.detached {
            try budget.openGeneration { path in
                entered.signal();release.wait()
                var transfer=TransferLimits();transfer.maximumSpoolBytes=220;transfer.maximumBatchBytes=220
                return try DurableSpool(directory:path,collectorID:"c",sourceID:"s",limits:transfer)
            }
        }
        let started=await withCheckedContinuation { c in DispatchQueue.global().async { c.resume(returning:entered.wait(timeout:.now()+2) == .success) } }
        XCTAssertTrue(started)
        let follower=Task.detached { try budget.openGeneration { $0 } }
        release.signal();let writer=try await owner.value
        do { _=try await follower.value;XCTFail("Live reservation was reclaimed before writer ownership") } catch { XCTAssertEqual(error as? TransferError,.spoolFull) }
        try await writer.close()
    }
    func testMissingReservedGenerationOrCaptureRejectsReopenAndSealWithoutRewritingInventory() async throws {
        for removeDirectory in [true,false] {
            let root=directory();defer { try? FileManager.default.removeItem(at:root) }
            let first=try await DebugCapture.start(appID:"example.inventory",directory:root)
            try await first.appendSanitizedLine(line("first"));try await first.flush();await first.close()
            let second=try await DebugCapture.start(appID:"example.inventory",directory:root)
            try await second.appendSanitizedLine(line("second"));try await second.flush();await second.close()
            let state=root.appendingPathComponent("journal-budget.json")
            let original=try Data(contentsOf:state),retained=try Data(contentsOf:second.captureURL)
            try FileManager.default.removeItem(at:removeDirectory ? first.captureURL.deletingLastPathComponent() : first.captureURL)
            let journals=root.appendingPathComponent("journals")
            let remaining=try FileManager.default.contentsOfDirectory(atPath:journals.path).sorted()
            do {
                let unexpected=try await DebugCapture.start(appID:"example.inventory",directory:root)
                await unexpected.close();XCTFail("Missing retained generation was silently discarded")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains(first.journalID))
                XCTAssertTrue(error.localizedDescription.contains("export remaining captures"))
            }
            let budget=try InstallationJournalBudget(root:root,limits:NativeJournalLimits())
            XCTAssertThrowsError(try budget.seal(second.captureURL))
            XCTAssertEqual(try Data(contentsOf:state),original)
            XCTAssertEqual(try Data(contentsOf:second.captureURL),retained)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:journals.path).sorted(),remaining)
        }
    }
    func testInvalidOrOversizedInventoryRejectsBeforeAllocatingOrRewriting() throws {
        let invalid:[Data]=try [
            ["version":1,"reservations":[:]] as [String:Any],
            ["version":2,"reservations":["../escape":0]],
            ["version":2,"reservations":["_invalid":0]],
            ["version":2,"reservations":["safe\n":0]],
            ["version":2,"reservations":["safe":-1]],
            ["version":2,"reservations":["safe":"1"]],
            ["version":2,"reservations":["safe":true]],
            ["version":2,"reservations":["safe":1.5]],
            ["version":2,"reservations":Dictionary(uniqueKeysWithValues:(0..<129).map { ("generation-\($0)",0) })]
        ].map { try JSONSerialization.data(withJSONObject:$0) } + [Data(repeating:32,count:16385)]
        for bytes in invalid {
            let root=directory();defer { try? FileManager.default.removeItem(at:root) }
            let journals=root.appendingPathComponent("journals")
            try FileManager.default.createDirectory(at:journals,withIntermediateDirectories:true)
            let state=root.appendingPathComponent("journal-budget.json");try bytes.write(to:state)
            let budget=try InstallationJournalBudget(root:root,limits:NativeJournalLimits())
            XCTAssertThrowsError(try budget.openGeneration { _ in XCTFail("Invalid inventory allocated a writer") }) { error in
                XCTAssertTrue(error.localizedDescription.contains("restore missing journal state"))
            }
            XCTAssertEqual(try Data(contentsOf:state),bytes)
            XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath:journals.path).isEmpty)
        }
    }
    func testInitializedZeroEventInstallationWithoutBudgetCanStartAndSeal() async throws {
        let root=directory();defer { try? FileManager.default.removeItem(at:root) }
        try FileManager.default.createDirectory(at:root.appendingPathComponent("journals"),withIntermediateDirectories:true)
        try Data(UUID().uuidString.utf8).write(to:root.appendingPathComponent("installation-id"))
        try JSONSerialization.data(withJSONObject:["version":2,"platform":"ios","app_id":"example.empty","journal_directory":"journals"]).write(to:root.appendingPathComponent("source.json"))
        XCTAssertFalse(FileManager.default.fileExists(atPath:root.appendingPathComponent("journal-budget.json").path))
        let capture=try await DebugCapture.start(appID:"example.empty",directory:root);await capture.close()
        XCTAssertEqual(try Data(contentsOf:capture.captureURL).count,0)
        let value=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("journal-budget.json"))) as! [String:Any]
        XCTAssertEqual((value["reservations"] as? [String:Int])?[capture.journalID],0)
    }
    func testTransparentRotationRetainsCanonicalHistoryAndInstallationQuota() async throws {
        let root=directory();defer { try? FileManager.default.removeItem(at:root) }
        let limits=NativeJournalLimits(generationBytes:220,installationBytes:2200,maximumGenerations:16)
        let capture=try await DebugCapture.start(appID:"example.rolling",directory:root,journalLimits:limits)
        for id in 0..<10 { try await capture.appendSanitizedLine(line("event-\(id)")) }
        try await capture.flush();await capture.close()
        let paths=await capture.captureURLs;XCTAssertGreaterThan(paths.count,1)
        let records=try paths.flatMap { try String(contentsOf:$0,encoding:.utf8).split(separator:"\n").map(String.init) }
        XCTAssertEqual(records,(0..<10).map { line("event-\($0)") })
        for path in paths {
            let metadata=try JSONSerialization.jsonObject(with:Data(contentsOf:path.deletingLastPathComponent().appendingPathComponent("journal.json"))) as! [String:Any]
            XCTAssertEqual(metadata["durable_bytes"] as? Int,try Data(contentsOf:path).count)
        }
        let quotaRoot=directory();defer { try? FileManager.default.removeItem(at:quotaRoot) }
        let quota=try await DebugCapture.start(appID:"example.quota",directory:quotaRoot,journalLimits:NativeJournalLimits(generationBytes:220,installationBytes:220,maximumGenerations:1))
        for id in 0..<5 { try await quota.appendSanitizedLine(line("quota-\(id)")) }
        do { try await quota.flush();XCTFail("Rotation ignored the installation quota") } catch {}
        await quota.close();let retained=await quota.captureURLs
        XCTAssertEqual(retained.count,1);XCTAssertGreaterThan(try Data(contentsOf:retained[0]).count,0)
    }
    func testDiskStallRetainsOwnerAndPublicationCoalescesUntilClose() async throws {
        let dir=directory();defer { try? FileManager.default.removeItem(at:dir) }
        let io=InjectedDiskIO(mode:.stall)
        let spool=try DurableSpool(directory:dir,collectorID:"c",sourceID:"s",limits:TransferLimits(),diskIO:io)
        try spool.append(EventLine.parse(line(),maximumBytes:1024))
        let barrier=Task { try await spool.flushPersistence() }
        let entered=await Task.detached { io.waitUntilEntered() }.value
        XCTAssertTrue(entered)
        let close=Task { try await spool.close() }
        XCTAssertThrowsError(try DurableSpool(directory:dir,collectorID:"c",sourceID:"s",limits:TransferLimits()))
        io.release.signal();try await barrier.value;try await close.value
        let metadata=try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent("journal.json"))) as! [String:Any]
        XCTAssertEqual(metadata["durable_bytes"] as? Int,try Data(contentsOf:spool.fileURL).count)
        let reopened=try DurableSpool(directory:dir,collectorID:"c",sourceID:"s",limits:TransferLimits());try await reopened.close()
    }
    func testPartialWriteAndSyncFailurePoisonQueuedFollowups() async throws {
        for mode in [InjectedDiskIO.Mode.partial, .failedSync] {
            let dir=directory();defer { try? FileManager.default.removeItem(at:dir) }
            let io=InjectedDiskIO(mode:mode)
            let spool=try DurableSpool(directory:dir,collectorID:"c",sourceID:"s",limits:TransferLimits(),diskIO:io)
            try spool.append(EventLine.parse(line("first"),maximumBytes:1024))
            let first=Task { try await spool.flushPersistence() }
            let entered=await Task.detached { io.waitUntilEntered() }.value;XCTAssertTrue(entered)
            try spool.append(EventLine.parse(line("queued"),maximumBytes:1024))
            let queuedBarrier=Task { try await spool.flushPersistence() };io.release.signal()
            do { try await first.value;XCTFail("Injected failure ignored") } catch {}
            do { try await queuedBarrier.value;XCTFail("Queued commit survived poison") } catch {}
            XCTAssertThrowsError(try spool.append(EventLine.parse(line("after-failure"),maximumBytes:1024)))
            do { try await spool.flushPersistence();XCTFail("Poisoned barrier succeeded") } catch {}
            _=try? await spool.close()
            XCTAssertEqual(io.appendCount,1)
            let repaired=try DurableSpool(directory:dir,collectorID:"c",sourceID:"s",limits:TransferLimits());try await repaired.close()
            if mode == .partial { XCTAssertEqual(try Data(contentsOf:spool.fileURL).count,0) }
        }
    }
    func testRebindCloseIsTerminalEvenWhenOldTransportCompletesLate() async throws {
        let dir=directory();defer { try? FileManager.default.removeItem(at:dir) }
        let transport=StalledTransport();let transfer=try NDJSONTransferSink(connection:connection(),spoolDirectory:dir,limits:TransferLimits(),transport:transport)
        try await transfer.appendSanitizedLine(line("old-route"))
        let drain=Task { await transfer.deliverNow() };while !(await transport.started) { await Task.yield() }
        let rebind=Task { try await transfer.rebind(nil) };while !transport.closed.value { await Task.yield() }
        let close=Task { await transfer.close() };while (await transfer.status()).state != .closed { await Task.yield() }
        await transport.release();_=await drain.value;await close.value
        do { try await rebind.value;XCTFail("Suspended rebind mutated a closed sink") } catch { XCTAssertEqual(error as? TransferError,.closed) }
        do { try await transfer.rebind(connection());XCTFail("Closed sink rebound") } catch { XCTAssertEqual(error as? TransferError,.closed) }
        let status=await transfer.status();XCTAssertEqual(status.state,.closed)
        XCTAssertFalse(FileManager.default.fileExists(atPath:dir.appendingPathComponent("cursor.json").path))
    }
    func testEnrollmentPersistsInstallationCredentialAndManualSelectionWinsLocalProposal() async throws {
        let root=directory();defer { try? FileManager.default.removeItem(at:root) }
        let registered=try connection(endpoint:"http://127.0.0.1:1")
        let capture=try await DebugCapture.start(appID:"example.enrollment",directory:root)
        let counter=RegistrationCounter(response:try registered.encoded())
        await capture.setRegistrationRequester { _,_ in await counter.register() }
        let ticket=Data(#"{"version":2,"endpoint":"http://127.0.0.1:1","collector_id":"collector-test","enrollment_token":"expires-after-enrollment"}"#.utf8)
        try await capture.savePairing(ticket);await capture.refresh();
        let saved=try TransferConnection.parse(json:Data(contentsOf:root.appendingPathComponent("pairing.json")))
        XCTAssertEqual(saved.sourceID,registered.sourceID);let registrations=await counter.count;XCTAssertEqual(registrations,1)
        await capture.close();
        let local=try connection(endpoint:"http://127.0.0.1:2",collector:"other-collector")
        try atomicWrite(local.encoded(),to:root.appendingPathComponent("pairing-local.json"))
        let relaunched=try await DebugCapture.start(appID:"example.enrollment",directory:root)
        await relaunched.setRegistrationRequester { _,_ in XCTFail("Expired ticket was reused");return UploadResponse(status:401,body:Data()) }
        await relaunched.refresh();await relaunched.close()
        XCTAssertEqual(try TransferConnection.parse(json:Data(contentsOf:root.appendingPathComponent("pairing.json"))).collectorID,"collector-test")
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

private actor StalledTransport:BatchTransport {
    nonisolated let closed=TestSignal()
    var started=false
    private var completion:CheckedContinuation<UploadResponse,Never>?
    func upload(_ bytes:Data) async throws -> UploadResponse {
        started=true
        return await withCheckedContinuation { completion=$0 }
    }
    func release() {
        let ack=Data("{\"version\":2,\"collector_id\":\"collector-test\",\"source_id\":\"source-test\",\"accepted\":1,\"duplicates\":0,\"cursor\":1,\"acknowledged_event_ids\":[\"old-route\"]}".utf8)
        completion?.resume(returning:UploadResponse(status:200,body:ack));completion=nil
    }
    nonisolated func close() { closed.set() }
}

private final class TestSignal:@unchecked Sendable {
    private let lock=NSLock();private var state=false
    var value:Bool { lock.withLock { state } }
    func set() { lock.withLock { state=true } }
}

private final class InjectedDiskIO:JournalDiskIO,@unchecked Sendable {
    enum Mode { case stall,partial,failedSync }
    let mode:Mode;let entered=DispatchSemaphore(value:0);let release=DispatchSemaphore(value:0)
    private let lock=NSLock();private var writes=0;private var syncs=0
    var appendCount:Int { lock.withLock { writes } }
    init(mode:Mode) { self.mode=mode }
    func waitUntilEntered()->Bool { entered.wait(timeout:.now()+2) == .success }
    func append(_ bytes:Data,to file:FileHandle) throws {
        lock.withLock { writes+=1 }
        if mode != .stall { entered.signal();release.wait() }
        if mode == .partial { try file.write(contentsOf:bytes.prefix(bytes.count/4));throw TransferError.storageFailure }
        try file.write(contentsOf:bytes)
    }
    func sync(_ file:FileHandle) throws {
        if mode == .stall,lock.withLock({ syncs+=1;return syncs==1 }) { entered.signal();release.wait() }
        if mode == .failedSync { throw TransferError.storageFailure }
        try file.synchronize()
    }
}
private actor RegistrationCounter {
    let response:Data;var count=0
    init(response:Data) { self.response=response }
    func register()->UploadResponse { count+=1;return UploadResponse(status:200,body:response) }
}
