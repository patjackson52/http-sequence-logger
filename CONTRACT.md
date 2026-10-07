# Network and local-control capture contract 1.3 — draft

This document and [event.schema.json](schema/event.schema.json) define a project-specific JSON format. It uses distributed tracing identities but **is not OTLP JSON or HAR**. Future adapters may export those formats with documented loss of custom capture details.

The words **must**, **should**, and **may** distinguish requirements, recommendations, and options within this proposed contract. A Kotlin recorder and Android sample are validated against it; see [E2E.md](E2E.md).

## Scope and structure

Producers are Android development loggers, app-owned iOS capture hooks using the transfer package, and browser debug SDKs. Integrators can supply HTTP wrappers/adapters or call the recorder directly. A local web viewer imports files with approximately 10–20 requests per session and dynamically discovers destination origins.

Each UTF-8 NDJSON line contains one event. Producers must terminate records with LF; consumers also accept CRLF, an optional leading UTF-8 BOM, and a complete last record without LF. A file may contain many sessions, recordings, and interleaved events. No outer JSON array or mandatory file header is used.

Every event must have:

| Field | Meaning |
| --- | --- |
| `schema_version` | Exact current version: `1.3` on every platform |
| `event_type` | Event discriminator from the schema |
| `event_id` | Collision-resistant identity, stable across re-export/replay |
| `session_namespace` | Stable project/environment scope, shared across relevant producers |
| `session_id` | Opaque caller-provided ID, or SDK-generated UUID |
| `recording_id` | Generated ID for one producer's continuous recording period |
| `sequence` | Positive integer assigned in observation order within this recording |
| `timestamp` | UTC wall time with 3–9 fractional digits and `Z` suffix |
| `monotonic_ns` | Decimal string: monotonic nanoseconds since recording start |
| `data` | Payload defined by the event type |

Span events also require `context`; session and capture-gap events must not have it. Optional `extensions` holds namespaced keys, such as `com.example.connection_id`. Unknown core fields are rejected to catch misspellings; producers use extensions until a reviewed schema revision adds a field.

Namespace is configured once on the logger, typically a common project name plus environment. It need not equal an Android package name or iOS bundle ID. A caller provides only a session ID when starting a session; the configured namespace supplies its scope.

## Identity and session lifecycle

The viewer groups sessions by `(session_namespace, session_id)`, then preserves separate `recording_id` periods. Reusing an external instance/session ID intentionally associates recordings; unrelated projects with the same ID stay separate through namespaces. IDs are case-sensitive opaque strings; do not trim, reinterpret, or hash caller-supplied session IDs.

Every startSession invocation generates a recording ID, even when the session ID is reused. Each producer owns its recording and sequences. A request's session/recording binding is immutable after creation. A global mutable "current session" must not reassign asynchronous completions.

`session.started` is sequence `1` at monotonic time `0`. It describes the producer, adapter versions/capabilities, capture policy, session-ID source, and trace-propagation policy. `session.ended` is the last event and reports the reason and number of dropped records. A stopped session may retain unfinished operations; a missing end indicates an interrupted or partial recording, not success.

On normal close, stop accepting new operations, complete or explicitly stop pending capture work, flush terminal/body/metrics records, then emit the session end. Exporting while work is active is valid but produces a partial snapshot. Re-exported records retain event IDs for deduplication.

## Operations, HTTP spans, and relationships

`context` contains a nonzero 32-character lowercase hexadecimal `trace_id`, a nonzero 16-character lowercase hexadecimal `span_id`, a nullable `parent_span_id`, and `parent_scope` (`none`, `local`, `remote`). A root has `none` and a null parent. Every observation of one span retains identical context and recording identity.

One session may contain several independent root operations/traces. A method operation becomes a timed client component block. An HTTP request can be a child span or a root span when the customer does not instrument methods. `Session.startRequest` supplies context and identities automatically; see [manual logging](MANUAL-LOGGING.md). Each explicitly observed retry/redirect gets a new sibling HTTP span; `attempt.previous_span_id` links attempts without falsely nesting one retry inside another.

