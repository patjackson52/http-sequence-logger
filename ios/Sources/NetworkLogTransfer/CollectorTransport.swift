#if DEBUG
import Foundation
import CryptoKit
import Security

struct UploadResponse: Sendable { let status: Int; let body: Data }
enum CollectorResponseError: Error { case acknowledgementTooLarge }
enum TransferProtocolLimits {
    // ACKs echo event IDs and recording metadata; valid 1 MiB batches can exceed 512 KiB here.
    static let maximumAcknowledgementBytes = 2 * 1024 * 1024
}
protocol BatchTransport: Sendable {
    func upload(_ bytes: Data) async throws -> UploadResponse
    func close()
}

/// The sink owns a dedicated, uninstrumented session. No shared delegate or global URLProtocol registration.
final class CollectorTransport: NSObject, BatchTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private let connection: TransferConnection
    private var session: URLSession!

    init(connection: TransferConnection) {
        self.connection = connection
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCredentialStorage = nil
        configuration.protocolClasses = []
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func upload(_ bytes: Data) async throws -> UploadResponse {
        var request = URLRequest(url: connection.endpoint.appendingPathComponent("api/v1/events"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Content-Type")
        request.httpBody = bytes
        let (stream, response) = try await session.bytes(for: request, delegate: self)
        var completed = false
        defer { if !completed { stream.task.cancel() } }
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        // Error pages are never consumed or surfaced as diagnostics. A chunked/misreported ACK
        // cannot bypass this bound: count application bytes while receiving, not just Content-Length.
        guard response.statusCode == 200 else { return UploadResponse(status: response.statusCode, body: Data()) }
        let maximumACKBytes = TransferProtocolLimits.maximumAcknowledgementBytes
        guard response.expectedContentLength <= maximumACKBytes else { throw CollectorResponseError.acknowledgementTooLarge }
        var data = Data()
        data.reserveCapacity(min(maximumACKBytes, max(0, Int(response.expectedContentLength))))
        for try await byte in stream {
            guard data.count < maximumACKBytes else { throw CollectorResponseError.acknowledgementTooLarge }
            data.append(byte)
        }
        completed = true
        return UploadResponse(status: response.statusCode, body: data)
    }

    func close() { session.invalidateAndCancel() }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler: completionHandler)
    }

    private func handle(_ challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let pin = connection.certificateSHA256 else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let trust = challenge.protectionSpace.serverTrust,
              let host = connection.endpoint.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")),
              PairedTrust.accepts(trust: trust, host: host, pin: pin) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

enum PairedTrust {
    static func accepts(trust: SecTrust, host: String, pin: String, now: Date = Date()) -> Bool {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return false }
        let der = SecCertificateCopyData(leaf) as Data
        guard sha256(der) == pin, let validity = CertificateValidity.read(der),
              validity.start <= now, now <= validity.end else { return false }
        // The explicitly paired leaf is a per-connection anchor. SSL hostname and usage policies remain active.
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [leaf] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              SecTrustSetVerifyDate(trust, now as CFDate) == errSecSuccess else { return false }
        return SecTrustEvaluateWithError(trust, nil)
    }
}

func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

/// Reads only the DER certificate validity fields; trust/identity/signature evaluation remains Security.framework's job.
/// An explicit anchor can be exempt from root expiry checks, so leaf dates are checked independently.
enum CertificateValidity {
    struct Window { let start: Date; let end: Date }
    struct TLV { let tag: UInt8; let content: Range<Int>; let next: Int }
    static func read(_ der: Data) -> Window? {
        let bytes = [UInt8](der)
        guard let certificate = tlv(bytes, at: 0), certificate.tag == 0x30, certificate.next == bytes.count,
              let tbs = tlv(bytes, at: certificate.content.lowerBound), tbs.tag == 0x30 else { return nil }
        var offset = tbs.content.lowerBound
        if let version = tlv(bytes, at: offset), version.tag == 0xa0 { offset = version.next }
        // serialNumber, signature, issuer
        for _ in 0..<3 {
            guard let field = tlv(bytes, at: offset), field.next <= tbs.content.upperBound else { return nil }
            offset = field.next
        }
        guard let validity = tlv(bytes, at: offset), validity.tag == 0x30, validity.next <= tbs.content.upperBound,
              let first = tlv(bytes, at: validity.content.lowerBound),
              let last = tlv(bytes, at: first.next), last.next == validity.content.upperBound,
              let start = date(bytes, field: first), let end = date(bytes, field: last), start <= end else { return nil }
        return Window(start: start, end: end)
    }
    static func tlv(_ bytes: [UInt8], at offset: Int) -> TLV? {
        guard offset >= 0, offset + 2 <= bytes.count else { return nil }
        var cursor = offset + 2
        var length = Int(bytes[offset + 1])
        if length & 0x80 != 0 {
            let count = length & 0x7f
            guard (1...4).contains(count), cursor + count <= bytes.count, bytes[cursor] != 0 else { return nil }
            length = 0
            for byte in bytes[cursor..<(cursor + count)] { length = length * 256 + Int(byte) }
            guard length >= 128 else { return nil }
            cursor += count
        }
        guard length <= bytes.count - cursor else { return nil }
        return TLV(tag: bytes[offset], content: cursor..<(cursor + length), next: cursor + length)
    }
    static func date(_ bytes: [UInt8], field: TLV) -> Date? {
        let raw = String(decoding: bytes[field.content], as: UTF8.self)
        let yearLength: Int
        if field.tag == 0x17 && raw.utf8.count == 13 { yearLength = 2 }
        else if field.tag == 0x18 && raw.utf8.count == 15 { yearLength = 4 }
        else { return nil }
        guard raw.last == "Z", raw.dropLast().allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        let chars = Array(raw)
        func number(_ from: Int, _ size: Int = 2) -> Int { Int(String(chars[from..<(from + size)]))! }
        var year = number(0, yearLength)
        if yearLength == 2 { year += year >= 50 ? 1900 : 2000 }
        let values = DateComponents(timeZone: TimeZone(secondsFromGMT: 0), year: year,
                                    month: number(yearLength), day: number(yearLength + 2),
                                    hour: number(yearLength + 4), minute: number(yearLength + 6), second: number(yearLength + 8))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let date = calendar.date(from: values), calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date) ==
                DateComponents(year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second) else { return nil }
        return date
    }
}
#endif
