# Transfer verification

This is the historical pre-update verification record. Current schema 1.2/transfer 2 evidence and open acceptance gates are in [Realtime implementation verification](../design/REALTIME-VERIFICATION.md). These earlier physical-device and protocol results do not establish the current implementation.

## Automatic live setup — 2026-09-30 UTC

The plain `http://127.0.0.1:4319/` URL now connects automatically. `npm start` builds/serves the viewer and checks the installed Android sample; `npm run android:live` also builds, installs, pairs and launches a flow. Pairing is still private and authenticated; the browser receives its read credential through the guarded same-origin route described in [the protocol](PROTOCOL.md).

Verified on macOS with a Pixel 10 Pro and Chrome 154.0.8037.59:

- The launcher selected the physical phone despite three connected emulators, installed the debug APK, started the collector and ran a complete eight-request sign-in without serial/ADB/pairing arguments.
- A repeated launch reused the existing collector successfully with `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` unset and `android/local.properties` temporarily absent. The original local file was restored after the check.
- Removing the device's collector reverse mapping and private pairing file was repaired automatically. Existing valid mappings/configuration are retained during ordinary polls. The viewer showed the phone's paired status.
- A fresh recovery run produced nine requests across three origins, one expected HTTP 401, one app handler invocation/return and no unfinished observations. The plain viewer URL selected the newest session, streamed the run and reconnected after refresh. An earlier recovery attempt hit `UnknownHostException` against the public auth API; that partial business flow was retained accurately rather than rewritten as success.
- After the Pixel disconnected and returned over USB, the running collector paired it again without restart. A final eight-request sign-in completed across three origins with one handler handoff, no failed or unfinished observations, and no browser errors. The plain URL streamed the new session and survived refresh; desktop and 390 × 844 layouts were checked with no page overflow.
- `npm run check:live-setup` passed 14 real-browser checks: ordinary URL, empty collector, device status, incremental capture with selection/search preserved, refresh without credential storage, same-journal restart, new collector identity, pause/resume, file import isolation, resuming an empty collector, following new sessions, legacy link compatibility, localhost alias and rejected foreign-origin access.
- `npm test`: **219 tests passed**, including bootstrap rejection for untrusted Host/Origin, missing or cross-origin Fetch Metadata, navigation and non-GET methods; upload authentication and LAN isolation remain enforced. ADB tests cover selection ambiguity, authorization and repair without repeatedly rebinding an active route.
- `android/scripts/verify-release.sh`: passed debug/native unit tests, production dependency/APK/resource audits, R8 and the negative dependency probe. Intent-driven sample launch exists only in debug source; production still contains only the small logging abstraction.
- Regression checks passed for the full browser SDK flow (63 events, capture/persistence/transfer/viewer and production no-op) and 12 real SVG downloads with standalone/offline rendering.

Runtime evidence is kept in ignored `artifacts/live-setup/`, including the launcher output, browser checks, Pixel summary and screenshot. Captures remain in `artifacts/collector/capture.ndjson` and private device storage. Physical iOS automatic pairing and browser-SDK background upload are not added by this change; their existing explicit pairing/delivery routes still apply.

## Original transport verification

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

The Swift package passes **14 macOS unit tests and 20 app-hosted iOS XCTest tests** on the iPhone 16e Simulator (iOS 26.3.1). The native demo records a real URLSession health request manually, preserving request/response timing and body state, then transfers its seven event lines. Integration coverage includes HTTP, paired HTTPS, mismatched pin retention, refusal to follow a 307 redirect, a chunked ACK exceeding the 2 MiB limit, and automatic recovery from an actual refused connection when a forwarding listener becomes available. Reopening the acknowledged spool has zero pending bytes. This is native simulator execution, not a desktop replay presented as an iOS capture.

[Swift guide](../../ios/README.md) gives reproducible test commands and precise API/platform scope. The iOS package transfers sanitized events; automatic URLSession interception and a complete Swift capture recorder remain outside this implementation.

## Saved native captures

[Transferred native samples](../../samples/transfer/README.md) preserve 57 Android events plus 21 iOS events (four independent sessions). All pass the shared schema and semantic validator with no unfinished requests. The same bundle is available in the viewer sample menu.

## Limits of the evidence

Physical iPhone signing, local-network permission UI, and real Wi-Fi/firewall reachability were not exercised. Neither simulator testing nor leaf pin tests claim verification against every device TLS stack. Delivery is foreground development behavior; iOS background suspension pauses uploads, with durable retry on resume. The collector is a local single-user development service, not an internet-facing multi-tenant backend. The sequence renderer remains intended for small sessions rather than a virtualized 100,000-event timeline.
