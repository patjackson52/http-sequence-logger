#if DEBUG
import Foundation
import NetworkLogTransfer
import Darwin
import UIKit

/// Small runnable manual-instrumentation example, intentionally separate from the transfer library.
/// This observes one real URLSession call. Transport requests have their own private session and are never recorded here.
@MainActor enum ManualCaptureDemo {
    struct Result { let captureURL: URL; let sessionID: String; let status: TransferStatus }
    static func run(connection: TransferConnection, requestURL: URL, directory: URL) async throws -> Result {
        let sink = try NDJSONTransferSink(connection: connection, spoolDirectory: directory.appendingPathComponent("spool"))
        do {
            let result = try await capture(requestURL: requestURL, directory: directory, sink: sink)
            await sink.close()
            return result
        } catch {
            await sink.close()
            throw error
        }
    }

    static func capture(requestURL: URL, directory: URL, sink: NDJSONTransferSink) async throws -> Result {
        let capture = Capture()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        capture.emit("session.started", at: 0, data: [
            "name": "iOS native manual URLSession transfer", "id_source": "generated",
            "producer": ["platform": "ios", "app_id": "com.example.networklog.demo", "app_version": "1.0",
                         "os_version": UIDevice.current.systemVersion, "sdk_version": "0.1.0"],
            "adapters": [["adapter": Capture.adapter, "capabilities": ["attempts": "logical", "request_body": "partial", "response_body": "partial", "transaction_metrics": false]]],
            "capture_policy": ["profile": "development", "body_limit_bytes": 16384,
                               "redact_headers": ["authorization", "cookie", "set-cookie"], "redact_query_keys": [], "redact_body_paths": []],
            "trace_propagation": "disabled", "propagation_origins": []
        ])
        let start = capture.now()
        let actor: [String: Any] = ["owner": "integrator", "component": "NativeTransferDemo", "method": "fetchHealth"]
        capture.emit("http.request.started", at: start, data: [
            "name": "GET \(requestURL.path)", "origin": ["initiator": actor, "executor": actor, "callsite": NSNull()],
            "adapter": Capture.adapter,
            "request": ["method": "GET", "method_source": "configured", "url": requestURL.absoluteString, "url_redacted": false,
                        "headers": Capture.headers([:], partial: true)],
            "attempt": ["index": 0, "visibility": "logical", "reason": "initial", "previous_span_id": NSNull()]
        ], span: true)
        capture.emit("http.body.captured", data: ["direction": "request", "body": Capture.absentBody("no_request_body")], span: true)
        let native = URLSession(configuration: .ephemeral)
        defer { native.finishTasksAndInvalidate() }
        do {
            let (data, response) = try await native.data(from: requestURL)
            guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            capture.emit("http.response.headers", data: ["phase": "final", "response": [
                "status_code": response.statusCode, "status_text": NSNull(), "url": response.url?.absoluteString as Any? ?? NSNull(),
                "url_redacted": false, "headers": Capture.headers(response.allHeaderFields)
            ]], span: true)
            // The UI only offers a public UUID resource and the collector's secret-free health resource.
            capture.emit("http.body.captured", data: ["direction": "response", "body": Capture.body(data, mime: response.mimeType)], span: true)
            let end = capture.now()
            capture.emit("http.ended", at: end, data: ["outcome": response.statusCode < 400 ? "success" : "http_error",
                "application_outcome": "unknown", "status_code": response.statusCode, "duration_ns": String(end - start),
                "end_reason": "body_eof", "error": NSNull()], span: true)
        } catch {
            capture.emit("http.body.captured", data: ["direction": "response", "body": Capture.unavailableBody("request_failed")], span: true)
            let native = error as NSError
            let cancelled = native.domain == NSURLErrorDomain && native.code == NSURLErrorCancelled
            let timeout = native.domain == NSURLErrorDomain && native.code == NSURLErrorTimedOut
            let end = capture.now()
            capture.emit("http.ended", at: end, data: ["outcome": cancelled ? "cancelled" : timeout ? "timeout" : "transport_error",
                "application_outcome": "unknown", "status_code": NSNull(), "duration_ns": String(end - start),
                "end_reason": cancelled ? "cancelled" : "transport_failure",
                "error": ["type": "URLSessionError", "message": "Native error code \(native.code)", "stage": "unknown"]], span: true)
        }
        capture.emit("session.ended", data: ["reason": "completed", "dropped_events": 0])
        let output = directory.appendingPathComponent("\(capture.sessionID).ndjson")
        try capture.output.write(to: output, options: .atomic)
        // Relay the same sanitized file a customer can retain/export. Event identity is unchanged.
        try await sink.relaySanitizedFile(output)
        let status = await sink.flush()
        return Result(captureURL: output, sessionID: capture.sessionID, status: status)
    }

