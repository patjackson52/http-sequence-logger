import Foundation

/// App-owned abstraction for delivery of an existing, sanitized canonical capture.
/// Producing schema events and writing that file are separate app responsibilities.
public protocol CaptureDelivery: Sendable {
    var isEnabled: Bool { get }
    func offerSanitizedFile(_ locateFile: @Sendable () throws -> URL) async
}

public struct NoOpCaptureDelivery: CaptureDelivery {
    public let isEnabled = false
    public init() {}
    public func offerSanitizedFile(_ locateFile: @Sendable () throws -> URL) async {
        // Do not evaluate metadata/file suppliers in production.
    }
}
