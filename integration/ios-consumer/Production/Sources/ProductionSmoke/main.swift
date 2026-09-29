import AppLogging

@main struct ProductionSmoke {
    static func main() async {
        let delivery: any CaptureDelivery = NoOpCaptureDelivery()
        precondition(!delivery.isEnabled)
        await delivery.offerSanitizedFile {
            fatalError("Production must not inspect capture files")
        }
        print("Production no-op passed")
    }
}
