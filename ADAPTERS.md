# Native adapter contract — draft

The Android and iOS implementations should share the JSON contract and these lifecycle rules. This document is an API proposal, not a claim that the adapters exist.

## Recorder boundary

Keep the recorder independent of an HTTP stack. Platform adapters gather observations; the recorder supplies IDs, immutable context, policy enforcement, event ordering, timestamps, and the file sink.

Conceptual API, to be expressed idiomatically in Kotlin and Swift/Objective-C:

```text
logger.startSession(optionalSessionId, name) -> Session
Session.startRequest(method, url, optionalMetadata) -> Exchange
Session.startOperation(name, owner, component, method, optionalParent) -> Operation
Operation.context -> immutable CaptureContext
Operation.complete(outcome, optionalError)

recorder.startRequest(context, origin, adapter, request, attempt) -> Exchange
Exchange.captureRequestBody(bodySnapshot)
Exchange.receiveResponseHeaders(phase, response)
Exchange.captureResponseBody(bodySnapshot)
Exchange.captureTrailers(direction, headerSnapshot)
Exchange.complete(outcome, applicationOutcome, status, completionBoundary, error)
Exchange.recordMetrics(metrics)
Exchange.stopObservation(reason)

Session.end(reason) -> completion/flush result
```

The names are illustrative. The returned handles own span/session identity. A caller need not thread raw IDs through every callback. Direct custom clients call this interface; native adapters call it automatically. The recorder computes durations. Terminal methods are thread-safe and nonthrowing: the first terminal call wins, later calls are ignored with an optional local diagnostic. Logger failure or a cancellation/completion race must never escape into the customer's networking code.

The public customer API must include session-level request creation, complete-response/fail/timeout/cancel helpers, body helpers, and an explicit observation-stop helper. Method spans, tracing-framework adoption, client replacement, manual adapter registration, and hand-authored JSON are not prerequisites. See [MANUAL-LOGGING.md](MANUAL-LOGGING.md) for Kotlin and Swift examples and the defaults the recorder supplies.

Operation propagation follows coroutine/task context or explicitly passed handles. Do not assume thread-local state survives arbitrary async dispatch. Capturing a callsite is optional evidence; explicit owner/component/method metadata is authoritative when supplied. Keep instrumentation overhead separate from the captured network duration where possible and record the actual observation boundary.

SDK-owned clients are instrumented where they are created. Integrator traffic uses an opt-in wrapper/adapter or direct calls. Registration must avoid wrapping an already instrumented request twice. A per-request internal marker/handle can suppress duplicate instrumentation without adding an outbound header.

## Android: HttpURLConnection/HttpsURLConnection

Offer a logging connection factory or wrapper that retains the public behavior of the selected native connection, including HTTPS-specific methods. Delegation must preserve timeouts, redirect policy, authentication, caching, TLS checks, cancellation/close semantics, and exceptions.

Capture request configuration before execution, then observe bytes through bounded output/input stream wrappers as the application writes and reads. Avoid consuming a one-shot upload or eagerly draining a response solely to obtain a complete log. On premature close, preserve the observed prefix and mark incomplete capture.

The first executing call may be `connect`, `getOutputStream`, `getInputStream`, `getResponseCode`, `getHeaderFields`, or another response/content accessor. Snapshot application request properties before delegating that trigger: `getRequestProperties()` is unavailable after connection. Do not trigger a connection just to obtain logging metadata. Account for native implicit POST when the default GET is used with output enabled; preserve the configured method separately when different and label a derived effective method `method_source: inferred`. A manually supplied method without transport confirmation is `configured`, not a wire observation.