    @MainActor private final class Capture {
        static let adapter = ["name": "customer.manual", "version": "0.1.0"]
        let sessionID = "ios-native-\(UUID().uuidString.lowercased())"
        let recordingID = "ios-recording-\(UUID().uuidString.lowercased())"
        let traceID = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let spanID = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(16))
        let origin = mach_continuous_time()
        var sequence = 0
        var output = Data()
        func now() -> UInt64 {
            var info = mach_timebase_info_data_t()
            mach_timebase_info(&info)
            return UInt64(info.denom).dividingFullWidth((mach_continuous_time() - origin).multipliedFullWidth(by: UInt64(info.numer))).quotient
        }
        func emit(_ kind: String, at supplied: UInt64? = nil, data: [String: Any], span: Bool = false) {
            let ns = supplied ?? now()
            sequence += 1
            let clock = ISO8601DateFormatter()
            clock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var event: [String: Any] = ["schema_version": "1.0", "event_type": kind,
                "event_id": "\(recordingID)/\(sequence)", "session_namespace": "com.example.networklog/development",
                "session_id": sessionID, "recording_id": recordingID, "sequence": sequence,
                "timestamp": clock.string(from: Date()), "monotonic_ns": String(ns), "data": data]
            if span { event["context"] = ["trace_id": traceID, "span_id": spanID, "parent_span_id": NSNull(), "parent_scope": "none"] }
            output.append(try! JSONSerialization.data(withJSONObject: event, options: [.sortedKeys, .withoutEscapingSlashes]))
            output.append(10)
        }
        static func headers(_ fields: [AnyHashable: Any], partial: Bool = false) -> [String: Any] {
            let secretNames = ["authorization", "cookie", "set-cookie"]
            let entries: [[String: Any]] = fields.map { key, value in
                let name = String(describing: key)
                let redacted = secretNames.contains(name.lowercased())
                return ["name": name, "value": redacted ? "[REDACTED]" : String(describing: value), "redacted": redacted]
            }
            return ["availability": partial ? "partial" : "captured", "representation": "library",
                    "order_preserved": false, "entries": entries,
                    "reason": partial ? "application_configured_only" as Any : NSNull()]
        }
        static func absentBody(_ reason: String) -> [String: Any] {
            ["availability": "not_applicable", "representation": "application", "media_type": NSNull(), "charset": NSNull(),
             "content_encoding": NSNull(), "observed_bytes": 0, "total_bytes": 0, "stored_bytes": 0, "truncated": false,
             "redacted": false, "reason": reason, "content": NSNull()]
        }
        static func unavailableBody(_ reason: String) -> [String: Any] {
            var body = absentBody(reason)
            body["availability"] = "unavailable"; body["observed_bytes"] = NSNull(); body["total_bytes"] = NSNull()
            return body
        }
        static func body(_ data: Data, mime: String?) -> [String: Any] {
            let prefix = data.prefix(16384)
            return ["availability": "captured", "representation": "application", "media_type": mime as Any? ?? NSNull(),
                    "charset": NSNull(), "content_encoding": NSNull(), "observed_bytes": data.count, "total_bytes": data.count,
                    "stored_bytes": prefix.count, "truncated": prefix.count < data.count, "redacted": false,
                    "reason": prefix.count < data.count ? "body_limit" as Any : NSNull(),
                    "content": ["encoding": "base64", "data": prefix.base64EncodedString()]]
        }
    }
}
#endif
