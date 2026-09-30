# Kotlin Android SDK and sample

This runnable sample integrates the draft 1.1 recorder with native `HttpURLConnection`, a small demo auth SDK, customer-owned networking code, and optional durable transfer to the local web collector. Source is MIT licensed. Android API 26+; no Java source/API examples are maintained.

To integrate a customer's existing application, start with the [agent-oriented source-install and wiring guide](../docs/integration/ANDROID.md). This page primarily runs and explains the repository sample.

## Modules

- `logger-api`: small Kotlin interfaces, lazy capture descriptors, and `NoOpLogger`, with no recorder or I/O dependencies.
- `logger`: debug-only recorder, JSON capture policy, NDJSON file sink, durable file/HTTP transfer sink, and optional `LoggingHttpClient` built on native HttpURLConnection. `RecordingLogger` adapts it to the shared API.
- `demo-auth`: `DemoAuthSdk` and its own HTTP client, which call two independent origins and depend only on `logger-api`.
- `app`: debug logging UI and a separate production UI around the same business flow, an app-owned manually instrumented connection to a third origin, and native tests.

Use [debug-only integration and release verification](RELEASE.md) for production setup, lazy manual recording, R8/ProGuard rules, and binary audits. The sample's Release build includes only the API/no-op; recorder code and logging resources are excluded even without shrinking. Both builds apply explicit backup/device-transfer exclusions to app storage.

## Build and run

The fastest path, once Node dependencies and Android build tools are installed:

```sh
npm ci
npm run android:live
```

This builds and installs the debug sample, automatically picks the single connected phone (or sole emulator), configures USB streaming, opens http://127.0.0.1:4319/ and runs a sign-in. `-- --recovery` runs the 401 scenario; `-- --no-run` opens the app without starting a flow; `-- --no-open` skips opening a browser. With multiple phones, supply `-- --device SERIAL`. The process keeps the collector running until Ctrl+C. Repeated runs reuse the collector in the same directory; `--dir` and `--port` are optional overrides, not required setup.

The debug activity consumes a `networklog.run` intent extra once, so rotation does not restart the flow. Release code does not include that launcher behavior. The lower-level build/install commands follow for IDE workflows.

Use JDK 17, Android SDK Platform 35, and an API 26+ device/emulator. Gradle 8.14.3 (checksum verified), AGP 8.13.2, and Kotlin 2.2.20 are pinned. Gradle downloads the pinned dependencies on the first build.

```sh
# From the repository root. Set JAVA_HOME to a JDK 17 installation if necessary.
# Set ANDROID_HOME to your Android SDK, or create android/local.properties with sdk.dir=...
./android/gradlew -p android :app:assembleDebug :logger:testDebugUnitTest
adb devices
export ANDROID_SERIAL=emulator-5554 # Choose your device, not necessarily this example.
adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_SERIAL" shell am start -n dev.networklog.sample/dev.networklog.app.MainActivity
```

Tap **Run successful sign in** or **Run with 401 → refresh → retry**. Supply an optional opaque session ID; an empty field generates a UUID. A flow continues across Activity recreation through a process-scoped worker; process termination can leave an intentionally incomplete capture. The app shows that failure without inventing completed requests.

Each run writes `files/captures/capture-<time>.ndjson` in private app storage. **Export structured log** opens Android's document picker. Captures remain local until a collector is paired or a file is exported. A paired debug collector receives events automatically, while the local export stays available. Multiple sessions can share a sink, as demonstrated by the live test.

## Pair the development collector

Start the repository's collector, then paste its connection JSON into **Pair desktop collector**. The bearer token is saved only in private `files/network-log/connection.json`; it is never placed in a capture or URL. **Disconnect** removes pairing and stops the sample's retained upload workers. Pairing can also be installed by desktop tooling using `run-as` in a debuggable app. The factory ignores pairing entirely when `ApplicationInfo.FLAG_DEBUGGABLE` is absent.

For an Android emulator or USB-connected device, forward the collector port:

```sh
adb -s "$ANDROID_SERIAL" reverse tcp:4319 tcp:4319
```

Use the collector's `http://127.0.0.1:4319` connection JSON with that route. Cleartext transfer is accepted only for loopback destinations; the sample has a debug-only network security configuration for localhost/127.0.0.1/::1. Release resources do not include that exception. LAN pairing uses HTTPS. When the JSON includes `certificate_sha256`, the sender requires the exact DER leaf-certificate SHA-256 fingerprint, current certificate validity, and the platform's hostname verification. No global trust or hostname checks are changed. Redirects are never followed, and the sender uses native HttpURLConnection directly so it cannot recursively record its own uploads.

Development source sets can choose the transfer sink directly on a worker thread:

```kotlin
val connection = TransferConnection.parse(pastedConnectionJson)
FileHttpEventSink(captureFile, connection).use { sink ->
    val logger = NetworkLog(sink, appId = "your.app")
    val session = logger.startSession("Checkout")
    // Existing manual logging and SDK adapters are unchanged.
    session.end()
    sink.awaitUploaded(2_000) // Optional worker-thread wait; false means data remains local.
}
```

