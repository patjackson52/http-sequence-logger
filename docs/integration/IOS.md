# Integrate into an existing iOS app

Start with the [integration checklist](README.md). This guide targets Swift 6 and iOS 15+. Keep the application's existing URLSession/custom-client behavior and add observation at boundaries it already exposes.

## 1. Choose the actual integration route

| Repository capability | Status and action |
| --- | --- |
| `NetworkLogTransfer` Swift package | Implemented: durable transfer of sanitized schema 1.0/1.1 NDJSON, including existing files |
| Full Swift HTTP/session/operation/handler recorder | Not implemented: use an existing compatible producer or implement an app-owned adapter against the contract |
| `ios/Demo/ManualCaptureDemo.swift` | Private, one-request demonstration; not a public SDK or general-purpose recorder |
| Swift recorder snippets in `MANUAL-LOGGING.md` | Proposed APIs; do not import or call these methods as if the package provides them |
| Collector and web viewer | Implemented: shared with Android; desktop setup in [TRANSPORT.md](TRANSPORT.md) |

If the app already produces compatible sanitized NDJSON, installation and transfer integration are small. If it has only ordinary console logs or unstructured request strings, creating a schema-valid capture producer is additional implementation work. State that explicitly in the integration plan and verification report. Do not claim automatic URLSession capture after installing the transfer package.

The demo only observes a secret-free allowlisted GET, buffers the response, uses a single HTTP span and schema 1.0, and does not provide handler spans or transaction metrics. Its `try!` serialization, hardcoded producer values, body handling, and limited redaction are unsuitable as a general customer recorder. Use it to understand the event flow, not as a drop-in capture SDK.

## 2. Pin the repository and add the local package

The GitHub repository root has **no `Package.swift`**. Xcode's remote-package URL entry cannot select its `ios/` subdirectory. Keep a pinned checkout/submodule in the customer's repository using its existing dependency policy, then add **that checkout's `ios/` directory** as a local Swift package.

For example, with the checkout at `third_party/http-sequence-logger`:

1. Record the reviewed Git commit in the submodule or dependency lock documentation. Do not rely on an unpinned moving `main` checkout.
2. In Xcode, use **Add Local…** in package dependencies and select `third_party/http-sequence-logger/ios`.
3. Add the `NetworkLogTransfer` product to the **development app target only**.
4. Put `import NetworkLogTransfer` and the adapter in development-only sources under `#if DEBUG`.

For a Swift package development consumer, use `.package(path: "<relative-path-to-checkout>/ios")`. The [compiled external fixture](../../integration/ios-consumer/Package.swift) shows the exact dependency and product syntax for its directory layout. There is no published Swift capture SDK version or remote root package to substitute.

## 3. Establish the production boundary first

Use separate development and production app targets/schemes with controlled dependency and source membership, following [ios/project.yml](../../ios/project.yml). Preserve the customer's entitlements, signing, resources, and existing build configuration conventions when establishing that split.

- Development target: `NetworkLogTransfer`, the capture producer, development adapter, pairing UI/configuration, and development network permissions.
- Production target: a small app-owned abstraction and no-op only. No transfer package dependency, capture implementation, pairing files/UI, test fixtures, or development-only permissions/resources.
- Shared business code: invokes the app-owned abstraction without importing `NetworkLogTransfer`. The production no-op must not evaluate metadata/body/file suppliers, serialize events, create IDs, write files, or change callback execution.

The package itself compiles its implementation only under `#if DEBUG`; its Release module has no transfer API. This is a backstop, not sufficient dependency isolation by itself. Ensure custom development configurations compile both the app adapter and package with Debug settings/`DEBUG`, and shipping configurations do not. An app-only compilation define cannot restore APIs excluded when compiling the package; inspect the dependency's build settings if types are missing. Do not add `DEBUG` to production to fix missing types, or treat a runtime `enabled = false` switch as a dependency boundary. XcodeGen's package dependency declaration does not offer a Debug/Release configuration filter; the sample uses separate targets.

The [external consumer fixture](../../integration/ios-consumer/README.md) compiles one delivery abstraction in both development and independent production packages. It covers **delivery**, not a full capture abstraction. The app must also exclude or no-op the event producer itself so production does not construct events before calling a disabled delivery sink.

## 4. Define canonical file and spool paths

The Swift package has **no default capture path and no canonical file recorder**. The app supplies `spoolDirectory`. Choose stable app-owned paths and document them in the customer's integration notes. A recommended convention is:

```text
<app data container>/Library/Application Support/HTTPSequenceLogger/
  captures/<recording-id>.ndjson       # canonical, sanitized capture; app-owned
  spool/events.ndjson                 # retained delivery records; package-owned
  spool/cursor.json                   # acknowledgement offset and collector binding
  spool/writer.lock                   # one active sink per directory
```

This is a recommendation, not an SDK default. Keep generated filenames safe; opaque caller IDs are not filesystem paths. Use app-private storage, exclude the capture/spool directory from backups with `URLResourceValues.isExcludedFromBackup`, and choose a bounded retention policy for canonical files. Keep event order and durable file appends serialized; do not perform file I/O on the UI thread.

