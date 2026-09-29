# Agent entry point

This repository contains development network logging, device/browser transfer, and a local sequence viewer. For an **existing Android, iOS or browser application integration**, start with [docs/integration/README.md](docs/integration/README.md), then read only the relevant platform guide and [transport map](docs/integration/TRANSPORT.md). Follow the host application's own instructions when editing that application.

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
- Pairing JSON, browser launch tokens, cursor state, TLS keys, build artifacts and unsanitized captures are not repository deliverables. Preserve the host's security/backup policies and merge targeted development exceptions.

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

Repository tests prove repository fixtures. To finish a customer integration, validate a capture from that app, inspect HTTP and handler nesting in the viewer, verify offline recovery, and inspect **that app's** shipping artifact/dependency graph. Record unrun checks and concrete environment blockers.

## Maintaining this repository

Edit schema in `scripts/build-schema.mjs`, then run `npm run generate` and relevant tests; generated schema/validator/example files must stay reproducible. Do not rewrite the event contract merely to accommodate one application's integration. Keep Android examples Kotlin-only. Update the integration guides if public APIs, source-install requirements, storage locations, or transport behavior change.

The short root entry point and linked, task-specific guides follow the [AGENTS.md convention](https://agents.md/); they are plain Markdown, not a plugin or agent runtime requirement.
