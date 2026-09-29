# Customer manual logging — required SDK API

Customers must be able to add logging to existing networking code without replacing the client, installing a tracing framework, or implementing a native interceptor. This is a normative requirement. A runnable Kotlin prototype now implements the core API: see [Android integration and current boundaries](android/README.md) and [the customer-owned sample request](android/app/src/main/kotlin/dev/networklog/app/SampleFlow.kt). The broader API sketches below include planned capabilities; Swift remains a design only.

For Kotlin call sites shared with production, depend on `logger-api`, supply lazy header/body lambdas, and inject `RecordingLogger` only in debug or `NoOpLogger` in release. See the [runnable integration pattern and binary checks](android/RELEASE.md). The direct recorder and API sketches below do not replace that build boundary. The implemented Swift transfer sink/manual demo is described in [iOS setup](ios/README.md); the general Swift capture SDK remains a design.

## Minimum integration

The normal integration is two calls around the existing request:

```text
exchange = session.startRequest(method, url)
response = existingHttpClient.execute(request)   // Customer's existing behavior.
exchange.completeResponse(status, optionalHeaders, optionalBody, optionalEffectiveUrl)
```

`completeResponse` means the native call/body lifecycle has actually completed. If only headers are available and the body is still streaming, record headers and keep the exchange open. If completion cannot be observed, call `stopObservation(reason)` and retain an unknown outcome instead of reporting success.

The recorder supplies:

- All event, recording, trace, and span IDs, sequence numbers, timestamps, and duration calculations.
- A root HTTP span when no method context is supplied. Method/component scopes remain optional.
- A built-in `customer.manual` adapter registered at logger configuration, so customers need no adapter-registration step. Its default attempt visibility is logical; its body support is partial and native metrics are unsupported unless explicitly configured.
- Integrator ownership by default, with an optional component/method label. Unknown callsite is null; no stack capture is required.
- Initial attempt metadata; a `retryOf`/`redirectOf` handle supplies consistent sibling context/index when the customer observes an explicit follow-up. A retry helper retains the prior trace even without a method span.
- Header normalization and redaction, body limits/redaction/encoding/byte counts, and JSON serialization.
- Explicit unavailable states for omitted headers and bodies. An omitted body does not mean no body existed. An unknown effective response URL stays null.
- Nonthrowing, thread-safe terminal handling: first completion/failure/cancellation wins. Later terminal calls are ignored with optional local diagnostics. Logging failures do not replace networking results/exceptions.

The session can use a caller-supplied ID or generate one. Manual and built-in adapters write the same schema. A request must have one instrumentation owner: use manual logging for an uninstrumented request, or pass a shared capture token so an automatic adapter reuses the handle instead of opening a duplicate span. Do not attempt deduplication by URL or timestamp.

## Public convenience methods and defaults

| Method/helper | Required behavior |
| --- | --- |
| `Session.startRequest(method, url, options?)` | Start observation before dispatch; optional parent/component/headers/body/attempt, no mandatory method span |
| `Exchange.receiveResponseHeaders(status, headers?, effectiveUrl?)` | Retain observed status/headers; does not finish the request |
| `Exchange.captureRequestBody(snapshot)` / `captureResponseBody(snapshot)` | Accept bytes already available to the caller or one final bounded stream snapshot |
| `Exchange.completeResponse(status?, headers?, body?, effectiveUrl?)` | Atomically emit any not-yet-recorded final response metadata/body snapshots and end; status may be omitted only if previously recorded. Distinguish EOF from an explicitly declared intentional close |
| `Exchange.fail(error, stage?)` / `timeout(error, stage?)` | End with transport failure, preserving any previously observed HTTP status and partial body |
| `Exchange.cancel(error?)` | End as cancellation, retaining known metadata |
| `Exchange.stopObservation(reason)` | End with `unknown` / `observation_stopped`; reason is included in unavailable capture state or a namespaced diagnostic extension |
| `HeaderCapture.partial(entries, reason)` | Retain a known subset without claiming complete native headers |
| `HeaderCapture.library(entries)` | Full header set exposed by a native API, normalized representation, original-order unknown |
| `BodyCapture.bytes(data, complete = true, reason?)` | Compute sizes/encoding and apply policy; use only bytes the application already has |
| `BodyCapture.none(reason)` | Known absence of content, such as no upload or HEAD/204 |
| `BodyCapture.unavailable(reason)` | Content not exposed, not retained, or not recorded; never fabricate an empty string |
| `BodyCapture.prefix(data, totalBytes?, reason)` | Explicit partial observation; sizes use the same representation and unknown totals remain null |

`completeResponse` uses existing metadata when called after `receiveResponseHeaders`; it must not emit a duplicate final response event. A contradictory second final response is reported through a nonthrowing local diagnostic, not silently overwritten. The recorder defers default unavailable body snapshots until completion so an earlier omission does not prevent later real capture. No helper sends a request, retries, follows redirects, reads a stream, or changes cancellation unless it is explicitly a customer-selected stream-observation wrapper.

For streams, either use the SDK's non-consuming observer wrapper or manually feed the recorder bytes already read/written. Supply at most one final snapshot per direction. Retain bounded prefixes rather than collecting an unbounded body. Close/EOF/error are distinct; an early close marks incomplete capture even when it is an intentional application action.

## Non-HTTP handler calls

Customers can also instrument a local SDK-to-app handoff. `Session.invokeHandler(name, caller, handler, parent) { context -> ... }` observes method entry and exit without requiring any networking. `Session.startHandler` supplies the equivalent manual handle for existing method boundaries. The handler context parents any app-owned HTTP or nested operations; `returned`, `threw`, `cancelled`, and `stopObservation` retain distinct completion semantics. See [HANDLER-TRACING.md](HANDLER-TRACING.md) for runnable sample integration and GUI requirements.