The existing demo uses a different path: `<app data container>/Documents/demo-<UUID>/<session_id>.ndjson`, with its spool in the sibling `spool/` directory. It saves the last capture path for its share/retry controls. The package's spool can compact **acknowledged** records, so `exportSpool()` is not a guarantee of complete capture history. Retain the canonical file for sharing, offline viewer import, or delivery to another collector.

Capture and transfer failures must not replace the application's HTTP response, error, cancellation, or handler result. Persist the sanitized event in the canonical file first; then attempt transfer. Queue delivery outside the application's completion path so a collector outage cannot delay its callback. If the spool is full or its write fails, preserve the canonical file and expose a fixed development diagnostic. Do not report successful delivery when records remain pending.

## 5. Wire the implemented transfer API

Start the desktop collector and obtain pairing JSON as described in [TRANSPORT.md](TRANSPORT.md). Treat the JSON as private development configuration. The package does not auto-discover the desktop or read pairing preferences/files for the app.

The following names are implemented package APIs. `pairingJSON`, `spoolDirectory`, and `canonicalCaptureURL` are app-provided values:

```swift
#if DEBUG
import Foundation
import NetworkLogTransfer

func deliverExistingCapture(
    pairingJSON: Data,
    spoolDirectory: URL,
    canonicalCaptureURL: URL
) async throws -> TransferStatus {
    let connection = try TransferConnection.parse(json: pairingJSON)
    let transfer = try NDJSONTransferSink(
        connection: connection,
        spoolDirectory: spoolDirectory
    )
    do {
        await transfer.resume()
        try await transfer.relaySanitizedFile(canonicalCaptureURL)
        let result = await transfer.flush()
        await transfer.close()
        return result
    } catch {
        await transfer.close()
        throw error
    }
}
#endif
```

Catch this function's errors at the development logging boundary, separately from the application's networking control flow. The original canonical file remains the fallback. Do not open a new sink for every request; this one-shot example relays an existing file. For continuous logging, keep one actor sink open for its spool directory and choose one primary feed:

- **Live append:** after the canonical writer persists a sanitized, schema-valid event, call `try await transfer.appendSanitizedLine(line)`. The line is one UTF-8 JSON object; the sink adds its newline. Appending persists before returning and schedules delivery within 250 ms.
- **Existing file relay:** call `try await transfer.relaySanitizedFile(fileURL)`. Only complete newline-terminated records are relayed. Replaying preserves IDs; collector deduplication makes repeats safe. Do not parse/reconstruct events or regenerate timestamps for retries.

Do not ordinarily append and relay every event through both paths: it creates avoidable duplicate spool data. File replay is useful for recovery after a failed append. Large relays may stop when the bounded spool fills; keep the canonical file, drain/retry, and never delete unacknowledged data to make room.

On reopening a persisted spool or returning to foreground, call `await transfer.resume()`. `flush()` attempts the queued batches and returns status on failure; it does not wait through an unlimited retry loop. `close()` stops delivery and releases the writer lock while retaining pending data. Call `flush()` before a graceful close if delivery is desired. Inspect `status().state`, `pendingBytes`, `diagnostic`, and `lastHTTPStatus`; `blocked` may need corrected pairing/input and an explicit `resume`, while transient failures retry with backoff. This is foreground development transfer, not an iOS background URLSession service.

The package checks the envelope/version and rejects literal pairing-token inclusion, but does **not** perform full JSON Schema validation or capture redaction. Apply redaction before any canonical/spool write. Its private transfer URLSession deliberately avoids capture protocols; do not include collector uploads in a global network recorder.

## 6. If an event producer is needed

Use [SPECS.md](SPECS.md) to find the normative contract, standalone per-event JSON Schema, relationship validator, and handler fixtures. An app-owned URLSession/custom-client adapter must satisfy the following:

- Generate a recording ID for each continuous recording period; accept or generate the logging session ID, preserving its configured namespace. Reuse the caller's session ID intentionally, not as an event or span ID.
- Serialize sequence allocation and monotonic timestamp sampling. Emit `session.started` as sequence 1 at monotonic 0. Use continuous elapsed time (for example `mach_continuous_time()` converted with its timebase), decimal strings for nanoseconds, and wall time only for the separate timestamp. Do not compare monotonic origins across recordings.
- Capture the configured method/URL/headers before dispatch and mark application-only headers partial. URLSession exposes library-normalized metadata; do not claim wire bytes, original header ordering, or invisible redirects/retries. If only one logical task is observed, declare logical attempt visibility.
- Observe existing callbacks or async boundaries without replacing the HTTP client, delegate, authentication flow, scheduling, retries, or cancellation behavior. Preserve original callback arguments/count and result/error identity. Read already-available bytes; never consume or replay a stream just for logging.
- Capture available HTTP response metadata before reporting a completion-handler transport error. An HTTP error status is distinct from a transport failure. For streaming APIs, receiving headers is not body completion; retain partial data and end only at the observed EOF/close/failure/cancellation boundary. Unknown data stays explicitly unavailable, not an invented empty body or success.
- Bound body snapshots and redact headers, URL query values, bodies, effective URLs, and optional metrics **before persistence**. If safe structured redaction cannot be performed, omit content with an explicit reason. The demo's limited endpoint-specific policy is insufficient for arbitrary customer data.
- Record the actual initiator/executor component and integrator/SDK ownership. Propagate parent context explicitly through async callbacks. Do not infer ancestry from URLs, timing, or threads.
- For SDK → app handler → SDK transitions, emit the schema **1.1** handler operation fields and explicit `returned`/`threw`/`cancelled`/`observation_stopped` completion described in [HANDLER-TRACING.md](../../HANDLER-TRACING.md). Parent app HTTP calls to the handler span, preserve its actual integrator executor, and invoke the handler exactly once. A missing end is incomplete observation. All events in one recording use the same schema version; do not add handler fields to a 1.0 recording.

