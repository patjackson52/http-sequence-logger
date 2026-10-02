#if !DEBUG
#error("DevelopmentDelivery is a Debug-only consumer. Build the separate Production package for the production smoke check.")
#endif
#if DEBUG
import AppLogging
import Foundation
import NetworkLogTransfer

/// This owner writes one rolling canonical history; the producer supplies sanitized schema 1.2 lines.
public actor DevelopmentCaptureDelivery:CaptureDelivery {
    public nonisolated let isEnabled=true
    private let capture:DebugCapture
    public private(set) var diagnostic:String?
    public init(pairingJSON:Data?=nil,directory:URL?=nil) async throws {
        capture=try await DebugCapture.start(appID:"dev.example.external-consumer",directory:directory)
        if let pairingJSON { try await capture.savePairing(pairingJSON) }
    }
    public func appendSanitizedLine(_ makeLine:@Sendable () throws ->String) async {
        do { try await capture.appendSanitizedLine(makeLine());diagnostic=nil }
        catch { diagnostic="capture_admission_failed" }
    }
    public var captureURLs:[URL] { get async { await capture.captureURLs } }
    public func resume() async { await capture.refresh() }
    public func status() async ->TransferStatus { await capture.status() }
    public func flush() async throws { try await capture.flush() }
    @discardableResult public func deliverNow() async ->TransferStatus { await capture.deliverNow() }
    public func close() async { await capture.close() }
}
#endif
