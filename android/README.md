# Kotlin Android SDK and sample

This runnable sample integrates the draft 1.1 recorder with native `HttpURLConnection`, a small demo auth SDK, and customer-owned networking code. Source is MIT licensed. Android API 26+; no Java source/API examples are maintained. The iOS contract remains a design for a future implementation.

## Modules

- `logger`: stack-independent session/request/operation handles, JSON capture policy, NDJSON file sink, and optional `LoggingHttpClient` built on native HttpURLConnection.
- `demo-auth`: `DemoAuthSdk`, which calls two independent origins and labels its own methods as SDK code.
- `app`: Android UI, an app-owned manually instrumented connection to a third origin, and a device test that executes the same flow as the UI.

## Build and run

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

Each run writes `files/captures/capture-<time>.ndjson` in private app storage. **Export structured log** opens Android's document picker. No capture upload happens automatically. Multiple sessions can share a sink, as demonstrated by the live test.

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

The normal run has **8 requests**. Recovery has **9**, with one expected 401 and an overall successful operation. All use HTTPS. This is an auth-style orchestration example, **not OAuth, Prove integration, phone verification, or production identity verification**. The public endpoints do not trust each other or enforce a shared security decision. No real credentials or phone numbers are required. Tokens never go to the echo or task services.

The services are free and need no keys or dashboard setup. Their implementations are publicly available:

- [DummyJSON authentication](https://dummyjson.com/docs/auth) · [source](https://github.com/Ovi/DummyJSON)
- [httpbin service](https://httpbin.org/) · [source](https://github.com/postmanlabs/httpbin)
- [JSONPlaceholder service](https://jsonplaceholder.typicode.com/) · [source](https://github.com/typicode/jsonplaceholder)

Public services can be unavailable or rate limited. Live tests intentionally fail on unexpected status/content; they never substitute fabricated success data. Unit tests use controlled connections and need no network.

## Trace a supplied app handler

The sample constructs `DemoAuthSdk` with a `TaskHandler`. Inside `authenticate`, the SDK uses `session.invokeHandler(...)` to call it. The app uses the supplied handler context for its existing HTTP client. On method exit, the recorder writes an explicit `returned`, `threw`, or `cancelled` boundary before SDK code continues. Session shutdown records `observation_stopped` instead of a return. This tracing works even when the handler makes no HTTP calls.

See [handler API, format, and GUI mapping](../HANDLER-TRACING.md). The sample now has two additional local progress steps; its HTTP request counts remain 8 and 9.

## Add logging to a customer's existing client

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
- Trace propagation is disabled. Trace/span IDs are generated locally for correlation; remote-parent ingestion, server log merging, metrics APIs, full native transparent wrappers, and iOS implementation remain future work.

## Reproduce and validate the end-to-end capture

From the repository root, with the selected device connected:

```sh
npm ci
JAVA_HOME=/path/to/jdk17 ANDROID_SERIAL=emulator-5554 scripts/run-android-e2e.sh
npm test
node validate.mjs artifacts/live/*.ndjson
```

The script builds APKs, runs 26 deterministic Kotlin tests, installs the sample/test APKs on the selected device, then performs the two real network flows. It extracts the NDJSON via `run-as`, validates it, and separates the recordings without changing event contents. Output goes to ignored `artifacts/live/`. To intentionally replace the checked-in evidence, pass `samples/live` as the script's first argument.

Checked-in [live captures](../samples/live/manifest.json) were generated on an Android 17 / API 37 emulator. See [E2E evidence](../E2E.md) for verification and [the actual customer connection](app/src/main/kotlin/dev/networklog/app/SampleFlow.kt) for a complete runnable manual integration.
