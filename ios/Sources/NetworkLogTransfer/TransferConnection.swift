#if DEBUG
import Foundation

/// A development collector pairing. Its secret is deliberately omitted from descriptions.
public struct TransferConnection: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let endpoint: URL
    public let collectorID: String
    public let sourceID: String
    public let certificateSHA256: String?
    let token: String

    public var description: String { "TransferConnection(paired collector, token: <redacted>)" }
    public var debugDescription: String { description }

    public func encoded() throws -> Data {
        var value:[String:Any] = ["version":2,"endpoint":endpoint.absoluteString,"collector_id":collectorID,"source_id":sourceID,"source_token":token]
        value["certificate_sha256"] = certificateSHA256
        return try JSONSerialization.data(withJSONObject:value)
    }
    public static func parse(json: Data) throws -> TransferConnection {
        struct Wire: Decodable {
            let version: Int
            let endpoint: String
            let source_token: String
            let source_id: String
            let collector_id: String
            let certificate_sha256: String?
        }
        guard let wire = try? JSONDecoder().decode(Wire.self, from: json), wire.version == 2,
              !wire.source_token.isEmpty, wire.source_token.utf8.count <= 4096,
              wire.source_token.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }),
              !wire.source_id.isEmpty, wire.source_id.utf8.count <= 512, !wire.collector_id.isEmpty, wire.collector_id.utf8.count <= 512,
              let parts = URLComponents(string: wire.endpoint),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!),
              let endpoint = parts.url else { throw TransferError.invalidConnection }
        guard scheme == "https" || isLoopback(host) else { throw TransferError.insecureEndpoint }
        if let pin = wire.certificate_sha256 {
            guard scheme == "https", pin.count == 64,
                  pin.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw TransferError.invalidConnection }
        }
        return TransferConnection(endpoint: endpoint, collectorID: wire.collector_id,
                                  sourceID: wire.source_id, certificateSHA256: wire.certificate_sha256, token: wire.source_token)
    }

    static func isLoopback(_ host: String) -> Bool {
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host == "::1" { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts[0] == "127" && parts.allSatisfy {
            !$0.isEmpty && $0.allSatisfy(\.isNumber) && Int($0).map { (0...255).contains($0) } == true
        }
    }
}

public enum TransferError: String, Error, Sendable, CustomStringConvertible {
    case invalidConnection, insecureEndpoint, invalidEvent, eventTooLarge, spoolFull, spoolBusy
    case storageFailure, closed, invalidLimits
    public var description: String { rawValue }
}

public struct TransferLimits: Sendable {
    public var maximumSpoolBytes: Int = 8 * 1024 * 1024
    public var maximumBatchBytes: Int = 1024 * 1024
    public var maximumBatchEvents: Int = 500
    public var flushDelay: TimeInterval = 0.25
    public var initialRetryDelay: TimeInterval = 0.5
    public var maximumRetryDelay: TimeInterval = 30
    public init() {}
}

public struct TransferStatus: Sendable, Equatable {
    public enum State: String, Sendable { case idle, queued, sending, retrying, blocked, closed }
    public let state: State
    public let pendingBytes: Int
    /// A fixed diagnostic code; never an NSError description, response payload, or token.
    public let diagnostic: String?
    public let lastHTTPStatus: Int?
}
#endif
