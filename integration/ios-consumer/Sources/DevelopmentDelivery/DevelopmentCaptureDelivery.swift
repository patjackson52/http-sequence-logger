#if !DEBUG
#error("DevelopmentDelivery is a Debug-only consumer. Build the separate Production package for the production smoke check.")
#endif

#if DEBUG
import AppLogging
import Foundation
import NetworkLogTransfer

/// Integration example around the implemented Swift transfer API.
/// The app's producer owns redaction, schema validity, and canonical persistence.
public actor DevelopmentCaptureDelivery: CaptureDelivery {
    public nonisolated let isEnabled = true
    private let sink: NDJSONTransferSink
    public private(set) var diagnostic: String?

    public init(pairingJSON: Data, spoolDirectory: URL) throws {
        let connection = try TransferConnection.parse(json: pairingJSON)
        sink = try NDJSONTransferSink(connection: connection, spoolDirectory: spoolDirectory)
    }

    /// This adapter never moves, rewrites, or deletes the customer's source file.
    public func offerSanitizedFile(_ locateFile: @Sendable () throws -> URL) async {
        do {
            try await sink.relaySanitizedFile(locateFile())
            let result = await sink.flush()
            diagnostic = result.diagnostic
        } catch {
            // Do not replace the app's HTTP result/error or expose pairing/payload data.
            diagnostic = "capture_relay_failed"
        }
    }

    /// Alternative to file relay. Call only after the canonical file accepted this
    /// same sanitized line. Do not feed both paths for each newly emitted event.
    public func appendAlreadyPersistedLine(_ line: String) async {
        do {
            try await sink.appendSanitizedLine(line)
            diagnostic = nil
        } catch {
            diagnostic = "capture_delivery_pending"
        }
    }

    public func resume() async { await sink.resume() }
    public func status() async -> TransferStatus { await sink.status() }
    public func flush() async -> TransferStatus { await sink.flush() }
    public func close() async { await sink.close() }
}
#endif