`operation.started` includes a name and `origin` with owner, component, and nullable method. Owners are `integrator`, `sdk`, `system`, or `unknown`. Do not infer SDK ownership solely from the destination hostname.

HTTP origin has separate `initiator` and `executor` actors. For example, Checkout initiates an SDK verification operation, while VerificationClient executes HTTP. Direct integrator traffic has an integrator executor. Optional callsite data includes evidence source (`explicit`, `stack`, `inferred`), file, line, and function. Unavailable names/lines use null or the explicit unknown owner, not a guessed callsite.

Local parents start before their children. Children can outlive a parent's return when work is asynchronous; the viewer must not fabricate strict lifetime nesting. A missing local parent is an incomplete-data warning. Remote parents may be absent from this file. A span must not parent itself or change identity halfway through a request.

## Local handler invocations

A handler is an ordinary operation span with explicit invocation metadata. It is independent of HTTP and must be representable when there are zero requests or server origins. On `operation.started`, optional `data.invocation` has `kind: handler`, `dispatch: synchronous` or `awaited`, and a `caller` actor. `data.origin` identifies the handler/callee. The parent context, if present, points to the invoking operation and its actor must match `invocation.caller`. The handler span ID distinguishes each invocation; names do not serve as identities.

A handler's `operation.ended` must include `data.completion`: `returned` with outcome `success`, `threw` with outcome `error`, `cancelled` with outcome `cancelled`, or `observation_stopped` with outcome `unknown`. Observation stop requires a nonempty `extensions["capture.observation_stop_reason"]` and no known error. A missing end is an incomplete-data warning, never an inferred return. A normal return does not mean a returned business value was true or accepted. A thrown handler error can be caught by a successful parent.

These completion fields belong only to handler spans. Generic method operations retain their original start/end shape. HTTP calls inside the handler use its context as parent and preserve the actual integrator executor. Their lifetimes remain independent and may extend beyond handler return. For the implemented synchronous handoff, a known caller must still be active at invocation and cannot end before the handler's known exit. The viewer represents the caller waiting for this invocation without claiming all SDK threads are paused.

The Kotlin `invokeHandler` helper records entry/exit around actual customer code. It forwards the identical return object or exception, captures no arguments/return payloads, and runs user code outside the recorder lock. For manual integration, `startHandler` exposes a first-terminal-wins handle. Version 1.2 adds `dispatch: awaited` for an explicitly awaited handler: the terminal boundary records fulfillment (`returned`) or rejection (`threw`) of the awaited value. The viewer calls these resolved/rejected. The caller must remain active until this settlement. This does not claim a blocked thread, implicit context propagation, or suspension/resumption events. A synchronous handler that returns a Promise still ends at its immediate return. General asynchronous enqueue/continuation tracing remains future work.

All events use schema version 1.3. Earlier schema versions are rejected; older capture files are left untouched and are not imported into the new collector. [Handler tracing](HANDLER-TRACING.md) defines the API, rendering requirements, and fixtures. Summary `handler_calls`, `unfinished_handler_calls`, and `unknown_handler_outcomes` are separate from HTTP counters.

## Event vocabulary

| Event | Purpose |
| --- | --- |
| `session.started` | Recording metadata, capabilities, policy, and ID source |
| `session.ended` | Terminal recording boundary and dropped-event count |
| `operation.started` | Integrator/SDK method or handler invocation begins; optional explicit caller |
| `operation.ended` | Method outcome/duration; explicit handler return, unwind, or observation-stop boundary |
| `http.request.started` | Request metadata, source attribution, adapter, and attempt linkage |
| `http.response.headers` | One informational or final HTTP response header observation |
| `http.body.captured` | Terminal capture snapshot for the request or response body |
| `http.trailers` | Optional request/response trailer snapshot, when exposed |
| `http.ended` | HTTP outcome, status if known, duration, completion boundary, and transport error |
| `http.metrics` | Optional platform transaction measurements; may arrive after HTTP end |
| `capture.gap` | Explicit producer report of dropped observations |

