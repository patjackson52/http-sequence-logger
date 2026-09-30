# Agent entry point

This repository contains development network logging, device/browser transfer, and a local sequence viewer. For an **existing Android, iOS or browser application integration**, start with [docs/integration/README.md](docs/integration/README.md), then read only the relevant platform guide and [transport map](docs/integration/TRANSPORT.md). Follow the host application's own instructions when editing that application. Users can copy the prompt in [README → FOR AGENTS](README.md#for-agents) or the [full integration prompt](docs/integration/AGENT-PROMPT.md).

## What exists

- Android Kotlin: `android/logger-api` is the small shared API/no-op; `android/logger` is the debug-only recorder and transfer implementation. Manual customer HTTP clients and synchronous SDK → app handler → SDK tracing are implemented.
- iOS Swift: `ios/` is the local `NetworkLogTransfer` package for **already-sanitized NDJSON**, plus a limited manual demo. It is not a general Swift capture SDK. The Swift API sketches in design documents are not implemented symbols.
- Browser: `web-sdk/` supplies a zero-runtime-dependency ESM/TypeScript package. Its default entry is the production no-op; `/debug` adds Fetch/XHR/manual capture, synchronous/awaited handlers, bounded journals and explicit upload. `/dev-relay` is Node-only. See [WEB.md](docs/integration/WEB.md) and the build-separated `web-sample/`.
- Desktop: `collector/` receives or retrieves files and serves `viewer/dist/`; `viewer/` is the React sequence inspector. The viewer does not belong in the mobile production binary.
- No published Maven/npm package, root Swift package, hosted collector, or account setup is supplied. Pin a source checkout; use the documented source/local-package recipes.

## Find the right authority

1. Actual public source APIs and tested consumer examples determine callable methods and build behavior.
2. [schema/event.schema.json](schema/event.schema.json) defines each JSON event; [CONTRACT.md](CONTRACT.md) defines cross-event semantics. Read [the spec index](docs/integration/SPECS.md) before writing a producer.
3. [docs/transfer/PROTOCOL.md](docs/transfer/PROTOCOL.md) defines pairing, ingestion, ACKs and browser access. Transfer version `1` is distinct from event schema `1.0`/`1.1`/`1.2`; web producers write `1.2`.
4. `ADAPTERS.md`, `MANUAL-LOGGING.md`, and `HANDLER-TRACING.md` mix implemented behavior with broader requirements/design sketches. Check platform status before using a named API.

## Integration invariants

- Keep business HTTP clients and handlers functional with logging disabled. Shared Android code imports `dev.networklog.api`; only debug wiring imports `dev.networklog.logger`. iOS production targets have no transfer package dependency. Runtime flags alone do not remove code/resources.
- Browser build aliases must exclude the debug entry/setup, journals, uploader and development UI from shipping chunks/assets/maps. Keep pairing JSON in the Node dev server, never public frontend configuration. Do not loosen collector CORS or instrument the uploader.
- Preserve existing callback, body consumption, retry, redirect, cancellation, and error behavior. Record observed metadata or mark it unavailable; never invent wire headers, timings, attempts, or successful completion.
- Use app-specific namespace and an opaque session ID; reuse supplied session IDs when appropriate. Pass method/handler contexts explicitly. Synchronous handler tracing does not implement coroutine/async context propagation.
- Browser `invokeAsyncHandler` explicitly observes awaited settlement; it does not propagate ambient context. Fetch readers observe application-chosen consumption without cloning; XHR observers need disposal before reuse. Do not invent original bytes from parsed response objects.
- Capture bodies/headers lazily on Android, sanitize before writing or transfer, and never route collector uploads through instrumentation. The viewer and transfer sinks are not general redaction engines.
- File paths and sender lifetimes are app-owned. A fresh unpaired `NdjsonFileSink` truncates its path; use unique capture filenames and retain one sink across sessions. An iOS transfer spool can compact acknowledged bytes; retain a separate canonical capture for export.
- Browser journals are origin-scoped IndexedDB, with an explicit database/journal ID and one writer. Flush for persistence, export NDJSON for a file, and replay explicitly through the same-origin dev relay. No browser background sender or durable ACK cursor is implemented.
- Pairing JSON, browser read tokens, cursor state, TLS keys, build artifacts and unsanitized captures are not repository deliverables. Preserve the host's security/backup policies and merge targeted development exceptions.

## Realtime streaming workflow

Run `npm ci` once in the pinned checkout, then choose one command:

