# Swift development journal and transfer

The debug-only package stores **already-sanitized schema1.3 NDJSON** and implements source-aware transfer2. It provides storage, discovery and transfer; HTTP instrumentation/redaction remain app-owned. [iOS integration](../docs/integration/IOS.md) covers debug dependency isolation. Swift6, iOS15+ and macOS12+ are supported build baselines.

## Default bootstrap

```swift
#if DEBUG
import NetworkLogTransfer

let capture = try await DebugCapture.start() // Actual Bundle identifier; fixed private layout.
try await capture.appendSanitizedLine(sanitizedLine) // Bounded admission, not persistence.
try await capture.flush() // Persistence through current admitted prefix; does not await upload.
let delivery = await capture.deliverNow() // Optional bounded foreground upload attempt.
let exportURLs = await capture.captureURLs // Every retained canonical generation.
await capture.refresh() // Also call when entering foreground.
await capture.close()
#endif
```

Keep one `DebugCapture` across sessions. It publishes `Library/Application Support/HTTPSequenceLogger/source.json` before events or pairing. `pairing.json` is app-owned explicit selection/current source configuration or an enrollment ticket; `pairing-local.json` is the collector-owned automatic proposal. Manual selection takes priority. Enrollment replaces the app-owned ticket with its installation credential for later launches; use `savePairing(Data)` for explicit pairing. Each process opens a unique generation and rotates transparently at the configured byte limit. Canonical history lives under `journals/<UUID>/capture.ndjson`; synced-prefix metadata is `journal.json`, and scoped delivery state is `cursor.json`. The installation directory is excluded from backup. Local booted-simulator discovery resolves its container and provisions pairing automatically. Physical-device pairing uses authenticated HTTPS and resumes while foregrounded.

`NDJSONTransferSink(connection: optionalConnection, spoolDirectory: canonicalJournalDirectory)` is the low-level storage/transfer owner; despite the argument name, it creates one canonical journal and **no second upload spool**. Its `captureURL`, `flush()`, `deliverNow()`, `resume()`, `rebind()` and `close()` expose the same durability/lifetime distinctions. An exclusive writer lock rejects concurrent owners. Default bootstrap bounds are 8MiB per generation, 256MiB per installation, 128 retained generations, 2MiB total admission memory and 1MiB/500-event upload batches. Configure them with `NativeJournalLimits`. Reservations and writer acquisition share the installation lock. No ACK deletes history. Exhausted installation capacity rejects new records; export retained paths and explicitly archive storage. Retained generations replay one at a time after pairing.

One serial dispatch queue owns grouped file writes, bounded tail reads, cursor/config publication and durability barriers. No per-event file reopen/fsync, whole-history hydration or prefix hash occurs. Admission means queued memory and may be lost on abrupt process death. Group triggers are50ms,64KiB or500 events, not completion guarantees. Synced-prefix metadata coalesces at250ms/1MiB and is forced on seal/close. A write failure blocks that writer until close/reopen validates and repairs an incomplete final tail. Rebind cancels the previous sender and fences its late ACK while canonical capture continues. `close()` completes admitted disk work before releasing ownership; uploads are independent.

HTTPS configuration accepts a private exact leaf-DER `certificate_sha256` with hostname, usage and validity verification. Tokens remain private and never enter URLs/captures. Native URLSession is ephemeral and uninstrumented, redirects are refused, error bodies are discarded and ACKs are bounded to2MiB. An ACK must match collector/source and the exact submitted IDs. Ambiguous failure safely replays stable IDs. Bonjour TXT is discovery information, never authentication or trust.

## Demo and optional Bonjour

Run the package/demo commands below from this checkout's `ios/` directory. For integration into an existing app, use the [local-package and target-membership recipe](../docs/integration/IOS.md#2-pin-the-repository-and-add-the-local-package).

`xcodegen generate`, open the generated project and run **NetworkLogTransferDemo** in Debug. Launch publishes the fixed descriptor. Capture works without pairing; the manual demo persists events incrementally, shares the canonical journal and retries retained delivery without duplicating a spool. **Discover collectors** explicitly starts `@MainActor CollectorBrowser`, browsing `_nlog._tcp.`. Configure debug-only `NSBonjourServices` and `NSLocalNetworkUsageDescription`; use a separately provisioned private enrollment JSON for the selected candidate. Permission denial/multicast blocking retains manual pairing.

For reproducible simulator launch after installing the built Debug app:

```sh
SIMCTL_CHILD_NETWORKLOG_RUN=health xcrun simctl launch --terminate-running-process "$SIMULATOR_UDID" com.example.networklog.demo
```

This captures a real request to the running loopback collector health endpoint. A physical phone uses a reachable paired HTTPS origin rather than phone loopback. Suspension is not continuous/background delivery; foreground refresh resumes retained journals.

## Verification

```sh
swift test
node scripts/verify-release-isolation.mjs
node scripts/run-simulator-tests.mjs --device SELECTED_UDID --loopback /private/current-loopback-source.json --tls /private/current-tls-source.json
```

The simulator runner requires Xcode/XcodeGen and explicit actual device selection. It writes a private ignored test resource, builds and runs app-hosted XCTest, and copies canonical captures plus results under `.local/evidence`. Unit gates cover concurrent admission/close, retained identity, durable restart, rebind/late-ACK fencing, quota retention, partial tails, exact source ACKs and TLS identity/expiry. Release verification inspects the production archive/dependency graph and excludes journal/discovery/credential markers, Bonjour declarations and development ATS configuration. Simulator/macOS evidence does not replace physical iPhone permission, suspension and network validation.