Normal nonstreaming order is request start → request-body snapshot → response headers → response-body snapshot → HTTP end. Duplex traffic may interleave request/response capture. There is at most one terminal body snapshot per direction and at most one final response per HTTP span. Repeated informational responses are allowed. Status `101` is treated as final; subsequent upgraded-protocol messages are outside v1.

Response headers are observations, never a successful HTTP terminal boundary. Keep the exchange open through body EOF, intentional close, read failure, or cancellation. A calling method operation may end at headers and its HTTP child may outlive it. This preserves late stream failures after HTTP 200. If the caller cannot observe subsequent completion, it can explicitly stop with outcome `unknown` and boundary `observation_stopped`; retain any known status. No body/trailer observations follow HTTP end. Native metrics may arrive later, before the session ends, without rewriting the HTTP outcome or duration.

## HTTP inventory and derivation

| Information | Canonical source |
| --- | --- |
| Method | `http.request.started.data.request.method`, preserved as observed |
| Method source | Optional `method_source` (`observed`, `inferred`, `configured`) and `configured_method`; absent source is unspecified |
| Initial URL | Request-start `request.url` |
| Effective response URL | `http.response.headers.data.response.url` |
| Exact request target | Optional `request.request_target` retains observed/configured target, source details, and redaction flag, including `*` or authority-form targets |
| Scheme, hostname/domain, port, path, query | Derived with a URL parser from the corresponding URL |
| Query ordering/repeated keys/escaping | Retained URL; display a name/value array rather than an object |
| Request/response headers | Respective `headers.entries`, as ordered name/value/redacted entries |
| Request/response payload | Corresponding terminal `http.body.captured` record |
| HTTP status and optional status text | Final response record; terminal event repeats the status for consistency checking |
| Start, headers observed, capture completion, end | Respective lifecycle event timestamps |
| Local elapsed duration | End monotonic time minus start monotonic time |
| Protocol, remote peer, cache source, connection reuse, native phases | Optional `http.metrics`; null means not observed |
| Code ownership, component, callsite | Operation origin and HTTP origin |
| Retries/redirects | Attempt linkage and separate observable spans |

Request URLs must be absolute HTTP(S) URLs with a host, without userinfo or a fragment. Response URL may be null when the integration cannot observe the effective URL; do not silently substitute the original request URL after a possible redirect. Non-null response URLs obey the same rules. An exact request-target, when exposed, is separate from the absolute URL and preserves forms that a URL alone cannot describe. A configured query redactor replaces sensitive values in both URL and request-target before recording, preserving names/order/escaping of unaffected values; their redaction flags advertise the transformations. Original redacted values cannot be derived. A literal URL fragment is not part of the HTTP request target.

Headers are arrays even when the source API exposes a dictionary. `representation: library` means the native API may already have normalized/coalesced headers; `order_preserved: false` prevents an exact-wire claim. Arrays preserve duplicates only if the adapter actually observes them. Availability `partial` retains a known subset with a required reason, such as `application_configured_only` or `caller_supplied_subset`; native Host/cookie/default fields may be unobserved. `captured` means the complete set exposed at the stated observation boundary, not necessarily original wire fields. Unavailable headers have no entries and a reason. Each redacted value is flagged. Trailers use the same representation. Do not map Android's null-key status-line entry into an ordinary header.

The viewer groups destination lanes by normalized origin `(scheme, hostname, effective port)` and displays hostname labels. Paths on the same origin share a lane. Keep the source URL intact for inspection; do not overwrite it with a normalized lane label. A cache-served request can retain its destination lane but should display its cache source.

## Body representation, limits, and redaction

Every finished HTTP capture should emit one body-state record per direction, including empty/absent/unavailable bodies. If records are missing from a partial capture, importers report unknown capture state rather than silently treating the body as empty.

