# JSON format and API authority

Captures are **UTF-8 NDJSON**: one JSON event per line, newline-terminated by producers, with no outer array. This is a custom draft event format, not HAR, OTLP JSON, Logcat text, a connection configuration, or a dump of arbitrary request objects.

## Read only what the integration needs

| Question | Source of truth |
| --- | --- |
| Required fields, types, enums, per-event schema | [schema/event.schema.json](../../schema/event.schema.json), JSON Schema 2020-12, current `$id` `urn:mobile-network-log:event:1.2` |
| Identity, ordering, missing metadata, bodies, times, outcomes | [CONTRACT.md](../../CONTRACT.md) |
| HTTP wrappers/manual capture fidelity | [ADAPTERS.md](../../ADAPTERS.md) and [MANUAL-LOGGING.md](../../MANUAL-LOGGING.md); check implemented API below |
| SDK/app local call, return, throw, cancel, parenting | [HANDLER-TRACING.md](../../HANDLER-TRACING.md) |
| Callable Android shared API | [Logging.kt](../../android/logger-api/src/main/kotlin/dev/networklog/api/Logging.kt) |
| Callable Android recorder/transfer | [NetworkLog.kt](../../android/logger/src/main/kotlin/dev/networklog/logger/NetworkLog.kt), [RecordingLogger.kt](../../android/logger/src/main/kotlin/dev/networklog/logger/RecordingLogger.kt), [DebugTransfer.kt](../../android/logger/src/main/kotlin/dev/networklog/logger/DebugTransfer.kt) |
| Callable Swift transport | [NDJSONTransferSink.swift](../../ios/Sources/NetworkLogTransfer/NDJSONTransferSink.swift), [TransferConnection.swift](../../ios/Sources/NetworkLogTransfer/TransferConnection.swift) |
| Callable browser API and debug implementation | [api.d.mts](../../web-sdk/src/api.d.mts), [index.d.mts](../../web-sdk/src/index.d.mts), [recorder.mjs](../../web-sdk/src/recorder.mjs), [adapters.mjs](../../web-sdk/src/adapters.mjs); [integration guide](WEB.md) |
| Browser storage and same-origin delivery | [storage.mjs](../../web-sdk/src/storage.mjs), [transfer.mjs](../../web-sdk/src/transfer.mjs), Node-only [dev-relay.mjs](../../web-sdk/dev-relay.mjs) |
| Pairing JSON, HTTP endpoints, ACKs, browser SSE | [transfer protocol](../transfer/PROTOCOL.md); transfer version is `1`, independent of capture schema |
| Valid/invalid relationships and cross-event validation | [shared/validate.mjs](../../shared/validate.mjs); command entry [validate.mjs](../../validate.mjs) |
| Focused synthetic examples | [examples/manifest.json](../../examples/manifest.json), [manual-minimal](../../examples/manual-minimal.ndjson), [handler-http](../../examples/handler-http.ndjson), [stream-read-timeout](../../examples/stream-read-timeout.ndjson) |
| Actual native captures | [samples/live/manifest.json](../../samples/live/manifest.json), [transfer captures](../../samples/transfer/README.md) |
| GUI interpretation/design | [viewer/README.md](../../viewer/README.md), [design history](../design/README.md); design images do not define runtime APIs |

The schema accepts event versions `1.0`, `1.1` and `1.2`. Explicit synchronous handler invocation/completion requires `1.1` or later. Browser producers and `dispatch: awaited` require `1.2`. Use one version for **all events in a recording**. Android emits `1.1`; the limited Swift demo emits `1.0`; browser capture emits `1.2`. Proposed metrics, redirect, propagation, or Swift capture APIs in specifications are not necessarily exposed by an SDK. Do not infer implementation from a schema field or a pseudocode snippet.

## Producer rules agents must preserve

- `session_namespace` and `session_id` group sessions; `recording_id` separates recording periods even when a caller reuses a session ID. Allocate globally unique event IDs and increasing per-recording `sequence` values serially across concurrent events.
- Record UTC timestamps and monotonic durations. Nanoseconds are decimal **strings**, not JSON floating-point numbers. Never compare monotonic clocks from different devices/recordings as one shared clock.
- Method/handler/request parentage is explicit through trace/span context. Repeated URLs do not establish request identity. Transport replay keeps the same event IDs and timestamps.
- Preserve repeated headers and query parameters. Capture what the client exposes, marking partial/unavailable fields honestly. Logical native calls can hide attempts; do not fabricate per-hop redirects/retries or wire-level completeness.
- HTTP response headers are not body completion. Preserve HTTP status when later body read fails; distinguish HTTP error, timeout, transport failure, cancellation, intentional close and stopped observation.
- Sanitize before canonical storage, spool, or upload. The transfer sink performs limited envelope checks and the viewer renders existing content; neither replaces a capture/redaction policy. JSON-valid data can still contain secrets.
- Handler events describe control flow, not argument values or business success. Browser `invokeAsyncHandler` observes explicitly awaited settlement in `1.2`; it does not implement ambient context propagation or suspension/resumption events. Synchronous helpers record immediate return, including returning a Promise. Session shutdown cannot invent an observed return or resolution.

## Validate a customer capture

From the checked-out repository, after `npm ci`:

```sh
node validate.mjs /absolute/path/to/customer-capture.ndjson
```

Exit `0`: no contradictions detected (inspect warnings for missing observations). Exit `1`: invalid capture or unreadable file. Exit `2`: no input file. Multiple filenames are validated separately; the viewer can merge imports and check relationships across them. Do not strip failed events or regenerate IDs merely to make validation pass.

The schema validates individual records; `validate.mjs` adds relationships, lifecycle, byte counts, retry and timing checks. It does not establish that captured facts match actual network activity or that every secret was removed.

For contract maintenance only, edit [scripts/build-schema.mjs](../../scripts/build-schema.mjs), run `npm run generate`, then `npm test`. This regenerates the standalone schema, CSP-safe validator and fixtures. Ordinary app integration consumes the contract unchanged.
