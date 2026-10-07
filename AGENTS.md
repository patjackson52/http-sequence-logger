# Agent entry point

This repository contains development network logging, device/browser transfer, a local sequence viewer and a standalone comparison module/CLI. Follow the host application's own instructions when editing that application. Read the route for the current task; design archives and old evidence are not runtime API documentation.

## Choose a task route

| Task | Read first | Next authority/check |
| --- | --- | --- |
| Integrate server capture or raw log collection | [server guide](docs/integration/SERVER.md), [adapters](docs/integration/ADAPTERS.md) | `server-sdk/index.mjs`, `collector/adapters.mjs`; validate real host local/cloud trace and rendered remote links |
| Integrate an existing Android/iOS/web client | [integration entry](docs/integration/README.md), then its one platform guide | [transport map](docs/integration/TRANSPORT.md), [callable API/spec index](docs/integration/SPECS.md), [independent consumer examples](integration/README.md); test the host's real flow and shipping artifact |
| Start/diagnose collection, retrieve captures | [collector guide](collector/README.md) | `npm run collector -- --help`, `status`, `doctor`; [file locations](docs/integration/TRANSPORT.md#where-every-file-lives) and [protocol](docs/transfer/PROTOCOL.md) |
| Compare files or consume a machine diff | [sequence-diff guide](sequence-diff/README.md) | `npm run diff:sequence -- --help`; package-local sequence/diff schemas and `sequence-diff/index.mjs` |
| Inspect live/files or compare sessions visually | [viewer guide](viewer/README.md) | [comparison verification](docs/design/SESSION-COMPARISON-VERIFICATION.md); `npm run check:comparison` and applicable viewer regressions |
| Implement/debug a canonical event producer | [spec/API index](docs/integration/SPECS.md) | Event schema and `CONTRACT.md`; `node validate.mjs --help`, then validate the app's actual capture |

Commands run from this checkout with Node **24.13.x** after `npm ci`. In a host-app repository, invoke them from the pinned logger checkout rather than assuming its npm scripts exist in the host. SDKs are source/local-package integrations, not published dependencies. The [README agent prompt](README.md#for-agents) and [full integration prompt](docs/integration/AGENT-PROMPT.md) are specifically for client integration; collector, comparison and viewer tasks use the routes above.

## What exists

- Android Kotlin: `android/logger-api` is the small shared API/no-op; `android/logger` is the debug-only recorder and transfer implementation. Manual customer HTTP clients and synchronous SDK → app handler → SDK tracing are implemented.
- iOS Swift: `ios/` is the local `NetworkLogTransfer` package for **already-sanitized NDJSON**, plus a limited manual demo. It is not a general Swift capture SDK. The Swift API sketches in design documents are not implemented symbols.
- Browser: `web-sdk/` supplies a zero-runtime-dependency ESM/TypeScript package. Its default entry is the production no-op; `/debug` adds Fetch/XHR/manual capture, synchronous/awaited handlers, bounded journals and continuous foreground delivery. `/dev-relay` is Node-only. See [WEB.md](docs/integration/WEB.md) and the build-separated `web-sample/`.
- Servers: `server-sdk/` emits canonical JSON through an app-owned logger with explicit per-request contexts. Local/Cloudflare collection adapters and independent parsers normalize retained logs; Cloudflare retrieval uses an authenticated host endpoint. See [server integration](docs/integration/SERVER.md).
- Desktop: `collector/` receives or retrieves files and serves `viewer/dist/`; `viewer/` is the React sequence inspector. The viewer does not belong in the mobile production binary.
- Comparison: `sequence-diff/` owns matching, field comparison and order interpretation. The viewer runs this module in a worker; layouts only render its result. Never use the archived prototype's `nll-diff.js` or invent a second matching implementation.
- No published Maven/npm package, root Swift package, hosted collector, or account setup is supplied. Pin a source checkout; use the documented source/local-package recipes.

## Find the right authority

1. Actual public source APIs and tested consumer examples determine callable methods and build behavior.
2. [schema/event.schema.json](schema/event.schema.json) defines each JSON event; [CONTRACT.md](CONTRACT.md) defines cross-event semantics. Read [the spec index](docs/integration/SPECS.md) before writing a producer.
3. [docs/transfer/PROTOCOL.md](docs/transfer/PROTOCOL.md) defines pairing, ingestion, ACKs and browser access. Transfer version `2` is distinct from the sole supported event schema `1.3` on all platforms. No legacy source, state or capture migration is required.
4. `ADAPTERS.md`, `MANUAL-LOGGING.md`, and `HANDLER-TRACING.md` mix implemented behavior with broader requirements/design sketches. Check platform status before using a named API.
5. [sequence.schema.json](sequence-diff/schema/sequence.schema.json) and [diff.schema.json](sequence-diff/schema/diff.schema.json) are separate schema-1.0 wrappers/output over schema-1.3 events. Capture, transfer, sequence and diff versions are independent. A diff is evidence, not a replayable patch; preserve snapshots, profile, unknowns and exact source references.

A reusable integration skill is included at [skills/http-sequence-logger/SKILL.md](skills/http-sequence-logger/SKILL.md). Install/copy it through the harness's normal skill workflow when needed; the repository guides remain API authority.

## Integration invariants

- Keep business HTTP clients and handlers functional with logging disabled. Shared Android code imports `dev.networklog.api`; only debug wiring imports `dev.networklog.logger`. iOS production targets have no transfer package dependency. Runtime flags alone do not remove code/resources.
- Browser build aliases must exclude the debug entry/setup, journals, uploader and development UI from shipping chunks/assets/maps. Keep pairing JSON in the Node dev server, never public frontend configuration. Do not loosen collector CORS or instrument the uploader.
- Native shared code can use `exchange.context.traceparent(destination)`; only the debug bridge returns context for `NetworkLog.propagationOrigins`. Production no-op returns null. Use the actual outbound request span, never an enclosing operation span.
- Distributed capture preserves independent source/session/recording/event identities. Trace IDs locate operations; span IDs and remote parents establish causal links. Never align independent monotonic clocks or infer confirmed links from URLs/timestamps. Retrieval and parsing remain separate; bound jobs and expose failure/truncation/cancellation. Viewer unchanged polling retains layout and selection.
- Preserve existing callback, body consumption, retry, redirect, cancellation, and error behavior. Record observed metadata or mark it unavailable; never invent wire headers, timings, attempts, or successful completion.
- Use app-specific namespace and an opaque session ID; reuse supplied session IDs when appropriate. Pass method/handler contexts explicitly. Synchronous handler tracing does not implement coroutine/async context propagation.
- Browser `invokeAsyncHandler` explicitly observes awaited settlement; it does not propagate ambient context. Fetch readers observe application-chosen consumption without cloning; XHR observers need disposal before reuse. Do not invent original bytes from parsed response objects.
- Capture bodies/headers lazily on Android, sanitize before writing or transfer, and never route collector uploads through instrumentation. The viewer and transfer sinks are not general redaction engines.
- Debug bootstrap publishes discovery before events or collector availability: Android `DebugTransfer.open(context)` and Swift `DebugCapture.start()`. Each process owns a unique canonical journal. Append admits bounded memory; await the async persistence barrier to establish durable local storage. Sender ACKs advance a scoped cursor without deleting canonical history. Close stops admission, flushes admitted records and releases ownership after disk work finishes.
- Browser journals are origin-scoped IndexedDB with separate page journals and transactional owner epochs. `startJournalDelivery` registers zero-event pages and drains retained indexed ranges through a same-origin Node relay. Flush for a persisted snapshot; export NDJSON for a file. Foreground continuity does not guarantee persistence or transfer on page unload.
- Pairing JSON, browser read tokens, cursor state, TLS keys, build artifacts and unsanitized captures are not repository deliverables. Preserve the host's security/backup policies and merge targeted development exceptions.

## Realtime streaming workflow

Run `npm ci` in the pinned checkout, then `npm start`. It builds/serves the viewer at **http://127.0.0.1:4319/** and discovers all authorized Android devices and booted iOS simulators. Missing tools or permissions disable only the affected adapter. Optional `--android APPLICATION_ID`, `--device SERIAL`, `--ios BUNDLE_ID` and `--simulator UDID` narrow discovery. `--no-android` and `--no-ios` disable adapters. `npm run android:live -- --device SERIAL` separately builds/installs/runs the sample; multiple devices require explicit sample installation selection.

Use the ordinary viewer URL; guarded same-origin bootstrap and reconnect are automatic. Read credentials stay in memory. Static `npm run viewer` on `4173` is file-only. Native hosts still need capture hooks and debug bootstrap. Physical iOS uses explicit paired HTTPS; optional Bonjour finds candidates only. Browser debug frontends always mount the Node relay, which waits when the collector is absent. Start frontend before or after collector normally.

The source sidebar lists Devices and environments → Apps → Sessions; browser environment IDs do not identify verified hardware. One logical session may span sources. Viewer pause or file import suspends browser reads while collection continues. Check the source status and event counts to establish delivery.

Fresh collector state defaults to `<checkout>/artifacts/collector-v2/capture.sqlite`. Original native journals remain in `no_backup/HTTPSequenceLogger/journals/<uuid>/capture.ndjson` on Android and `Library/Application Support/HTTPSequenceLogger/journals/<uuid>/capture.ndjson` on iOS. Browser canonical records stay in origin-scoped IndexedDB. **Save capture** exports current NDJSON. Never import old collector directories or edit cursors to force delivery.

The private active manifest defaults to `~/.http-sequence-logger/active.json`; relays may use an explicit override. Another live collector cannot take it over. Use explicit directory/port and non-activation for a second instance. `collector status` and `collector doctor` diagnose without changing pairing/state. See [TRANSPORT.md](docs/integration/TRANSPORT.md) for ownership, pairing, paths and troubleshooting.

## Build and verify

Use Node **24.13.x** for desktop tools; Android baseline is JDK 17, Kotlin 2.2.20, AGP 8.13.2, Gradle 8.14.3, SDK 35/minimum 26. iOS uses Swift 6 and iOS 15+. Commands run from this repository root unless a guide says otherwise.

```sh
npm ci
npm test
npm run build:viewer
node validate.mjs /absolute/path/to/capture.ndjson
```

Use the platform integration guides' external-consumer checks when changing installation or wiring. For SDK/build-boundary changes, run `android/scripts/verify-release.sh` with `JAVA_HOME`/`ANDROID_HOME`, or `node ios/scripts/verify-release-isolation.mjs` on a Mac with Xcode/XcodeGen. Native tests require explicitly selected installed devices/simulators; discover identifiers instead of copying example IDs.

Browser checks: `npm run check:web-types`, `npm run check:web-release`, `npm run check:web-browser` (installed Google Chrome), and `npm run web:sample` at `127.0.0.1:4180` (fixture servers `4181`/`4182`). The release audit checks positive debug controls and all shipping assets/maps. Node tests do not replace exercising the host app in a real browser.

For comparison engine/controller/layout/inspector changes, run `node --test test/sequence-diff.test.mjs test/comparison-*.test.mjs`, `npm test`, `npm run build:viewer` and `npm run check:comparison`. Keep frozen live comparisons stable until explicit recomputation; failures/limits must retain the last valid result. Replay exports with their exact `profile`, not defaults. Single-session layout/export changes also require `npm run check:svg-export`; live rendering changes require `npm run check:viewer-realtime`.

For collector/viewer connection changes, run `npm run check:live-setup` with installed Chrome. It covers ordinary URL bootstrap, refresh/reconnect, new collector identity, file import/pause/resume, following sessions and rejected foreign-origin access. Exercise USB delivery on the actual selected device when changing Android setup; [transfer verification](docs/transfer/VERIFICATION.md) records prior evidence and its limits.

Repository tests validate repository fixtures. To finish a customer integration, validate a capture from that app, inspect HTTP and handler nesting in the viewer, verify offline recovery, and inspect **that app's** shipping artifact/dependency graph. Record unrun checks and concrete environment blockers.

## Maintaining this repository

Edit event schema in `scripts/build-schema.mjs`, then run `npm run generate` and relevant tests; generated schema/validator/example files must stay reproducible. Author sequence/diff schemas in `scripts/build-diff-schema.mjs` and use `npm run generate:diff`; see the standalone package's maintenance checks. Do not rewrite the event contract merely to accommodate one application's integration. Keep Android examples Kotlin-only. Update task guides and CLI `--help` if callable APIs, flags, defaults, installation, storage or behavior change.

The short root entry point and linked, task-specific guides follow the [AGENTS.md convention](https://agents.md/); they are plain Markdown, not a plugin or agent runtime requirement.