`availability` is `captured`, `unavailable`, or `not_applicable`. `truncated` and `redacted` are independent booleans so both conditions can hold. Missing capability, unread data, a failed stream, or a native API restriction is recorded with a reason.

`content` is inline data encoded as `utf-8` text or canonical padded `base64`. Do not parse and reserialize JSON as the canonical body: that loses whitespace, duplicate keys, and numeric spelling. Parsed JSON is a derived viewer display. Partially captured JSON may be invalid JSON and must remain inspectable as text.

| Body field | Meaning |
| --- | --- |
| `representation` | `application`: bytes/text delivered by the API, possibly decoded; `encoded`: observed content-encoded HTTP payload. Neither claims TLS packets or HTTP framing |
| `media_type`, `charset`, `content_encoding` | Observed metadata; null if unknown. Charset describes retained textual content; use base64 to preserve other bytes exactly |
| `observed_bytes` | Bytes seen by the adapter, in this representation, before redaction/retention limits; null if not measured |
| `total_bytes` | Complete body size in the same representation if established; null if unknown |
| `stored_bytes` | Retained bytes after redaction/limits, measured as UTF-8 bytes or decoded base64 length |
| `truncated` | Captured representation is incomplete, including unread/failed stream endings |
| `redacted` | Retained content differs because a redaction policy was applied |
| `reason` | Required for unavailable/not-applicable/truncated content; examples: `no_response`, `body_limit`, `stream_failed`, `body_not_consumed` |

A redaction may increase stored length, so stored size is not always bounded by observed size. Do not infer decoded body size from `Content-Length`. `not_applicable` has null content, zero byte counts, and a reason, e.g. HEAD/204 or no request body. A known empty representation may instead be captured with an empty string and zero bytes. `unavailable` carries no retained content; observed/total bytes may still be known independently.

When both sizes are known, observed bytes cannot exceed total bytes, even when content is unavailable. A complete captured representation must have observed bytes equal to total bytes when both are known; its stored bytes must also equal the total when unredacted. Unknown sizes remain null. This prevents unread trailing bytes from being labeled a complete payload.

Apply redaction before persistence and before generating previews. The development profile records its limits and redaction selectors in session metadata. Producers should buffer within a configured bound and use a format-aware redactor; if safe redaction cannot be completed, emit unavailable content with a reason instead of retaining the original secret. Capture failure must not change the application request result.

V1 files are self-contained: small text bodies or bounded base64 are inline. External body attachments are deferred to a versioned extension. This keeps a copied NDJSON file sufficient for inspection.

## Timing and outcomes

Capture timestamps describe recorder observations. Sequence allocation and monotonic timestamps must agree even when callbacks originate on multiple threads. Assign them before asynchronously writing the file. Durations use the recording's monotonic clock, not wall-clock subtraction. Nanosecond values are strings to avoid JavaScript integer precision loss. Do not compare monotonic origins across recordings or machines.

Use a monotonic clock that includes device sleep: Android `SystemClock.elapsedRealtimeNanos()` (API 17+), or an appropriately converted elapsedRealtime fallback on older supported systems; iOS a continuous clock such as `mach_continuous_time()` with its timebase conversion. Do not substitute an uptime clock that pauses during sleep. Allocate the clock sample and sequence consistently under a short synchronization boundary, separately from asynchronous file I/O. Use overflow-safe integer conversions and relative recording origins.

The HTTP start is the adapter-observed start of its request operation/attempt, not proof of the first byte sent. Native phase measurements describe finer transport timing when available. Platform phase timestamps retain their source wall-clock values; a clock adjustment is a warning, not evidence of negative network latency. A phase may have a null start or end, but not both; retain partial phases after failure and calculate no duration without both endpoints. Missing DNS/TLS phases are not zero-duration phases.

