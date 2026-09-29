# Transfer verification

Verified locally on 2026-09-29 UTC (2026-09-28 Pacific). The collector, native senders and browser use the same version-1 transfer protocol and schema-1.0/1.1 event validator.

## Collector and browser

**159 Node tests pass**, including 10 transfer-specific tests. Node tests cover durable ACK/reopen, canonical replay deduplication, atomic rejection of conflicting IDs/sequences/recordings, storage limits, truncated-tail recovery, exclusive journal ownership, partial UTF-8 ADB framing, file replacement/truncation, rejected-batch retry, separate browser/device credentials, Host/Origin checks, bounded request bodies, SSE notifications and cursor catch-up after a real listener restart. A real HTTPS listener test accepts trusted paired upload and refuses all LAN capture-reading/UI routes.

Chrome verification used the collector-served production build. A real Android recovery flow arrived without file import. A selected SDK filter, session and open request inspector survived additional incoming events. Completing an initially partial fixture removed its lifecycle diagnostics. Live controls were checked at desktop size and 390 × 844. Stopping the real collector changed the browser to Reconnecting while keeping its diagram; restarting against the same journal restored Live and caught up to new ADB-watched events without a refresh. Save capture produced a downloaded NDJSON file with the identical SHA-256 as the persisted collector journal. Imported-file mode remains available.

An ADB watch of the installed debuggable sample retrieved 272 events from existing private capture files. A second poll retained exactly 272 events. The retrieved combined file passed schema and semantic validation (42 requests, 4 handler calls, 7 sessions). Automatic pairing wrote the app-private JSON configuration and established reverse forwarding.

## Android

Emulator `emulator-5554`, Android 17 / API 37; sample targets API 35. **37 JVM tests, Android build and lint pass.** The Kotlin tests include durable resume, collector/file identity changes, malformed ACKs, rejection and retries, tail repair, bounded storage and duplicate writer exclusion. Native instrumentation verifies:

- Nine-request public-service sign-in with expected 401 recovery, SDK handler handoff and successful final completion; all 57 events acknowledged and retained locally.
- Paired TLS acceptance and mismatched certificate rejection without deleting pending capture data.
- Collector unavailable: close the sink with data pending, reopen after connectivity returns, and upload the retained events.
- Debug-only private pairing configuration.

Raw local evidence is under ignored `artifacts/transfer/android-*.txt`; [Android guide](../../android/README.md) contains build and instrumentation commands.

## iOS

The Swift package passes **14 macOS unit tests and 20 app-hosted iOS XCTest tests** on the iPhone 16e Simulator (iOS 26.3.1). The native demo records a real URLSession health request manually, preserving request/response timing and body state, then transfers its seven event lines. Integration coverage includes HTTP, paired HTTPS, mismatched pin retention, refusal to follow a 307 redirect, a chunked ACK exceeding the 512 KiB limit, and automatic recovery from an actual refused connection when a forwarding listener becomes available. Reopening the acknowledged spool has zero pending bytes. This is native simulator execution, not a desktop replay presented as an iOS capture.

[Swift guide](../../ios/README.md) gives reproducible test commands and precise API/platform scope. The iOS package transfers sanitized events; automatic URLSession interception and a complete Swift capture recorder remain outside this implementation.

## Saved native captures

[Transferred native samples](../../samples/transfer/README.md) preserve 57 Android events plus 21 iOS events (four independent sessions). All pass the shared schema and semantic validator with no unfinished requests. The same bundle is available in the viewer sample menu.

## Limits of the evidence

Physical iPhone signing, local-network permission UI, and real Wi-Fi/firewall reachability were not exercised. Neither simulator testing nor leaf pin tests claim verification against every device TLS stack. Delivery is foreground development behavior; iOS background suspension pauses uploads, with durable retry on resume. The collector is a local single-user development service, not an internet-facing multi-tenant backend. The sequence renderer remains intended for small sessions rather than a virtualized 100,000-event timeline.
