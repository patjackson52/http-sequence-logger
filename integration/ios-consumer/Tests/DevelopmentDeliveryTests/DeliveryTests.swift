import DevelopmentDelivery
import Foundation
import Testing

@Test func developmentConsumerCanOpenAndCloseTheRealTransferAPI() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let pairing = Data(#"{"version":1,"endpoint":"http://127.0.0.1:1","token":"fixture-only-token","collector_id":"fixture-collector"}"#.utf8)
    let delivery = try DevelopmentCaptureDelivery(pairingJSON: pairing, spoolDirectory: directory)
    #expect(delivery.isEnabled)
    #expect(await delivery.status().pendingBytes == 0)
    await delivery.resume()
    await delivery.close()
    #expect(await delivery.status().state == .closed)
    // No records were appended; the sink has nothing to send and makes no request.
    #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("events.ndjson").path))
}
