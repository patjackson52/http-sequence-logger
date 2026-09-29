# iOS development capture transfer

This Swift package implements the [transfer protocol](../docs/transfer/PROTOCOL.md) for already-sanitized schema 1.0/1.1 NDJSON. It includes a runnable iOS application and native URLSession integration tests. It is a transfer sink, not an automatic URLSession interceptor or a complete capture SDK.

Requires Swift 6 and iOS 15+ (macOS 12+ for package tests). Add `ios/` as a local Swift package and import `NetworkLogTransfer`.

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

With `certificate_sha256`, the sink requires the exact leaf DER SHA-256, explicitly checks the leaf validity interval, and evaluates the leaf as a per-connection anchor using `SecPolicyCreateSSL` with the endpoint hostname. Wrong pins, wrong hostnames, expired/not-yet-valid leaves, and failed trust evaluation are rejected. The sink never installs a system trust override, changes ATS globally, or follows HTTP redirects. Credentials go only to the configured ingestion origin. ACK responses are streamed and capped at 512 KiB, including chunked responses without Content-Length; oversized replies cancel the task and retain the spool. Error-page bodies are not read or logged.

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

The script requires Xcode and XcodeGen, creates a gitignored pairing resource with mode 0600, generates the demo project, and runs app-hosted XCTest on the named simulator. It saves the build log, xcresult bundle, and native capture files under `ios/.local/`. Pairing files/build products are development secrets and are excluded from Git. To open the app manually, run `xcodegen generate` after creating `.local/IntegrationConfig.json` containing `{"enabled":false}`, then open `NetworkLogTransferDemo.xcodeproj`. The app accepts pasted pairing JSON and has a Capture and transfer button.

The integration tests make real `URLSession` health requests, manually generate seven-event capture sessions, and upload them over loopback HTTP and pinned HTTPS. They also verify mismatched-pin rejection, no redirect following, rejection of an oversized chunked ACK, and automatic recovery from an actual refused connection when a local forwarding listener appears. The recovery test checks unchanged capture bytes and persisted ACK state after closing/reopening the sink. All unit tests also run on iOS, including hostname/date/pin trust checks. No UI automation or macOS-only fixture replay substitutes for that iOS evidence.

Use the root validator on the copied native files:

```sh
node ../validate.mjs .local/evidence/<run-id>/*.ndjson
```

The demo offers only the public UUID and secret-free collector health endpoints; native integration tests use local health for reproducibility. Its small manual recorder shows the integration path; arbitrary customer payloads require the upstream capture/redaction policy described above.