Do not enable outbound trace headers by default. Cross-server correlation requires an explicit propagation policy and supporting server instrumentation; it is separate from the local session ID and delivery pairing.

## 7. Retrieve files and inspect the viewer

For the Simulator, discover the actual simulator and bundle ID rather than copying the repository's test device UUID:

```sh
xcrun simctl list devices available
```

Set `SIMULATOR_ID` and `APP_BUNDLE_ID` to the app under test, then inspect its data container:

```sh
APP_DATA=$(xcrun simctl get_app_container "$SIMULATOR_ID" "$APP_BUNDLE_ID" data)
rg --files "$APP_DATA/Library/Application Support/HTTPSequenceLogger/captures"
```

That final path assumes the recommendation in section 4. Use the customer's actual configured path; for the supplied demo, inspect `$APP_DATA/Documents`. Copy the desired canonical `.ndjson` into the checkout's ignored `artifacts/` directory, then run:

```sh
node validate.mjs /absolute/path/to/copied-capture.ndjson
```

For a physical device, provide a development **Share capture** action using the canonical file URL and the system share sheet. The sample's **Share last capture** supports this path. Do not promise `adb`, `simctl`, or unrestricted filesystem access for physical iPhones.

For live viewing, run `npm ci` and `npm start -- --no-android` in the logger checkout. It builds/opens **http://127.0.0.1:4319/**; the ordinary URL auto-connects and survives refresh. The iOS producer still needs explicit loopback pairing for Simulator or paired LAN HTTPS for a physical phone, available under **Other devices**. Automatic browser connection does not install capture hooks or pair the app. Keep the collector running, exercise the flow, and confirm arriving events, the correct session, domains, request/response details and handler boundaries.

**Save capture** downloads the desktop `artifacts/collector/capture.ndjson` journal. **Pause live** or file import pauses browser updates; **Resume live** returns to the collector. You can also import the canonical app file in the file-only viewer at `4173`. A collector disconnect is a connection status, not a synthetic HTTP failure. [TRANSPORT.md](TRANSPORT.md) covers device pairing, private configuration, permissions, retries and log paths.

## 8. Verify the customer's integration

First run the repository's external consumer smoke check:

```sh
scripts/check-ios-integration.sh
```

It compiles the real transfer API from a local dependency, tests an empty-spool lifecycle, compiles/tests/runs a separate dependency-free production package, checks the lazy no-op and transfer-symbol absence, and rejects accidental Release compilation of the development fixture. Reports are in `artifacts/integration-ios/`. This is a **macOS host API check**, not proof of iOS linking, capture correctness, or real delivery.

Then verify the actual customer app:

1. Build its development target for the selected Simulator/device. Make a real request through the existing client, a custom/manual request, and relevant SDK/app handler calls. Preserve its normal behavior and callbacks.
2. Record and retrieve the app's canonical path and session ID. Validate the emitted file structurally and semantically; inspect it in the viewer. Do not treat a supplied synthetic sample as evidence of native app capture.
3. Pair and deliver to the collector. Temporarily make the collector unavailable, keep the canonical file, reopen/resume delivery, and verify matching event IDs without conflicts or invented request failures. Exercise manual share/import as the fallback.
4. Archive the customer's **actual shipping scheme/configuration**. Verify no transfer package target/dependency, development sources/resources, pairing data, capture fixtures, or development-only Info.plist/entitlement changes enter its build. Inspect the archive's linked libraries, symbols, and resources. A no-op test or a `#if DEBUG` grep alone is insufficient.
5. Report the exact commands, simulator/device, captured file, session ID, viewer result, and production artifact checked. Never include pairing tokens. Mark untested physical-device permissions/reachability explicitly.

The repository's `swift test --package-path ios`, [native Simulator runner](../../ios/scripts/run-simulator-tests.mjs), and `node ios/scripts/verify-release-isolation.mjs` provide package/sample evidence. The native runner needs a running collector, explicit loopback/TLS pairing paths, Xcode/XcodeGen, and a discovered Simulator ID. Its sample archive audit does not replace inspection of the customer's app archive. See [ios/README.md](../../ios/README.md) for these checks and current platform limits.