Or use `DebugTransfer.open(context, captureFile)` to select the configured transfer sink or a plain local file sink. The returned `DevelopmentCaptureSink` supports the same `EventSink` API and an optional `awaitUploaded` helper.

Each append writes and fsyncs a complete NDJSON record before returning. HTTP executes on a private worker; small batches are scheduled within 200 ms. A batch contains at most 500 events/1 MiB. Only HTTP 200 with the paired collector ID and acknowledgments for every submitted event advances the saved offset. Offset state is scoped to collector origin/identity and the file's identity and acknowledged prefix hash. Truncation, replacement, or a changed collector causes replay using the original event IDs. The collector deduplicates retries. A partially written final line is removed on reopen; complete preceding lines remain intact.

The default spool retains at most 16 MiB **per file**, including acknowledged records so export remains complete. It never evicts unacknowledged records. New records beyond the limit are rejected through the recorder's existing dropped-event diagnostics; export/rotate files explicitly. The spool, sidecar state, and exclusive writer lock are private local files. Do not open the same spool in two senders.

Transient failures retry with bounded 500 ms–30 s backoff. Permanent 4xx rejection retains the file and emits a credential-free diagnostic; `retryNow()` resumes after the problem is corrected. `close()` stops delivery without waiting for network completion, leaving all unacknowledged bytes durable. Reopening the same file resumes delivery. The sample reopens pending captures at startup, after pairing, and after each run; it considers the latest 16 capture files and keeps those senders alive for reconnects. Older files remain exportable and can be reopened explicitly with `FileHttpEventSink`. Android process termination stops workers; delivery resumes when the app starts again. This development implementation does not claim OS-scheduled background delivery.

## Transfer verification

The deterministic JVM tests cover ACK mismatches, retries, offline close/reopen, a changed collector, stale in-flight ACKs after spool replacement, size/count bounds, interrupted final lines, and HTTP redirect refusal.

With a collector on port 4319 and optional pinned HTTPS on 4320, run:

```sh
ANDROID_SERIAL=emulator-5554 ./android/scripts/run-transfer-e2e.sh \
  artifacts/transfer/connection-loopback.json artifacts/transfer/connection-lan.json
```

This explicitly runs the real recovery SampleFlow, disconnects/reconnects ADB forwarding to test offline persistence across instrumentation processes, verifies the debug factory remains disabled for a non-debuggable context, and checks correct versus incorrect TLS pins when the second connection file is supplied. It keeps capture exports and test output under ignored `artifacts/transfer/`. Connection files must remain private and must not be committed.

## Demo scenario

| Step | Owner | Service | Meaning |
| --- | --- | --- | --- |
| Generate challenge | DemoAuthSdk | httpbin `/uuid` | Public demonstration correlation ID |
| Acknowledge challenge | DemoAuthSdk | httpbin `/anything/challenge` | JSON echo; no identity or possession proof |
| Login | DemoAuthSdk | DummyJSON `/auth/login` | Public fake account `emilys` / `emilyspass` |
| Read profile | DemoAuthSdk | DummyJSON `/auth/me` | Bearer token supplied only to DummyJSON |
| Optional rejection | DemoAuthSdk | DummyJSON `/auth/me` | Deliberately invalid token produces HTTP 401 |
| Refresh | DemoAuthSdk | DummyJSON `/auth/refresh` | Exchange the demo refresh token |
| Confirm/retry | DemoAuthSdk | DummyJSON `/auth/me` | Successful profile; recovery links to rejected request |
| Invoke app handler | SDK → CustomerTaskHandler | Local method call | Explicit handoff while `authenticate` remains active |
| Load sample task | CustomerTaskClient inside handler | JSONPlaceholder `/todos/1` | Customer connection uses manual recording with handler parent |
| Return / accept task | Handler → DemoAuthSdk | Local method return and SDK method | Explicit `returned` boundary, then `acceptTask` |
| Complete demonstration | DemoAuthSdk | httpbin `/anything/receipt` | Echo a synthetic receipt; no server-side persistence |

The normal run has **8 requests**. Recovery has **9**, with one expected 401 and an overall successful operation. All use HTTPS. This is an auth-style orchestration example, **not OAuth, phone verification, or production identity verification**. The public endpoints do not trust each other or enforce a shared security decision. No real credentials or phone numbers are required. Tokens never go to the echo or task services.

The services are free and need no keys or dashboard setup. Their implementations are publicly available:

