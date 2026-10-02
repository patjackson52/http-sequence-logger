/// App-owned abstraction for already-sanitized capture admission.
public protocol CaptureDelivery: Sendable {
    var isEnabled: Bool { get }
    func appendSanitizedLine(_ makeLine:@Sendable () throws ->String) async
}
public struct NoOpCaptureDelivery:CaptureDelivery {
    public let isEnabled=false
    public init() {}
    public func appendSanitizedLine(_ makeLine:@Sendable () throws ->String) async {}
}
