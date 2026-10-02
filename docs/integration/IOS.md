# Integrate into an existing iOS app

Start with the [integration checklist](README.md). This guide targets Swift 6 and iOS 15+. Keep the application's existing URLSession/custom-client behavior and add observation at boundaries it already exposes.

## 1. Choose the actual integration route

| Repository capability | Status and action |
| --- | --- |
| `NetworkLogTransfer` Swift package | Implemented: canonical schema 1.2 journaling, debug discovery/bootstrap and source-scoped version 2 transfer |
| Full Swift HTTP/session/operation/handler recorder | Not implemented: use an existing compatible producer or implement an app-owned adapter against the contract |
| `ios/Demo/ManualCaptureDemo.swift` | Private, one-request demonstration; not a public SDK or general-purpose recorder |
| Swift recorder snippets in `MANUAL-LOGGING.md` | Proposed APIs; do not import or call these methods as if the package provides them |
| Collector and web viewer | Implemented: shared with Android; desktop setup in [TRANSPORT.md](TRANSPORT.md) |

If the app already produces compatible sanitized NDJSON, installation and transfer integration are small. If it has only ordinary console logs or unstructured request strings, creating a schema-valid capture producer is additional implementation work. State that explicitly in the integration plan and verification report. Do not claim automatic URLSession capture after installing the transfer package.

The demo manually observes a secret-free allowlisted GET and emits schema 1.2 events incrementally to the canonical journal. It illustrates transfer and discovery rather than general URLSession capture. Customer instrumentation must supply its own session/event generation, observation semantics, handler spans, transaction metrics and sanitization; the transfer package does not infer those facts.

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

## 4. Initialize one canonical journal

The app supplies sanitized schema 1.2 events; the transfer package does not provide general URLSession instrumentation. In a debug target initialize `DebugCapture.start()` once. It creates installation state, backup-excluded `Library/Application Support/HTTPSequenceLogger/source.json`, a unique process journal under `journals/<uuid>/capture.ndjson`, and one pairing manager. Initialization works before collector startup and before events. Use `await capture.captureURLs` at export time to share all retained generations. `captureURL` identifies the initial generation and `currentCaptureURL` the active one; neither alone represents a rotated history. Do not maintain a second durable upload copy.

A custom directory/app ID is optional. For simulator discovery use the default fixed root and actual bundle identifier, including any debug suffix. If the root is customized, automatic fixed-path discovery is unavailable until its explicit discovery convention is configured. The app's production backup policy remains unchanged.

## 5. Wire the implemented bootstrap API

```swift
#if DEBUG
import NetworkLogTransfer

let capture = try await DebugCapture.start()
// Retain capture for the process lifetime. Capture/redact in existing app hooks.
try await capture.appendSanitizedLine(sanitizedEventJSON)
try await capture.flush() // Persistence barrier, independent of collector availability.
let delivery = await capture.deliverNow() // Optional foreground upload attempt.
// At export time, snapshot all retained generations:
let files = await capture.captureURLs
// On foreground resume:
await capture.refresh()
// At the chosen lifetime boundary:
await capture.close()
#endif
```

This is the successful setup path. Catch setup/admission/persistence failures at the development logging boundary; logging must not replace a business HTTP response, error, cancellation or handler result. Redaction happens before admission. The sink validates the envelope but does not replace a complete event/schema or privacy policy.

Append admits bounded memory; a dedicated serial disk queue performs grouped canonical writes. `flush()` waits for the admitted prefix's persistence; the normal append call is not a durability promise. Kill can lose an unflushed tail. Capture ordering/sequence and immutable metadata must be established under a short producer synchronization boundary before asynchronous writes. No filesystem or network work belongs under that boundary.

Booted simulators are paired privately by the collector after it finds the descriptor. For physical iOS, obtain private version 2 HTTPS enrollment input from the trusted collector UI/file, then call `try await capture.savePairing(pairingJSON)`. Bonjour only offers endpoint candidates; it does not establish certificate trust or grant enrollment. Debug-only `NSLocalNetworkUsageDescription` and service declarations must match actual usage. Real hardware must verify foreground permission denial/revocation and address/name changes.

Pairing refresh/rebind fences old sender ACK/cursor/status while canonical capture continues. ACK never deletes canonical records. `status()` exposes retained backlog; `deliverNow()` attempts current delivery; `refresh()` runs on foreground return. Close stops admission, flushes the accepted prefix and releases disk ownership when jobs finish. Suspended/terminated apps do not promise continuous delivery.

The lower-level `NDJSONTransferSink` remains available for already-sanitized lines and explicit canonical journal ownership. Its directory holds the sole canonical `capture.ndjson`, durable-prefix metadata and delivery cursor despite historical spool type names. `appendSanitizedLine` admits memory, `flushPersistence` establishes local durability, `deliverNow` attempts delivery and `rebind` fences old transfer state. Do not use a separate export journal plus upload spool.

## 6. If an event producer is needed

Use [SPECS.md](SPECS.md) to find the normative contract, standalone per-event JSON Schema, relationship validator, and handler fixtures. An app-owned URLSession/custom-client adapter must satisfy the following:

