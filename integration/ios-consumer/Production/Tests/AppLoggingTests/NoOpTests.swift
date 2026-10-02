import AppLogging
import Testing

@Test func disabledDeliveryDoesNotEvaluateLineSupplier() async {
    let delivery: any CaptureDelivery = NoOpCaptureDelivery()
    #expect(!delivery.isEnabled)
    await delivery.appendSanitizedLine {
        Issue.record("The disabled delivery evaluated its supplier")
        throw UnexpectedEvaluation()
    }
}

private struct UnexpectedEvaluation: Error {}