## Kotlin: keep the customer's client

This example assumes an existing custom client whose result already contains the consumed body. The logger does not read the response a second time. `HttpResult` and `existingClient` represent the customer's existing types.

```kotlin
fun executeLogged(request: HttpRequest): HttpResult {
    val exchange = loggingSession.startRequest(request.method, request.url)
    try {
        val response = existingClient.execute(request)
        exchange.completeResponse(
            status = response.statusCode,
            headers = HeaderCapture.partial(response.headers, "caller_supplied_subset"),
            body = BodyCapture.bytes(response.bodyBytes),
            effectiveUrl = response.effectiveUrl // Null if not exposed.
        )
        return response
    } catch (error: kotlinx.coroutines.CancellationException) {
        exchange.cancel(error)
        throw error
    } catch (error: java.net.SocketTimeoutException) {
        exchange.timeout(error)
        throw error
    } catch (error: java.io.IOException) {
        exchange.fail(error)
        throw error
    } finally {
        // No-op if already terminal. Unknown is preferable to invented success
        // if an unclassified application exception escapes this boundary.
        exchange.stopObservation("execution_scope_exited")
    }
}
```

Map errors only when their meaning is known. A client's HTTP-status exception is not automatically a transport failure: capture its response/status/body if the API exposes them. Keep non-network application errors on method operations instead of fabricating network failures.

For direct HttpURLConnection use, capture configuration before the first executing accessor, then add observations to the existing code's response path:

```kotlin
val status = connection.responseCode // Existing call may initiate execution.
exchange.receiveResponseHeaders(
    status,
    HeaderCapture.fromConnection(connection), // Drops null-key status line.
    connection.url.toString()
)
// Keep the application's own getInputStream/getErrorStream selection and reads.
// When bytes are already available:
exchange.captureResponseBody(BodyCapture.bytes(bytesAlreadyRead))
exchange.completeResponse() // After known EOF/complete native response.
```

If the application reads HTTP error bodies through `getErrorStream()`, record them too. If it intentionally closes early, pass a partial body and the intentional-close boundary. If reading throws after headers, call `timeout` or `fail`; the handle preserves the status. Do not invoke response accessors from a logging-only catch path just to discover a status, because they may initiate networking.

For asynchronous custom clients, retain `exchange` in the existing completion callback and report success/error there. Do not end the exchange when enqueue returns. Cancellation callbacks use `cancel`; callbacks that race with cancellation cannot produce duplicate terminal events. Preserve the application's callback arguments, invocation count, and executor.

## Swift: existing URLSession completion handler

These logging methods are proposed nonthrowing SDK conveniences. `loggingSession` is a logging session, distinct from the application's existing `urlSession`. The validated request has a URL before logging begins.

```swift
let exchange = loggingSession.startRequest(
    method: request.httpMethod ?? "GET",
    url: request.url!.absoluteString
)
let task = urlSession.dataTask(with: request) { data, response, error in
    if let http = response as? HTTPURLResponse {
        exchange.receiveResponseHeaders(
            status: http.statusCode,
            headers: .library(http.allHeaderFields),
            effectiveUrl: http.url?.absoluteString
        )
    }
    if let error {
        let native = error as NSError
        if native.domain == NSURLErrorDomain && native.code == NSURLErrorCancelled {
            exchange.cancel(error)
        } else if native.domain == NSURLErrorDomain && native.code == NSURLErrorTimedOut {
            exchange.timeout(error)
        } else {
            exchange.fail(error)
        }
    } else if response is HTTPURLResponse {
        exchange.completeResponse(
            body: data.map { .bytes($0) } ?? .unavailable("body_not_exposed")
        )
    } else {
        exchange.stopObservation("http_response_not_exposed")
    }
    completion(data, response, error) // Original callback, exactly once.
}
task.resume() // Original application scheduling/cancellation policy.
```

A URLSession completion handler can include an HTTP response alongside a transport error while `data` is nil. Capture response metadata first. The logger must not rely on response/data delegate delivery for completion-handler tasks. Authentication delegate behavior is preserved. See [Apple's completion-handler documentation](https://developer.apple.com/documentation/foundation/urlsession/datatask(with:completionhandler:)-e6xv).

For async `data(for:)`, begin before awaiting, record the returned pair on success, and call fail/timeout/cancel in catch while rethrowing the same error. Do not invent a response in catch. For async `bytes(for:)`, receiving the pair only records headers: continue the exchange until iteration ends or throws; a method block can end earlier. For Objective-C, expose equivalent NSObject handles and nonthrowing methods usable from existing completion blocks without a Swift-only task context.

## What the manual examples prove

- [manual-minimal.ndjson](examples/manual-minimal.ndjson) passes with no method spans, missing headers/bodies, and an unknown response URL.
- [manual-observation-stopped.ndjson](examples/manual-observation-stopped.ndjson) retains a known HTTP status without claiming completion.
- [stream-read-timeout.ndjson](examples/stream-read-timeout.ndjson) retains a late read failure after the calling method returns at headers.

The schema and fixtures establish representability. The Kotlin implementation is tested on an Android emulator, including a real manually recorded customer request; see [E2E.md](E2E.md). The [Swift transfer package and limited manual demo](ios/README.md) are implemented and simulator-tested; a general Swift capture SDK and the proposed Swift capture APIs above remain future work. For existing-app installation and customer-specific acceptance checks, use the [integration guide](docs/integration/README.md).