- Generate a recording ID for each continuous recording period; accept or generate the logging session ID, preserving its configured namespace. Reuse the caller's session ID intentionally, not as an event or span ID.
- Serialize sequence allocation and monotonic timestamp sampling. Emit `session.started` as sequence 1 at monotonic 0. Use continuous elapsed time (for example `mach_continuous_time()` converted with its timebase), decimal strings for nanoseconds, and wall time only for the separate timestamp. Do not compare monotonic origins across recordings.
- Capture the configured method/URL/headers before dispatch and mark application-only headers partial. URLSession exposes library-normalized metadata; do not claim wire bytes, original header ordering, or invisible redirects/retries. If only one logical task is observed, declare logical attempt visibility.
- Observe existing callbacks or async boundaries without replacing the HTTP client, delegate, authentication flow, scheduling, retries, or cancellation behavior. Preserve original callback arguments/count and result/error identity. Read already-available bytes; never consume or replay a stream just for logging.
- Capture available HTTP response metadata before reporting a completion-handler transport error. An HTTP error status is distinct from a transport failure. For streaming APIs, receiving headers is not body completion; retain partial data and end only at the observed EOF/close/failure/cancellation boundary. Unknown data stays explicitly unavailable, not an invented empty body or success.
- Bound body snapshots and redact headers, URL query values, bodies, effective URLs, and optional metrics **before persistence**. If safe structured redaction cannot be performed, omit content with an explicit reason. The demo's limited endpoint-specific policy is insufficient for arbitrary customer data.
- Record the actual initiator/executor component and integrator/SDK ownership. Propagate parent context explicitly through async callbacks. Do not infer ancestry from URLs, timing, or threads.
- For SDK → app handler → SDK transitions, emit the schema **1.2** handler operation fields and explicit `returned`/`threw`/`cancelled`/`observation_stopped` completion described in [HANDLER-TRACING.md](../../HANDLER-TRACING.md). Parent app HTTP calls to the handler span, preserve its actual integrator executor, and invoke the handler exactly once. A missing end is incomplete observation. All events use current schema 1.2; earlier captures are not imported.

Do not enable outbound trace headers by default. Cross-server correlation requires an explicit propagation policy and supporting server instrumentation; it is separate from the local session ID and delivery pairing.

## 7. Retrieve files and inspect the viewer

Start `npm start` in the logger checkout and open **http://127.0.0.1:4319/**. It discovers participating apps on each booted simulator using an explicit UDID and `simctl`-resolved data containers; it never boots a device for scanning. A stopped app's published durable prefix remains recoverable while its simulator is booted. Synced but unpublished crash tails require producer reopen/resync before pull can claim them.

Find the actual simulator/bundle/journal identifiers, then retrieve a canonical file:

```sh
xcrun simctl list devices available
APP_DATA=$(xcrun simctl get_app_container "$SIMULATOR_ID" "$APP_BUNDLE_ID" data)
cp "$APP_DATA/Library/Application Support/HTTPSequenceLogger/journals/$JOURNAL_ID/capture.ndjson" customer-capture.ndjson
node validate.mjs customer-capture.ndjson
```

Physical devices use a development share sheet for `captureURL`; no unrestricted physical iPhone sandbox reader is provided. Physical sources register after authorized HTTPS pairing, not installed-app enumeration. Confirm real arriving events in Devices and environments → Apps → Sessions, actual HTTP/handler facts and redaction. **Save capture** exports collector NDJSON. Viewer pause/import pauses only reads; canonical capture and collector storage continue.

The offline viewer at port `4173` imports current NDJSON without adopting a source into collector history. Do not export private pairing/cursor/installation files. See [TRANSPORT.md](TRANSPORT.md) for recovery, ownership, trust and troubleshooting.

## 8. Verify the customer's integration

First run the repository's external consumer smoke check:

```sh
scripts/check-ios-integration.sh
```

It compiles the real transfer API from a local dependency, tests a canonical journal lifecycle, compiles/tests/runs a separate dependency-free production package, checks the lazy no-op and transfer-symbol absence, and rejects accidental Release compilation of the development fixture. Reports are in `artifacts/integration-ios/`. This is a **macOS host API check**, not proof of iOS linking, capture correctness, or real delivery.

Then verify the actual customer app:

1. Build its development target for the selected Simulator/device. Make a real request through the existing client, a custom/manual request, and relevant SDK/app handler calls. Preserve its normal behavior and callbacks.
2. Record and retrieve the app's canonical path and session ID. Validate the emitted file structurally and semantically; inspect it in the viewer. Do not treat a supplied synthetic sample as evidence of native app capture.
3. Pair and deliver to the collector. Temporarily make the collector unavailable, keep the canonical file, reopen/resume delivery, and verify matching event IDs without conflicts or invented request failures. Exercise manual share/import as the fallback.
4. Archive the customer's **actual shipping scheme/configuration**. Verify no transfer package target/dependency, development sources/resources, pairing data, capture fixtures, or development-only Info.plist/entitlement changes enter its build. Inspect the archive's linked libraries, symbols, and resources. A no-op test or a `#if DEBUG` grep alone is insufficient.
5. Report the exact commands, simulator/device, captured file, session ID, viewer result, and production artifact checked. Never include pairing tokens. Mark untested physical-device permissions/reachability explicitly.

The repository's `swift test --package-path ios`, [native Simulator runner](../../ios/scripts/run-simulator-tests.mjs), and `node ios/scripts/verify-release-isolation.mjs` provide package/sample evidence. The native runner needs a running collector, explicit loopback/TLS pairing paths, Xcode/XcodeGen, and a discovered Simulator ID. Its sample archive audit does not replace inspection of the customer's app archive. See [ios/README.md](../../ios/README.md) for these checks and current platform limits.