`http.metrics.transaction`, when non-null, includes a native transaction index and nullable redacted request/response snapshots. Preserve each URLSession task's transaction-array index, even when only one logical HTTP span is observable. Do not construct retrospective request spans with fabricated observation timestamps. An index occurs at most once per HTTP span. For aggregate metrics or unknown transaction identity use null. Apply ordinary URL/header redaction to metric snapshots too; the viewer can display these subordinate transactions separately from directly observed requests.

`http.ended.duration_ns` is exactly its event monotonic time minus request-start monotonic time. `end_reason` states whether the boundary was body EOF, body close, transport failure, cancellation, or observation stopped. An observation-stop duration measures the observed interval only; it is not a completed network duration. Client duration does not establish server processing duration.

| HTTP outcome | Meaning |
| --- | --- |
| `success` | Final HTTP status below 400; transport completed to the declared boundary |
| `http_error` | Final status 400–599; body remains inspectable; no fabricated transport exception |
| `transport_error` | Transport failure with structured error details |
| `timeout` | Deadline failure with structured error details |
| `cancelled` | Intentional caller cancellation; separate from an HTTP error |
| `unknown` | Capture intentionally stopped before transport completion could be observed; no inferred success |

`status_code` is null if no final response was observed, never zero. A transport failure may retain a known 200 status if reading the body failed after headers. `application_outcome` independently records `success`, `error`, or `unknown`; a 200 can therefore contain an application failure. Method outcomes are separately `success`, `error`, or `cancelled`, so a successful retrying method may contain a failed HTTP attempt.

Known error statuses still contribute to the failure count when transfer completion is unknown. Unknown-outcome and failed-request counts can therefore overlap. Intentional stop does not erase an observed 400/500 response.

This display classification is intentionally distinct from OpenTelemetry span-status mapping; an OTLP exporter must apply that specification's semantics rather than copy these enums blindly.

## Attempts and adapter capabilities

Session metadata declares attempt visibility (`individual` or `logical`), body support, and native-metric support for each adapter/version. Every request names its adapter and preserves its attempt visibility.

An `individual` span represents one observable transport attempt. `logical` represents a whole opaque native call, with potentially hidden internal retries/redirects. Initial index is zero; observable retry/redirect/auth-challenge calls increment it and link the previous sibling span, which must have ended first. An attempt chain must keep the same visibility level.

For example, SDK retry logic may explicitly call HttpURLConnection twice: these are two linked logical spans, even though each native call could hide transport attempts. Their indexes count the observable calls only. A native redirect hidden inside one logical call creates no additional span. Do not fabricate physical attempts from elapsed time or the final URL.

Unavailable individual body/metric observations still require explicit capture states where applicable. A capability is not a guarantee of data availability for every task; cancellation, redirect-body restrictions, or early stream closure may limit any individual exchange.

## Import and validation

The JSON Schema checks individual records. The reference validator additionally checks identities, per-recording order, duration consistency, statuses, body bytes, attempt links, and supported native capture claims.

Importer rules:

1. Parse each line and validate it before incorporating it. Unsupported schema versions or malformed interior lines are errors.
2. Recover preceding records when a final non-newline-terminated JSON line is incomplete; surface a warning. Do not silently repair interior corruption.
3. Deduplicate identical event IDs, treating JSON object key order as insignificant. Conflicting content under the same event ID is an error.
4. Group by recording and reconstruct observation order using sequence. Physical line order and upload order need not match callback order.
5. Preserve sequence gaps, missing parents, missing starts/ends, and dropped-record reports as warnings. Render unfinished/orphan observations explicitly.
6. Treat contradictory identities, duplicate terminal events, changed sessions, bad durations, inconsistent statuses, and invalid body byte counts as errors.
   Informational responses must precede the final response within their observed HTTP span.
7. Render all imported labels and payloads as text. File contents do not authorize executing markup, resolving links, or fetching a remote body.

The reference validator is a contract aid, not a hardened large-file ingestion service. It reads the whole file in memory. Byte/file limits and worker-based parsing belong in the later viewer. Its success means the implemented checks found no contradictions; it does not establish native capture completeness or accuracy.

