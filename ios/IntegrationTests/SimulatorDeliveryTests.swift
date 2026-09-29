import XCTest
import NetworkLogTransfer
@testable import NetworkLogTransferDemo

final class SimulatorDeliveryTests: XCTestCase, @unchecked Sendable {
    @MainActor private func configuration() throws -> [String: Any] {
        guard let url = Bundle(for: Self.self).url(forResource: "IntegrationConfig", withExtension: "json"),
              let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
              value["enabled"] as? Bool == true else { throw XCTSkip("Run scripts/run-simulator-tests.mjs with collector pairing files") }
        return value
    }
    @MainActor private func pairing(_ config: [String: Any], name: String) throws -> TransferConnection {
        try TransferConnection.parse(json: JSONSerialization.data(withJSONObject: config[name]!))
    }
    @MainActor private func directory(_ suffix: String) -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("integration-\(suffix)-\(UUID().uuidString)")
    }
    @MainActor private func evidence(_ result: ManualCaptureDemo.Result, test: String) throws {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = documents.appendingPathComponent("transfer-evidence.ndjson")
        let value: [String: Any] = ["test": test, "run_id": try configuration()["run_id"]!, "session_id": result.sessionID, "capture": result.captureURL.path,
                                    "state": result.status.state.rawValue, "pending_bytes": result.status.pendingBytes,
                                    "platform": "ios-simulator", "timestamp": ISO8601DateFormatter().string(from: Date())]
        var bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        bytes.append(10)
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        let file = try FileHandle(forWritingTo: url)
        try file.seekToEnd(); try file.write(contentsOf: bytes); try file.close()
    }

    @MainActor func testRealURLSessionCaptureTransfersOverHTTP() async throws {
        let config = try configuration()
        let result = try await ManualCaptureDemo.run(connection: pairing(config, name: "loopback"),
            requestURL: URL(string: config["health_url"] as! String)!, directory: directory("http"))
        XCTAssertEqual(result.status.state, .idle)
        XCTAssertEqual(result.status.pendingBytes, 0)
        let capture = try String(contentsOf: result.captureURL, encoding: .utf8)
        XCTAssertEqual(capture.split(separator: "\n").count, 7)
        XCTAssertTrue(capture.contains("http.response.headers"))
        XCTAssertFalse(capture.contains("/api/v1/events"))
        try evidence(result, test: "http-native-delivery")
    }

    @MainActor func testRealURLSessionCaptureTransfersOverPairedTLS() async throws {
        let config = try configuration()
        let result = try await ManualCaptureDemo.run(connection: pairing(config, name: "tls"),
            requestURL: URL(string: config["health_url"] as! String)!, directory: directory("tls"))
        XCTAssertEqual(result.status.state, .idle)
        XCTAssertEqual(result.status.pendingBytes, 0)
        try evidence(result, test: "paired-tls-native-delivery")
    }

    @MainActor func testMismatchedPinRetainsNativeCapture() async throws {
        let config = try configuration()
        var bad = config["tls"] as! [String: Any]
        bad["certificate_sha256"] = String(repeating: "0", count: 64)
        let connection = try TransferConnection.parse(json: JSONSerialization.data(withJSONObject: bad))
        let result = try await ManualCaptureDemo.run(connection: connection,
            requestURL: URL(string: config["health_url"] as! String)!, directory: directory("bad-pin"))
        XCTAssertEqual(result.status.state, .retrying)
        XCTAssertEqual(result.status.diagnostic, "connection_failed")
        XCTAssertGreaterThan(result.status.pendingBytes, 0)
        try evidence(result, test: "bad-pin-retains-spool")
    }

    @MainActor func testRedirectIsNeverFollowed() async throws {
        let config = try configuration()
        var changed = config["loopback"] as! [String: Any]
        changed["endpoint"] = config["redirect_endpoint"]
        let result = try await ManualCaptureDemo.run(connection: TransferConnection.parse(json: JSONSerialization.data(withJSONObject: changed)),
            requestURL: URL(string: config["health_url"] as! String)!, directory: directory("redirect"))
        XCTAssertEqual(result.status.state, .blocked)
        XCTAssertEqual(result.status.lastHTTPStatus, 307)
        XCTAssertGreaterThan(result.status.pendingBytes, 0)
        try evidence(result, test: "redirect-blocked")
    }

    @MainActor func testRealCollectorAcceptsACKLargerThan512KiB() async throws {
        let config = try configuration()
        let connection = try pairing(config, name: "loopback")
        let location = directory("large-ack")
        try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true)
        let recordingPrefix = "ios-ack-\(UUID().uuidString.lowercased())"
        let ids = (0..<300).map { "\(recordingPrefix)-\($0)-" + String(repeating: "😀", count: 450) }
        let clock = ISO8601DateFormatter()
        clock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = clock.string(from: Date())
        var bytes = Data()
        for (index, id) in ids.enumerated() {
            // Complete schema-valid records; missing earlier lifecycle observations are permitted.
            let event: [String: Any] = [
                "schema_version": "1.0", "event_type": "session.ended", "event_id": id,
                "session_namespace": "com.example.networklog/development", "session_id": recordingPrefix,
                "recording_id": "\(recordingPrefix)-\(index)", "sequence": 1,
                "timestamp": timestamp, "monotonic_ns": "0",
                "data": ["reason": "completed", "dropped_events": 0]
            ]
            bytes.append(try JSONSerialization.data(withJSONObject: event))
            bytes.append(10)
        }
        XCTAssertLessThan(bytes.count, 1024 * 1024)
        // These required fields alone exceed the former limit; the collector adds recording metadata.
        let minimumACK = try JSONSerialization.data(withJSONObject: [
            "version": 1, "collector_id": connection.collectorID, "acknowledged_event_ids": ids
        ])
        XCTAssertGreaterThan(minimumACK.count, 512 * 1024)
        let source = location.appendingPathComponent("large-ack.ndjson")
        try bytes.write(to: source)
        let sink = try NDJSONTransferSink(connection: connection, spoolDirectory: location.appendingPathComponent("spool"))
        let count = try await sink.relaySanitizedFile(source)
        XCTAssertEqual(count, ids.count)
        let delivered = await sink.flush()
        XCTAssertEqual(delivered.state, .idle, "\(delivered.diagnostic ?? "none"); HTTP \(delivered.lastHTTPStatus ?? 0)")
        XCTAssertEqual(delivered.pendingBytes, 0)
        await sink.close()
    }

    @MainActor func testChunkedACKOver2MiBIsBoundedAndRetainsCapture() async throws {
        let config = try configuration()
        var changed = config["loopback"] as! [String: Any]
        changed["endpoint"] = config["ack_limit_endpoint"]
        let result = try await ManualCaptureDemo.run(connection: TransferConnection.parse(json: JSONSerialization.data(withJSONObject: changed)),
            requestURL: URL(string: config["health_url"] as! String)!, directory: directory("ack-limit"))
        XCTAssertEqual(result.status.state, .blocked)
        XCTAssertEqual(result.status.diagnostic, "acknowledgement_too_large")
        XCTAssertGreaterThan(result.status.pendingBytes, 0)
        try evidence(result, test: "oversized-chunked-ack-rejected")
    }

    @MainActor func testRealOfflineReconnectRetainsIdentityAndResumesAutomatically() async throws {
        let config = try configuration()
        var changed = config["loopback"] as! [String: Any]
        changed["endpoint"] = config["reconnect_endpoint"]
        let connection = try TransferConnection.parse(json: JSONSerialization.data(withJSONObject: changed))
        let location = directory("reconnect")
        var limits = TransferLimits(); limits.initialRetryDelay = 0.2; limits.maximumRetryDelay = 0.5
        let sink = try NDJSONTransferSink(connection: connection, spoolDirectory: location.appendingPathComponent("spool"), limits: limits)
        let initial = try await ManualCaptureDemo.capture(requestURL: URL(string: config["health_url"] as! String)!, directory: location, sink: sink)
        XCTAssertEqual(initial.status.state, .retrying)
        XCTAssertGreaterThan(initial.status.pendingBytes, 0)
        let original = try Data(contentsOf: initial.captureURL)
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        // Host runner starts a transparent localhost forwarding listener only after observing this marker.
        try Data("ready".utf8).write(to: documents.appendingPathComponent("reconnect-ready-\(config["run_id"] as! String)"))
        for _ in 0..<100 {
            if await sink.status().pendingBytes == 0 { break }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        let final = await sink.status()
        XCTAssertEqual(final.state, .idle)
        XCTAssertEqual(final.pendingBytes, 0)
        let retained = await sink.exportSpool()
        XCTAssertEqual(retained, original)
        await sink.close()
        let reopened = try NDJSONTransferSink(connection: connection, spoolDirectory: location.appendingPathComponent("spool"), limits: limits)
        let resumed = await reopened.flush()
        XCTAssertEqual(resumed.pendingBytes, 0)
        await reopened.close()
        try evidence(.init(captureURL: initial.captureURL, sessionID: initial.sessionID, status: final), test: "real-offline-automatic-reconnect")
    }
}
