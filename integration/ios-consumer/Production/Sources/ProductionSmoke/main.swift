import AppLogging

@main struct ProductionSmoke {
    static func main() async {
        let delivery: any CaptureDelivery = NoOpCaptureDelivery()
        precondition(!delivery.isEnabled)
        await delivery.appendSanitizedLine {
            fatalError("Production must not evaluate capture suppliers")
        }
        print("Production no-op passed")
    }
}
