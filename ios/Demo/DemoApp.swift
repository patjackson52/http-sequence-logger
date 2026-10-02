#if !DEBUG
#error("The capture demo is development-only. Archive the NetworkLogProductionApp scheme instead.")
#endif

#if DEBUG
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
    @State private var shareFiles:[URL]=[]
    @State private var browser:CollectorBrowser?
    @State private var candidates:[CollectorCandidate]=[]
    @AppStorage("lastCapturePath") private var lastCapturePath = ""
    @AppStorage("lastCaptureSession") private var lastCaptureSession = ""
    var body: some View {
        NavigationView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Collector pairing")
                SecureField("Paste pairing JSON", text: $pairing)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                Button("Discover collectors") {
                    let discovery=CollectorBrowser()
                    discovery.changed={ candidates=$0 }
                    discovery.diagnostic={ status=$0 }
                    browser?.stop();browser=discovery;discovery.start()
                }
                ForEach(candidates,id:\.collectorID) { candidate in
                    Text("\(candidate.serviceName): https://\(candidate.hostname):\(candidate.port). Pair using the collector's private enrollment JSON.").font(.caption)
                }
                Picker("Demonstration request", selection: $useLocalHealth) {
                    Text("Public UUID (httpbin.org)").tag(false)
                    Text("Local collector health").tag(true)
                }
                Button("Capture and transfer") {
                    running = true
                    Task { @MainActor in
                        defer { running = false }
                        do {
                            let source=try await ManualCaptureDemo.initialize()
                            if !pairing.isEmpty { try await source.savePairing(Data(pairing.utf8)) }
                            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                                .appendingPathComponent("demo-\(UUID().uuidString)")
                            let result = try await ManualCaptureDemo.run(connection: nil,
                                requestURL: URL(string: useLocalHealth ? "http://127.0.0.1:4319/api/v2/health" : "https://httpbin.org/uuid")!, directory: directory)
                            lastCapturePath = result.captureURL.path
                            lastCaptureSession = result.sessionID
                            describe(result.status)
                        } catch { status = "Unable to capture or transfer. Check the pairing and collector." }
                    }
                }.disabled(running)
                HStack {
                    Button("Retry last capture") {
                        running = true
                        Task { @MainActor in
                            defer { running = false }
                            do {
                                let source=try await ManualCaptureDemo.initialize()
                                if !pairing.isEmpty { try await source.savePairing(Data(pairing.utf8)) }
                                await source.refresh()
                                describe(await source.deliverNow())
                            } catch { status = "Retry unavailable. The original capture can still be shared if present." }
                        }
                    }.disabled(running || lastCapturePath.isEmpty)
                    Button("Share retained captures") {
                        Task { if let source=try? await ManualCaptureDemo.initialize() { try? await source.flush();shareFiles=await source.captureURLs;sharing=true } }
                    }
                        .disabled(running || lastCapturePath.isEmpty)
                }
                Text(status).font(.footnote)
                if !lastCaptureSession.isEmpty { Text("Last capture: \(lastCaptureSession)").font(.caption) }
                Spacer()
            }.padding().navigationTitle("Network capture")
                .task {
                    _ = try? await ManualCaptureDemo.initialize()
                    if ProcessInfo.processInfo.environment["NETWORKLOG_RUN"]=="health",let result=try? await ManualCaptureDemo.run(connection:nil,requestURL:URL(string:ProcessInfo.processInfo.environment["NETWORKLOG_REQUEST_URL"] ?? "http://127.0.0.1:4319/api/v2/health")!,directory:FileManager.default.temporaryDirectory) {
                        lastCapturePath=result.captureURL.path;lastCaptureSession=result.sessionID;describe(result.status)
                    }
                }
                .onDisappear { browser?.stop() }
        .sheet(isPresented: $sharing) { CaptureShareSheet(files:shareFiles) }
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
    let files:[URL]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems:files, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#endif