- [DummyJSON authentication](https://dummyjson.com/docs/auth) · [source](https://github.com/Ovi/DummyJSON)
- [httpbin service](https://httpbin.org/) · [source](https://github.com/postmanlabs/httpbin)
- [JSONPlaceholder service](https://jsonplaceholder.typicode.com/) · [source](https://github.com/typicode/jsonplaceholder)

Public services can be unavailable or rate limited. Live tests intentionally fail on unexpected status/content; they never substitute fabricated success data. Unit tests use controlled connections and need no network.

## Trace a supplied app handler

The sample constructs `DemoAuthSdk` with a `TaskHandler`. Inside `authenticate`, the SDK uses `session.invokeHandler(...)` to call it. The app uses the supplied handler context for its existing HTTP client. On method exit, the recorder writes an explicit `returned`, `threw`, or `cancelled` boundary before SDK code continues. Session shutdown records `observation_stopped` instead of a return. This tracing works even when the handler makes no HTTP calls.

See [handler API, format, and GUI mapping](../HANDLER-TRACING.md). The sample now has two additional local progress steps; its HTTP request counts remain 8 and 9.

## Add logging to a customer's existing client

For code shared with production, use the [small API and lazy metadata suppliers](RELEASE.md#manual-recording-in-shared-code). The direct-recorder example below belongs in debug sources.

```kotlin
val sink = NdjsonFileSink(file) // New file; keep open to record multiple sessions.
val logger = NetworkLog(sink, appId = "your.app")
val session = logger.startSession("Checkout", sessionId = existingSessionId)
val exchange = session.startRequest("GET", requestUrl)
try {
    val response = existingClient.execute(request)
    // The existing client has already consumed the complete body.
    exchange.completeResponse(
        status = response.status,
        headers = HeaderCapture.partial(response.headers),
        body = BodyCapture.bytes(response.bodyBytes, "application/json"),
        effectiveUrl = response.effectiveUrl
    )
} catch (error: java.net.SocketTimeoutException) {
    exchange.timeout(error)
    throw error
} catch (error: java.io.IOException) {
    exchange.fail(error)
    throw error
} finally {
    exchange.stopObservation("customer_scope_exited") // No-op after a terminal call.
}
session.end()
sink.close()
```

Use `receiveResponseHeaders` if the body continues streaming, then complete only after EOF/intentional close; errors after headers retain the status. Customers can label a request using `Actor(owner, component, method)` and optionally supply an operation's context. A method block is never required. For custom asynchronous clients, retain the exchange in the existing callbacks and call `cancel` on native cancellation. Handles are synchronized; the first terminal observation wins. Logging does not change the client's callbacks, request, or cancellation behavior.

The sink writes and flushes synchronously, so invoke capture operations on a worker thread. This sample's entire flow runs on a dedicated worker. Reuse one sink for concurrent sessions targeting one file; constructing a new `NdjsonFileSink` replaces that file. Sink failures are reported through an optional diagnostic and do not replace network results. After a sink write failure, the file may be incomplete and must be validated. Session creation/configuration and file opening can report invalid configuration or filesystem failures before any request begins.

Use either `LoggingHttpClient` or manual recording for a request, not both. This prototype does not implement shared capture tokens for deduplicating automatic/manual instrumentation.

## Capture fidelity and deliberate boundaries

- Header arrays preserve values exposed by the native library. Configured request headers are marked partial; implicit native headers are not invented. DNS/TLS timing and hidden native retries are not claimed.
- `LoggingHttpClient` is an opt-in, bounded client, not a drop-in HttpURLConnection subclass. It disables redirects, sets connect/read timeouts, consumes at most 1 MiB of response, and rejects GET bodies to prevent implicit native POST rewriting. Use the manual API to keep an existing client's behavior.
- JSON body fields are redacted recursively before serialization. Passwords, access/refresh tokens, auth/cookie headers, configured query keys, and several echoed device/network identifiers are removed. The response used by the application is unchanged. Field-based policy is not a universal secret detector; configure keys for your schema.
- Malformed/partial JSON and text/binary bodies are withheld by default with an explicit reason. Customers can deliberately opt into `CapturePolicy(allowUnstructuredBodies = true)` for text/binary/partial bodies already known to be appropriate for logging. Those bodies use base64 and receive no field redaction. Retention is bounded; byte counts distinguish observed, total, and stored bytes.
- Redacted JSON retains structure; unchanged JSON retains its original text. Oversized sanitized output is stored as a bounded base64 prefix. A complete JSON input above 1 MiB is withheld to bound redaction work.
- All timing uses `SystemClock.elapsedRealtimeNanos()` and UTC timestamps. Explicit attribution works across threads without stack inference.
- Trace propagation is disabled. Trace/span IDs are generated locally for correlation; remote-parent ingestion, server log merging, metrics APIs, and full native transparent wrappers remain future work.

## Reproduce and validate the end-to-end capture

From the repository root, with the selected device connected:

```sh
npm ci
JAVA_HOME=/path/to/jdk17 ANDROID_SERIAL=emulator-5554 scripts/run-android-e2e.sh
npm test
node validate.mjs artifacts/live/*.ndjson
```

The script builds APKs, runs the deterministic Kotlin tests, installs the sample/test APKs on the selected device, then performs the two real network flows. It extracts the NDJSON via `run-as`, validates it, and separates the recordings without changing event contents. Output goes to ignored `artifacts/live/`. To intentionally replace the checked-in evidence, pass `samples/live` as the script's first argument.

Checked-in [live captures](../samples/live/manifest.json) were generated on an Android 17 / API 37 emulator. See [E2E evidence](../E2E.md) for verification and [the actual customer connection](app/src/main/kotlin/dev/networklog/app/SampleFlow.kt) for a complete runnable manual integration.
