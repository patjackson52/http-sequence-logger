# JSON format and API authority

Captures are **UTF-8 NDJSON**: one JSON event per line, newline-terminated by producers, with no outer array. This is a custom draft event format, not HAR, OTLP JSON, Logcat text, a connection configuration, or a dump of arbitrary request objects.

## Read only what the integration needs

| Question | Source of truth |
| --- | --- |
| Required fields, types, enums, per-event schema | [schema/event.schema.json](../../schema/event.schema.json), JSON Schema 2020-12, current `$id` `urn:mobile-network-log:event:1.3` |
| Identity, ordering, missing metadata, bodies, times, outcomes | [CONTRACT.md](../../CONTRACT.md) |
| HTTP wrappers/manual capture fidelity | [ADAPTERS.md](../../ADAPTERS.md) and [MANUAL-LOGGING.md](../../MANUAL-LOGGING.md); check implemented API below |
| SDK/app local call, return, throw, cancel, parenting | [HANDLER-TRACING.md](../../HANDLER-TRACING.md) |
| Callable Android shared API | [Logging.kt](../../android/logger-api/src/main/kotlin/dev/networklog/api/Logging.kt) |
| Callable Android recorder/transfer | [NetworkLog.kt](../../android/logger/src/main/kotlin/dev/networklog/logger/NetworkLog.kt), [RecordingLogger.kt](../../android/logger/src/main/kotlin/dev/networklog/logger/RecordingLogger.kt), [DebugTransfer.kt](../../android/logger/src/main/kotlin/dev/networklog/logger/DebugTransfer.kt) |
| Callable Swift transport | [NDJSONTransferSink.swift](../../ios/Sources/NetworkLogTransfer/NDJSONTransferSink.swift), [TransferConnection.swift](../../ios/Sources/NetworkLogTransfer/TransferConnection.swift) |
| Callable browser API and debug implementation | [api.d.mts](../../web-sdk/src/api.d.mts), [index.d.mts](../../web-sdk/src/index.d.mts), [recorder.mjs](../../web-sdk/src/recorder.mjs), [adapters.mjs](../../web-sdk/src/adapters.mjs); [integration guide](WEB.md) |
| Callable server contexts and structured event emission | [server SDK](../../server-sdk/index.mjs), [server integration](SERVER.md) |
| Collection/parsing adapters and bounded jobs | [adapter implementation](../../collector/adapters.mjs), [adapter integration](ADAPTERS.md), [collector guide](../../collector/README.md) |
| Browser storage and same-origin delivery | [storage.mjs](../../web-sdk/src/storage.mjs), [transfer.mjs](../../web-sdk/src/transfer.mjs), Node-only [dev-relay.mjs](../../web-sdk/dev-relay.mjs) |
| Pairing JSON, HTTP endpoints, ACKs, browser SSE | [transfer protocol](../transfer/PROTOCOL.md); transfer version is `2`, independent of capture schema |
| Valid/invalid relationships and cross-event validation | [shared/validate.mjs](../../shared/validate.mjs); command entry [validate.mjs](../../validate.mjs) |
| Session documents, comparison profile and machine diff | [sequence-diff guide](../../sequence-diff/README.md), [sequence schema](../../sequence-diff/schema/sequence.schema.json), [diff schema](../../sequence-diff/schema/diff.schema.json); the sole engine is [index.mjs](../../sequence-diff/index.mjs) |
| Focused synthetic examples | [examples/manifest.json](../../examples/manifest.json), [manual-minimal](../../examples/manual-minimal.ndjson), [handler-http](../../examples/handler-http.ndjson), [stream-read-timeout](../../examples/stream-read-timeout.ndjson) |
| Historical native capture evidence (older format) | [samples/live/manifest.json](../../samples/live/manifest.json), [transfer captures](../../samples/transfer/README.md) |
| Earlier canonical platform capture evidence (schema 1.2) | [Android/iOS realtime captures](../../samples/realtime/README.md), [browser captures](../../samples/web/README.md); inspect each record's schema version |
| GUI interpretation/design | [viewer/README.md](../../viewer/README.md), [design history](../design/README.md); design images do not define runtime APIs |

The sole event schema is **1.3** for Android, iOS and web. Transfer/pairing uses **2** independently. Sequence documents and diff JSON each use their own schema **1.0**; they are not capture NDJSON or pairing files. Earlier captures/state are left untouched and rejected by current tools; there is no migration or compatibility parser. Handler dispatch can be synchronous or explicitly awaited. Proposed metrics, redirect, propagation or general Swift capture APIs are not necessarily implemented SDK APIs: inspect source and compiled consumer recipes.

## Producer rules agents must preserve

- `session_namespace` and `session_id` group sessions; `recording_id` separates recording periods even when a caller reuses a session ID. Allocate globally unique event IDs and increasing per-recording `sequence` values serially across concurrent events.
- Record UTC timestamps and monotonic durations. Nanoseconds are decimal **strings**, not JSON floating-point numbers. Never compare monotonic clocks from different devices/recordings as one shared clock.
- Method/handler/request parentage is explicit through trace/span context. Repeated URLs do not establish request identity. Transport replay keeps the same event IDs and timestamps.
- Preserve repeated headers and query parameters. Capture what the client exposes, marking partial/unavailable fields honestly. Logical native calls can hide attempts; do not fabricate per-hop redirects/retries or wire-level completeness.
- HTTP response headers are not body completion. Preserve HTTP status when later body read fails; distinguish HTTP error, timeout, transport failure, cancellation, intentional close and stopped observation.
- Sanitize before canonical storage or upload. The transfer sink performs limited envelope checks and the viewer renders existing content; neither replaces a capture/redaction policy. JSON-valid data can still contain secrets.
- Handler events describe control flow, not argument values or business success. Browser `invokeAsyncHandler` observes explicitly awaited settlement in `1.3`; it does not implement ambient context propagation or suspension/resumption events. Synchronous helpers record immediate return, including returning a Promise. Session shutdown cannot invent an observed return or resolution.

## Validate a customer capture

From the checked-out repository, after `npm ci`:

```sh
node validate.mjs /absolute/path/to/customer-capture.ndjson
node validate.mjs --help
```

Exit `0`: no contradictions detected (inspect warnings for missing observations). Exit `1`: invalid capture or unreadable file. Exit `2`: no input file. Multiple filenames are validated separately; the viewer can merge imports and check relationships across them. Do not strip failed events or regenerate IDs merely to make validation pass.

The schema validates individual records; `validate.mjs` adds relationships, lifecycle, byte counts, retry and timing checks. It does not establish that captured facts match actual network activity or that every secret was removed.

For contract maintenance only, edit [scripts/build-schema.mjs](../../scripts/build-schema.mjs), run `npm run generate`, then `npm test`. This regenerates the standalone schema, CSP-safe validator and fixtures. Ordinary app integration consumes the contract unchanged.
