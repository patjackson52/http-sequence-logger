import SwiftUI
import NetworkLogTransfer
import UIKit

@main struct NetworkLogTransferDemoApp: App {
    var body: some Scene { WindowGroup { DemoView() } }
}

private struct DemoView: View {
    @State private var pairing = ""
    @State private var status = "Paste a collector pairing JSON. This demo records a real request to the selected public demonstration endpoint."
    @State private var useLocalHealth = false
    @State private var running = false
    @State private var sharing = false
    @AppStorage("lastCapturePath") private var lastCapturePath = ""
    @AppStorage("lastCaptureSession") private var lastCaptureSession = ""
    var body: some View {
        NavigationView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Collector pairing")
                SecureField("Paste pairing JSON", text: $pairing)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                Picker("Demonstration request", selection: $useLocalHealth) {
                    Text("Public UUID (httpbin.org)").tag(false)
                    Text("Local collector health").tag(true)
                }
                Button("Capture and transfer") {
                    running = true
                    Task { @MainActor in
                        defer { running = false }
                        do {
                            let connection = try TransferConnection.parse(json: Data(pairing.utf8))
                            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                                .appendingPathComponent("demo-\(UUID().uuidString)")
                            let result = try await ManualCaptureDemo.run(connection: connection,
                                requestURL: URL(string: useLocalHealth ? "http://127.0.0.1:4319/api/v1/health" : "https://httpbin.org/uuid")!, directory: directory)
                            lastCapturePath = result.captureURL.path
                            lastCaptureSession = result.sessionID
                            describe(result.status)
                        } catch { status = "Unable to capture or transfer. Check the pairing and collector." }
                    }
                }.disabled(running || pairing.isEmpty)
                HStack {
                    Button("Retry last capture") {
                        running = true
                        Task { @MainActor in
                            defer { running = false }
                            do {
                                let file = URL(fileURLWithPath: lastCapturePath)
                                let connection = try TransferConnection.parse(json: Data(pairing.utf8))
                                let transfer = try NDJSONTransferSink(connection: connection,
                                    spoolDirectory: file.deletingLastPathComponent().appendingPathComponent("spool"))
                                do {
                                    // Replaying the canonical file preserves every ID; the collector deduplicates.
                                    try await transfer.relaySanitizedFile(file)
                                    let result = await transfer.flush()
                                    await transfer.close()
                                    describe(result)
                                } catch {
                                    await transfer.close()
                                    throw error
                                }
                            } catch { status = "Retry unavailable. The original capture can still be shared if present." }
                        }
                    }.disabled(running || pairing.isEmpty || lastCapturePath.isEmpty)
                    Button("Share last capture") { sharing = true }
                        .disabled(running || lastCapturePath.isEmpty)
                }
                Text(status).font(.footnote)
                if !lastCaptureSession.isEmpty { Text("Last capture: \(lastCaptureSession)").font(.caption) }
                Spacer()
            }.padding().navigationTitle("Network capture")
                .sheet(isPresented: $sharing) { CaptureShareSheet(file: URL(fileURLWithPath: lastCapturePath)) }
        }
    }

    private func describe(_ transfer: TransferStatus) {
        if transfer.state == .idle { status = "Delivered. The original NDJSON is available to share." }
        else {
            status = "Delivery pending (\(transfer.diagnostic ?? transfer.state.rawValue)); \(transfer.pendingBytes) bytes retained. Retry or share the capture."
        }
    }
}

private struct CaptureShareSheet: UIViewControllerRepresentable {
    let file: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [file], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