| Task | Command |
| --- | --- |
| Build/install/pair/run the repository Android sample | `npm run android:live` |
| Stream from the installed repository Android sample | `npm start` |
| Stream from an instrumented customer Android debug app | `npm run collector -- --android APPLICATION_ID --open` |
| Serve iOS/browser captures without Android watching | `npm start -- --no-android` |

These commands build and serve the viewer at **http://127.0.0.1:4319/**. Use that ordinary URL; bootstrap, refresh and collector reconnect are automatic. Never construct a token/collector-ID URL, copy browser credentials into settings, or loosen CORS. Static `npm run viewer` on `4173` is file-only. For iOS and browser producers, complete the explicit pairing or server-side relay/upload route in [TRANSPORT.md](docs/integration/TRANSPORT.md); automatic viewer connection does not create those producers.

Android tools discover ADB and prefer the single physical phone over emulators, otherwise the sole emulator. Use `--device SERIAL` (after npm's `--`) or `ANDROID_SERIAL` when selection is ambiguous. `android:live` builds the repository sample only; build/install a customer app with its own toolchain and use its actual debug application ID. Existing clients still need capture hooks. The watcher repairs USB forwarding/private pairing after reconnect or reinstall and watches only `files/captures/*.ndjson`; it retains its selected device until stopped.

Keep the collector terminal running. `android:live` can reuse the same directory/port; other startup commands require a free port. Inspect an existing collector before starting or replacing it. **Live** means the browser is connected; check Android readiness and an increasing event count to establish delivery. **Follow newest session** starts enabled and stops when inspecting/filtering. **Pause live** or file import pauses browser updates; **Resume live** returns to the collector. USB watching owns the app's pairing while active, so stop it or use `--no-android` before manually switching that app to another collector.

Collected NDJSON is `<checkout>/artifacts/collector/capture.ndjson` unless `--dir` overrides it; **Save capture** exports all collected sessions. Android originals remain in the app's private `files/captures/`. iOS canonical/spool paths and browser IndexedDB IDs are app-owned. Record exact locations and start/reconnect/export commands in the host integration note; use the [file map](docs/integration/TRANSPORT.md#where-every-file-lives) and [troubleshooting table](docs/integration/TRANSPORT.md#troubleshooting-by-symptom).

## Build and verify

Use Node **22.12+** for desktop tools; Android baseline is JDK 17, Kotlin 2.2.20, AGP 8.13.2, Gradle 8.14.3, SDK 35/minimum 26. iOS uses Swift 6 and iOS 15+. Commands run from this repository root unless a guide says otherwise.

```sh
npm ci
npm test
npm run build:viewer
node validate.mjs /absolute/path/to/capture.ndjson
```

Use the platform integration guides' external-consumer checks when changing installation or wiring. For SDK/build-boundary changes, run `android/scripts/verify-release.sh` with `JAVA_HOME`/`ANDROID_HOME`, or `node ios/scripts/verify-release-isolation.mjs` on a Mac with Xcode/XcodeGen. Native tests require explicitly selected installed devices/simulators; discover identifiers instead of copying example IDs.

Browser checks: `npm run check:web-types`, `npm run check:web-release`, `npm run check:web-browser` (installed Google Chrome), and `npm run web:sample` at `127.0.0.1:4180` (fixture servers `4181`/`4182`). The release audit checks positive debug controls and all shipping assets/maps. Node tests do not replace exercising the host app in a real browser.

For collector/viewer connection changes, run `npm run check:live-setup` with installed Chrome. It covers ordinary URL bootstrap, refresh/reconnect, new collector identity, file import/pause/resume, following sessions and rejected foreign-origin access. Exercise USB delivery on the actual selected device when changing Android setup; [transfer verification](docs/transfer/VERIFICATION.md) records prior evidence and its limits.

Repository tests validate repository fixtures. To finish a customer integration, validate a capture from that app, inspect HTTP and handler nesting in the viewer, verify offline recovery, and inspect **that app's** shipping artifact/dependency graph. Record unrun checks and concrete environment blockers.

## Maintaining this repository

Edit schema in `scripts/build-schema.mjs`, then run `npm run generate` and relevant tests; generated schema/validator/example files must stay reproducible. Do not rewrite the event contract merely to accommodate one application's integration. Keep Android examples Kotlin-only. Update the integration guides if public APIs, source-install requirements, storage locations, or transport behavior change.

The short root entry point and linked, task-specific guides follow the [AGENTS.md convention](https://agents.md/); they are plain Markdown, not a plugin or agent runtime requirement.
