# iOS development capture transfer

This Swift package implements the [transfer protocol](../docs/transfer/PROTOCOL.md) for already-sanitized schema 1.0/1.1 NDJSON. It includes a runnable iOS application and native URLSession integration tests. It is a transfer sink, not an automatic URLSession interceptor or a complete capture SDK.

For an existing application, use the [agent-oriented iOS integration guide](../docs/integration/IOS.md): local-package installation, capture-producer responsibilities, production exclusion, exact file paths and retrieval. The GitHub repository URL cannot be added as a root remote Swift package; `Package.swift` lives in `ios/`.

Requires Swift 6 and iOS 15+ (macOS 12+ for package tests). Add `ios/` as a local Swift package to your **development app target** and import `NetworkLogTransfer` inside `#if DEBUG`.

## Open the live viewer

From the repository root, with Node 22.12+:

```sh
npm ci
npm start -- --no-android
```

This builds the viewer and starts the collector at **http://127.0.0.1:4319/**. The ordinary browser URL connects automatically and survives refresh; no viewer token link is needed. Keep the collector running. For the Simulator, copy the loopback pairing from **Other devices** or use private `artifacts/collector/connection-loopback.json` in your development setup. The iOS app still requires explicit pairing and a sanitized event producer.

For a physical iPhone, start the collector with `npm start -- --no-android --lan YOUR_DESKTOP_IP` and use the generated HTTPS pairing instead. See [device setup](../docs/transfer/README.md#ios-simulator-and-wi-fi) for reachability, permission and TLS requirements. The browser continues using desktop loopback. **Save capture** exports `artifacts/collector/capture.ndjson`; the demo's canonical files remain under `<Documents>/demo-<UUID>/`. App-supplied events appear as batches arrive; viewer pause/import does not stop native delivery.

## Keep production free of development logging

`project.yml` defines two app targets with separate source membership and dependency graphs:

- `NetworkLogTransferDemo` is the Debug capture/transfer app. It alone depends on `NetworkLogTransfer`; its local-network permission and ATS local-network setting stay in its own Info.plist. Attempting to compile this target in Release fails with a message directing you to the production scheme.
- `NetworkLogProductionApp` is a minimal host for a production integration. It compiles only `Production/`, has no package dependencies, and has no demo screens, pairing resources, capture fixtures, or development network permissions. Archive this scheme for the production example.

The transfer package also compiles its implementation and imports only under `#if DEBUG`. Its Release module exposes no transfer API. This is a compile-time backstop, not a runtime enable flag; do not define `DEBUG` in production. Keep the package out of your production target's dependencies as the example does. XcodeGen's dependency configuration supports platform filters but no Debug/Release dependency filter, so the example uses separate targets ([XcodeGen dependency specification](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md#dependency)).

If your application needs the same logging call sites in both builds, own a tiny facade in your app: the development target supplies a transfer adapter and the production target supplies a no-op implementation with no imports from this package. This repository does not provide an automatic Swift capture SDK.

Verify the actual outputs with:

```sh
node ios/scripts/verify-release-isolation.mjs # from the repository root
```

This builds a Debug demo as a positive control and archives the production app for an iOS device without signing. It checks that the Release build graph contains only the production target, scans the whole `.app` for transfer symbols/strings and development resources, checks linked libraries, rejects development Info.plist keys, and verifies that building the development target in Release fails. The archive, logs, and machine-readable result are saved in `ios/.local/release-isolation/`. This validates the supplied integration; apply equivalent checks to your own shipping app's archive.

## Use with manual logging or an existing file recorder

```swift
let connection = try TransferConnection.parse(json: pastedPairingJSON)
let transfer = try NDJSONTransferSink(
    connection: connection,
    spoolDirectory: applicationSupport.appendingPathComponent("network-log-transfer")
)
await transfer.resume() // Replays any persisted, unacknowledged records after restart.

// Keep the customer's existing networking and redaction code. A recorder can feed
// each sanitized, schema-valid event directly, without switching HTTP clients.
do {
    try await transfer.appendSanitizedLine(sanitizedEventJSON)
} catch {
    // Preserve the original file sink. Transfer failure must not change the request.
}

// Or relay a complete existing sanitized NDJSON file. IDs/timestamps remain intact.
try await transfer.relaySanitizedFile(captureFileURL)
let result = await transfer.flush()
// Inspect result.state/pendingBytes/diagnostic; diagnostics do not contain secrets.
await transfer.close()
```

`appendSanitizedLine` persists and fsyncs before returning, then schedules a small-batch flush within 250 ms. `flush` tries the queued batches and returns on failure; it does not wait through an unbounded retry loop. `resume` starts/restarts background delivery, including after reopening a persisted spool. `close` stops transfer and retains pending data; call `flush` first for a graceful close. Actor isolation serializes appends and acknowledgements. Terminal network/capture semantics belong to the upstream recorder.

The sink checks the event envelope/version but does not implement the complete JSON Schema or perform capture redaction. Apply the recorder's policy **before** calling it. It rejects literal pairing-token inclusion as an additional guard; this is not a substitute for upstream redaction. It never emits transport traffic as capture events. Its private ephemeral URLSession has no custom capture protocols, cookie/credential storage, or cache. Do not wrap the sink's traffic in a separate global network recorder.

## Durability and bounded storage

- Default spool: 8 MiB; batches: at most 1 MiB or 500 events. Limits can be reduced with `TransferLimits`.
- `events.ndjson` contains original event bytes; `cursor.json` binds the acknowledged byte offset to the collector ID and a SHA-256 digest of that exact file prefix. A changed collector or replaced/truncated prefix replays the retained file from the start.
- The cursor advances only after HTTP 200, matching collector identity, and acknowledgement of every submitted event ID. Conflicts, invalid ACKs, redirects, and permanent 4xx errors retain pending data and expose a fixed diagnostic code. Network errors, 408/429, and server errors use capped exponential backoff with jitter.
- A full spool compacts only acknowledged records; it never evicts unacknowledged records. If no space is reclaimable, `spoolFull` rejects new appends so the caller can retain its original file. Keep the canonical capture file if the complete history is needed for export or a different collector later.
- Each directory has an exclusive writer lock. `close` releases it. A partial final append is truncated on reopen; malformed complete records are retained and block transfer for investigation. A storage-write failure requires reopening before more appends.
- File relay reads bounded chunks and only newline-terminated records; an incomplete final line waits for a later relay. Replaying a file retains IDs and relies on collector deduplication. Relay can stop partway if the spool fills; no accepted records are discarded.
- This is foreground development transfer, not an iOS background URLSession service. Suspension retains the spool; call `resume` when the app becomes active. Background scheduling, device lock policy, and full automatic network capture are outside this package.

## Pairing and TLS

Parse the collector's JSON pairing object; do not put its token in URLs or logs. Plain HTTP is allowed only for loopback. Other destinations require HTTPS. Without a pin, URLSession performs normal system trust evaluation.

With `certificate_sha256`, the sink requires the exact leaf DER SHA-256, explicitly checks the leaf validity interval, and evaluates the leaf as a per-connection anchor using `SecPolicyCreateSSL` with the endpoint hostname. Wrong pins, wrong hostnames, expired/not-yet-valid leaves, and failed trust evaluation are rejected. The sink never installs a system trust override, changes ATS globally, or follows HTTP redirects. Credentials go only to the configured ingestion origin. ACK responses are streamed and capped at 2 MiB, including chunked responses without Content-Length; oversized replies cancel the task and retain the spool. The bound accommodates the event IDs and recording metadata acknowledged for a valid 1 MiB batch. Error-page bodies are not read or logged.

The demo declares only `NSAllowsLocalNetworking` and a local-network usage description. It does not enable `NSAllowsArbitraryLoads`. Real-device LAN access may prompt for Local Network permission; pair the collector's HTTPS LAN origin with a certificate matching that hostname/IP. The demo defaults to a public `https://httpbin.org/uuid` request so physical-device pairing requires no source changes. Its picker also offers local collector health for simulator use. It does not accept arbitrary request URLs or credentials. Physical-device Wi-Fi delivery has not been verified in this package's simulator evidence.

The demo saves the canonical NDJSON before attempting delivery. **Share last capture** opens the iOS share sheet for AirDrop, Files, or another customer-selected destination. **Retry last capture** reopens the durable spool and relays that same file without making a new demonstration request or changing event IDs. The last file path/session survives app restarts; pairing tokens are not stored in preferences, so paste pairing again after restarting. Failed transfers display a pending/retained state and offer explicit retry. The one-shot demo closes its sink after each attempt; customers needing continuous delivery keep their sink open and use `resume` as shown above.

Apple references: [custom anchors](https://developer.apple.com/documentation/security/sectrustsetanchorcertificates(_:_:)), [SSL hostname policy](https://developer.apple.com/documentation/security/secpolicycreatessl(_:_:)), and [redirect control](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:)).

## Run and verify

Package unit tests:

```sh
cd ios
swift test
```

With the repository collector running and its connection artifacts written, run the real iOS simulator suite:

```sh
node scripts/run-simulator-tests.mjs \
  --device 7FB095F2-D1D6-4CF4-850E-1AF25FCB6CFD \
  --loopback ../artifacts/transfer/connection-loopback.json \
  --tls ../artifacts/transfer/connection-lan.json
```

The script requires Xcode and XcodeGen, creates a gitignored pairing resource with mode 0600, generates the demo project, and runs app-hosted XCTest on the named simulator. It saves the build log, xcresult bundle, and native capture files under `ios/.local/`. Pairing files/build products are development secrets and are excluded from Git. To open the app manually, run `xcodegen generate`, open `NetworkLogTransferDemo.xcodeproj`, and select the `NetworkLogTransferDemo` scheme in Debug. The optional `.local/IntegrationConfig.json` is only a test-bundle resource; missing or disabled configuration skips collector integration tests. The app accepts pasted pairing JSON and has a Capture and transfer button.

The integration tests make real `URLSession` health requests, manually generate seven-event capture sessions, and upload them over loopback HTTP and pinned HTTPS. They also verify mismatched-pin rejection, no redirect following, acceptance of a valid Unicode-ID batch whose ACK exceeds 512 KiB, rejection of a chunked ACK larger than 2 MiB, and automatic recovery from an actual refused connection when a local forwarding listener appears. The recovery test checks unchanged capture bytes and persisted ACK state after closing/reopening the sink. All unit tests also run on iOS, including hostname/date/pin trust checks. No UI automation or macOS-only fixture replay substitutes for that iOS evidence.

Use the root validator on the copied native files:

```sh
node ../validate.mjs .local/evidence/<run-id>/*.ndjson
```

The demo offers only the public UUID and secret-free collector health endpoints; native integration tests use local health for reproducibility. Its small manual recorder shows the integration path; arbitrary customer payloads require the upstream capture/redaction policy described above.
