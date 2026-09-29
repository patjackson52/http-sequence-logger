import AppLogging
import Testing

@Test func disabledDeliveryDoesNotEvaluateFileSupplier() async {
    let delivery: any CaptureDelivery = NoOpCaptureDelivery()
    #expect(!delivery.isEnabled)
    await delivery.offerSanitizedFile {
        Issue.record("The disabled delivery evaluated its supplier")
        throw UnexpectedEvaluation()
    }
}

private struct UnexpectedEvaluation: Error {}