Application-configured request headers are partial (`reason: application_configured_only`); native defaults and cookies may be added later. Skip the null-key status-line entry in `getHeaderFields()`. Use `SystemClock.elapsedRealtimeNanos()` for capture durations so device sleep is included. See [URLConnection](https://developer.android.com/reference/java/net/URLConnection), [HttpURLConnection](https://developer.android.com/reference/java/net/HttpURLConnection), and [SystemClock](https://developer.android.com/reference/android/os/SystemClock).

`getInputStream()` can throw for an HTTP error while `getErrorStream()` contains a useful response body. Distinguish this from a connection failure with no response. Header fields remain available through native header APIs. See [Android HttpURLConnection](https://developer.android.com/reference/java/net/HttpURLConnection).

For opaque automatic retries/redirects, advertise logical-call visibility. Record the effective URL when exposed, but do not infer missing intermediary requests. A custom stack with actual attempt callbacks can advertise individual visibility. Do not change automatic redirect/retry behavior just to improve logs.

## iOS: URLSession/NSURLSession

Cover task construction and task observation paths for the APIs the adapter advertises: async/await, completion handlers, and delegates. A wrapper/delegate proxy must forward application callbacks exactly once, preserve callback queues, authentication handling and cancellation, and avoid changing session behavior.

Retain bounded request Data, instrument supported upload streams/files without eager replay, and observe response Data/delegate chunks or supported download-file completion. A task whose bytes are inaccessible reports unavailable body capture. Session policy determines retention/redaction before any write to the log file.

For completion-handler tasks, obtain response/data observations from that handler; do not expect duplicate response/data delivery through session delegates. On failure, record any supplied HTTPURLResponse before the error even when Data is nil. In async `data(for:)` catch paths, preserve earlier observed metadata if available and otherwise leave status unknown. Task-specific delegates take precedence for overlapping callbacks; preserve the native routing rather than forwarding each callback to two delegates.

`bytes(for:)` returns at headers, so retain its exchange through AsyncBytes EOF, cancellation, or error. The enclosing method block may return earlier. For download delegates, obtain an open file handle before returning the callback if capture must continue off-queue; a queued pathname can become invalid after the application/system moves or deletes the temporary file. Logging must not steal the file or delay the application's ownership. Use a continuous, sleep-inclusive clock and an overflow-safe integer timebase conversion for capture timing.

[URLSessionTaskTransactionMetrics](https://developer.apple.com/documentation/foundation/urlsessiontasktransactionmetrics) provides transaction request/response metadata and native timing/protocol information. Metrics do not replace body observation. Correlate metrics to already observed attempts; if correlation is uncertain, declare logical visibility instead of inventing a pairing. Retain the transaction-array index and redacted request/response snapshots in `http.metrics.transaction`. Partial native phases retain a null endpoint rather than an invented finish. Metrics can be logged after the HTTP terminal event without altering that event's duration.

[HTTPURLResponse.allHeaderFields](https://developer.apple.com/documentation/foundation/httpurlresponse/allheaderfields) exposes a dictionary and may canonicalize header names. Store the available values with library representation and no original-order claim.

`URLProtocol` may be a supplementary integration route for explicitly configured sessions. It must not be the universal foundation: [Apple's protocolClasses documentation](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/protocolclasses) excludes custom URLProtocol subclasses from background sessions. Background task restoration and legacy NSURLConnection support require separate implementation decisions and must not be claimed by an untested adapter.

## Failure and completion rules

- File I/O, redaction, and capture failures must not change application HTTP outcomes or callback counts. Report lost capture through unavailable states/gap counters.
- Use a bounded asynchronous file writer; assign IDs/sequence/observation time before enqueueing. If events are dropped, preserve sequence gaps and emit a drop report when writing resumes.
- Do not read a body twice, alter bytes sent to the server, synthesize a response, or hide an original exception.
- If cancellation happens after headers, retain the known status and classify cancellation separately. If body reading fails after HTTP 200, preserve that status with a transport-error outcome.
- On session close, hold the original session binding for existing work. Emit session.ended after pending capture work is settled or explicitly stop capture; never reassign later callbacks to a new session.
- Receiving headers does not end the HTTP exchange. Keep it open through stream completion/failure/cancellation; end the calling method block separately if it returns at headers. If the caller cannot observe completion, stop with an unknown outcome and retain the known status.

## Suggested native conformance checks

Use controlled local test endpoints when implementations are available. Check successful/error responses, error bodies, empty bodies, binary bytes, repeated query parameters/headers, request cancellation, body read failure, early stream close, redirects, SDK retries, concurrency, and context propagation. Assert application behavior is unchanged alongside validating emitted files against this package.

Record API support and fidelity separately: syntactically valid output alone does not prove that a native adapter observed every request or preserved networking behavior.

Android checks should also cover implicit connect, implicit POST, transparent gzip, null-key status lines, skip/mark/reset, sleep-spanning duration, and cancellation/completion races. iOS checks should cover completion handlers with HTTP metadata plus error, AsyncBytes read failure, partial transaction metrics, multiple native transactions, delegate routing, and download-file lifetime. Default/ephemeral redirect callbacks must not be assumed for background sessions.

Further Apple references: [async URLSession and AsyncBytes](https://developer.apple.com/videos/play/wwdc2021/10095/), [transaction array](https://developer.apple.com/documentation/foundation/urlsessiontaskmetrics/transactionmetrics), [download-file callback lifetime](https://developer.apple.com/documentation/foundation/urlsessiondownloaddelegate/urlsession(_:downloadtask:didfinishdownloadingto:)), and [redirect callbacks](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:)).