## Distributed server correlation and format changes

Keep trace IDs from day one. Propagation is disabled by default; integrators can enable an origin allowlist. Session IDs are not automatically transmitted. Native instrumentation should share an existing tracing context when available instead of replacing an application's tracing provider.

W3C `traceparent` carries the current client span as the remote parent. An instrumented server uses a distinct server span ID under that parent. Trace/span relationships, rather than session IDs or timestamp proximity, identify the shared exchange. The collector retains both observations and original clocks. Outbound HTTP spans count as HTTP requests; incoming server spans describe request handling as operations rather than duplicating the client HTTP count.

Schema 1.3 admits `producer.platform: server` with optional `service_name`, `environment`, and `runtime` metadata. `operation.started.data.span_kind` distinguishes `server` and `internal` work; `http.request.started.data.span_kind: client` identifies outbound calls. Every operation owns its span; remote parent links cross recordings while local links remain within one recording. The viewer resolves unique trace/span identities without merging source clocks.

`log.message` carries application-sanitized `message` and `level`. A complete `context` attaches it to a span; `data.trace_id` preserves trace-only association without inventing a span or parent. Mapped raw logs preserve stable source references and mark unavailable monotonic clocks. Plain messages never synthesize HTTP lifecycles or durations. Collection and parsing are independently extensible, with bounded jobs and explicit sampling/truncation/parse diagnostics.

Server records keep original source, session, recording, and event identities. Client sessions are entry points into related trace snapshots rather than owners of rewritten server events. W3C propagation to configured first-party origins joins actual observations; URLs/time proximity and trace IDs alone do not establish server timings or retroactively correlate old logs. Raw HAR/OTLP import remains future work.

Before an incompatible format change, bump the major schema version. Even additive core fields need an updated schema/version and importer capability declaration because v1 rejects unknown core fields. Use namespaced extensions for optional vendor metadata in the meantime.

## Primary references

- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/release-notes) and [Ajv schema support](https://ajv.js.org/json-schema.html) for structural validation.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) for trace/span identity propagation.
- [OpenTelemetry HTTP conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/) for standard HTTP attributes, attempt semantics, and exporter mapping.
- [HAR 1.2](https://www.softwareishard.com/blog/har-12-spec/) for a future HTTP archive adapter.
- [Android SystemClock](https://developer.android.com/reference/android/os/SystemClock) and [Apple continuous time](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time) for elapsed time that includes device sleep.
- [HTTP informational responses](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.2) for interim-before-final ordering.

## Browser producer (1.3)

The sole supported event version is 1.3, including `producer.platform: web` and awaited handler dispatch. Browser and native recordings may coexist in one capture. Source registration, pairing, upload and ACK use transfer version 2, independently of the event version.

The browser observes logical Fetch/XHR calls: browser-added request headers, cookie details, filtered response headers, redirects, preflights and hidden attempts are not fabricated. Header sets are partial. Fetch opaque/opaque-redirect status 0 becomes unavailable status and an unknown observation, not an HTTP response or success. A CORS failure does not establish whether a server processed the request. Trace propagation remains disabled by default.

Fetch helpers consume only when the application requests consumption, without cloning/teeing/draining. Native EOF completes HTTP before application JSON parsing; parsing errors are not transport failures. XHR load/error/abort/timeout determines the observed terminal boundary. Parsed XHR JSON/Blob/Document bodies may be withheld rather than reconstructed as original bytes. Text snapshots count the UTF-8 representation of application-visible strings; ArrayBuffer snapshots count application bytes. Neither is a wire-size measurement, and Content-Length cannot substitute for observed bytes.

Browser relative time comes from `performance.now()`, recorded as integer nanosecond units with reduced browser precision. Some engines pause this clock through system sleep; browser durations do not inherit the native continuous-clock guarantee. Wall time remains a separate observation. Error messages/stacks are withheld. Capture/body/header bounds and privacy exclusions are stated in producer policy and availability reasons.
