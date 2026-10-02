# Kotlin Android SDK and sample

The debug recorder writes sanitized schema **1.2** events and source-aware transfer **2**. Use [Android integration](../docs/integration/ANDROID.md) for existing apps. `logger-api` contains the shared API/no-op; `logger` and discovery wiring belong only in debug dependencies. API26+, JDK17, Kotlin2.2.20 and SDK35 are the tested baseline.

## Run

From `tools/network-log-contract`, run `npm ci`, then `npm start`. The agnostic collector discovers all authorized ADB devices and initialized debug apps. `npm run android:live -- --device SERIAL` separately builds/installs/runs the repository sample. Select an actual serial from `adb devices -l`. Missing tools and unauthorized devices do not block the viewer.

```sh
./android/gradlew -p android :app:assembleDebug :logger:testDebugUnitTest
adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_SERIAL" shell am start -n dev.networklog.sample/dev.networklog.app.MainActivity --es networklog.run success
```

The sample offers successful sign-in, 401/retry, canonical export and pairing. Optional Bonjour browsing starts only with **Discover collectors**; DNS-SD labels require an independently provisioned enrollment ticket/pairing and never authorize TLS trust. LAN endpoints require HTTPS; loopback HTTP uses ADB reverse.

## Debug bootstrap and storage

```kotlin
// Bootstrap on the host's worker. Keep this process journal across sessions.
DebugTransfer.initialize(context) // Discovery descriptor exists without a collector/events.
val sink = DebugTransfer.open(context)
val logger = NetworkLog(sink, appId = context.packageName,
    namespace = "${context.packageName}/development")
val session = logger.startSession("Checkout")
// Wire the host's existing capture hooks.
session.end()
sink.flush().get() // Worker-only wait for the admitted prefix to be durable.
val exportFiles = sink.captureFiles // All retained canonical generations.
// Optional worker-only bounded upload wait:
val delivered = sink.awaitUploaded(2_000)
sink.close()
```

Default private paths are `no_backup/HTTPSequenceLogger/source.json`, `pairing.json` (app-owned explicit selection/registered credential), `pairing-local.json` (collector-owned automatic proposal), and `journals/<journal-id>/capture.ndjson`. Each process/open has a unique locked generation and rotates transparently when full. `JournalLimits` configures generation and installation capacity. Metadata `journal.json` publishes the synced prefix for stopped-app collection, coalesced at250ms/1MiB and forced on seal/close. `DebugTransfer.resumePending(context)` reopens up to16 retained current-format journals; retain and close the returned senders. The bootstrap connection manager refreshes pairing every second and serializes rebinds without truncating capture. Direct `FileHttpEventSink(file, connection)` is available when the app explicitly owns its new canonical journal.

Capture admission is bounded memory, **not persistence**. A serial disk worker groups writes on a50ms,64KiB or500-event trigger; triggers do not guarantee fsync completion time. `flush()` is a durability barrier; HTTP runs separately and tails synced lines in bounded1MiB/500-event batches. The recorder defers complete event serialization to that disk worker. A pending write/network stall never changes business request results. `close()` stops new admission, flushes the admitted prefix, cancels delivery and retains canonical bytes.

Canonical journals retain ACKed records. The defaults are16MiB per generation,256MiB per installation,2MiB aggregate admission queue and128 retained generations. Installation capacity is reserved while acquiring the writer under the same installation lock. Capacity rejection increments dropped diagnostics; export retained paths and explicitly archive storage. Automatic rotation never deletes history. The rolling owner replays retained generations one at a time. Cursors bind collector/source/journal/file identity and a bounded boundary sample. Partial final tails are repaired on reopen; complete records remain. Changed source/collector replays stable IDs. A lost ACK safely retries. No acknowledged-prefix hashing or historical whole-file reads occur per event.

The collector provisions private pairing automatically for local ADB sources. For explicit physical-device pairing use `DebugTransfer.saveConnection(context, json)` on a worker with the current source config or enrollment ticket. Explicit pairing wins over an automatic local proposal. Successful enrollment persists the installation credential in app-owned pairing for relaunch after ticket expiry. Tokens stay out of URLs/logs. HTTPS pins use the exact DER certificate SHA256 plus validity and hostname verification. Redirects are refused. All transfer uses an uninstrumented native connection. The debug factory rejects non-debuggable hosts.

## Verify

```sh
./android/gradlew -p android :logger:testDebugUnitTest :app:assembleDebugAndroidTest
JAVA_HOME=/path/to/jdk17 ANDROID_HOME=/path/to/sdk ./android/scripts/verify-release.sh
ANDROID_SERIAL=SELECTED_DEVICE ./android/scripts/run-transfer-e2e.sh /private/current-loopback-source.json /private/current-tls-source.json
```

The tests cover offline/restart, lost/mismatched ACK, source scopes, late ACK during rebind, concurrent admission/close, canonical retention, partial tails, bounded batches and redirect refusal. Release audits inspect shipping APKs/dependencies, descriptor/discovery/credential markers and debug resources. Real physical permission/lifecycle gates require actual devices; emulator evidence does not establish them.

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
val sink = DebugTransfer.open(context) // Keep open across concurrent sessions.
val logger = NetworkLog(sink, appId = "your.app", namespace = "your.app/development")
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

Capture calls admit bounded memory and serialize/write on the journal owner. Bootstrap/open and blocking flush/close belong on a worker. Share one owner across concurrent sessions; it rotates generations and retains canonical history. Sink failures report diagnostics without replacing network results. A failed writer stays blocked until close/reopen repairs its uncertain tail; validate retained captures before exporting.

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
JAVA_HOME=/path/to/jdk17 ANDROID_SERIAL=SELECTED_DEVICE scripts/run-android-e2e.sh
npm test
node validate.mjs artifacts/android-instrumentation/ACTUAL_RUN_UUID/*.ndjson
```

Choose the actual device with `adb devices -l`; replace `SELECTED_DEVICE` and use the run UUID printed by the harness. `run-android-e2e.sh` delegates to the maintained `check-android-instrumentation.mjs` runner and accepts no positional output/config arguments. It builds and installs Debug app/test APKs, runs actual AndroidJUnitRunner business-flow and transfer tests, validates emitted capture files, and checks collector ACK evidence. New captures, private collector state and reports stay under ignored `artifacts/android-instrumentation/<UUID>/`; existing canonical journals, explicit pairing and reverse routes are preserved. It does not replace checked-in captures.

For current schema 1.2 native evidence, use [realtime captures](../samples/realtime/README.md), including the recorded Android recovery flow available in the viewer sample picker. [Older live captures](../samples/live/manifest.json) remain historical evidence and are unsupported by the current validator/viewer. See [the actual customer connection](app/src/main/kotlin/dev/networklog/app/SampleFlow.kt) for a complete runnable manual integration; repository capture evidence does not verify a different app's integration.
