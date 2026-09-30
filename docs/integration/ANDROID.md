# Integrate into an existing Android application

Use the Kotlin source modules in this checkout. `logger-api` is the small shared interface/no-op; `logger` is the development recorder and transfer implementation. Neither is published to Maven. The [external consumer fixture](../../integration/android-consumer/README.md) compiles this installation recipe without importing the original sample application or demo SDK.

## 1. Inspect the host and pin the source

Find the host's settings, plugin management/version catalog, app or SDK modules, build types/flavors, HTTP clients, executor/coroutine model, minimum Android version, manifest, network-security configuration, and backup rules before editing them. Keep the application's existing networking and release behavior.

The tested source-build baseline is **JDK 17, Gradle 8.14.3, AGP 8.13.2, Kotlin 2.2.20, compile SDK 35, Android API 26+**. The recorder declares min SDK 26 and uses APIs available at that level. These source modules require both Android and JVM Kotlin plugins. They have not been verified with AGP 9's built-in Kotlin configuration or older Kotlin compilers. Resolve incompatible host tooling deliberately; do not silently upgrade the application, use `tools:overrideLibrary`, or promise support below API 26.

Keep a reviewed repository commit pinned through the host's existing submodule/vendor mechanism. For a plain checkout, an illustrative command is:

```sh
git clone https://github.com/patjackson52/http-sequence-logger.git third_party/http-sequence-logger
git -C third_party/http-sequence-logger checkout --detach REVIEWED_COMMIT_SHA
```

Replace `REVIEWED_COMMIT_SHA` with the exact reviewed commit and record it in the host integration notes. Do not add the sample's `:app` or `:demo-auth` to the host build. An unconfigured `includeBuild(...)` does not supply Maven coordinates or dependency substitution for these modules.

## 2. Install the two Gradle modules

Check that the host does not already define `:logger-api` or `:logger`. The recorder currently references `project(":logger-api")` internally, so this recipe intentionally preserves those paths. If they collide, stop and resolve the naming conflict or patch and test that dependency path explicitly; renaming only `include(...)` is insufficient.

In the host's `settings.gradle.kts`, with the checkout path relative to that file:

```kotlin
include(":logger-api", ":logger")
val loggerCheckout = file("third_party/http-sequence-logger")
project(":logger-api").projectDir = File(loggerCheckout, "android/logger-api")
project(":logger").projectDir = File(loggerCheckout, "android/logger")
```

Ensure the host resolves plugins through `google()`, `mavenCentral()`, and `gradlePluginPortal()`, and dependencies through `google()` and `mavenCentral()`. The tested plugin declarations are:

```kotlin
plugins {
    id("com.android.application") version "8.13.2" apply false
    id("com.android.library") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
    id("org.jetbrains.kotlin.jvm") version "2.2.20" apply false
}
```

These belong in the host's existing plugin-management arrangement; do not duplicate plugins already provided by a version catalog or convention plugin. Use JDK 17 and compatible Java/Kotlin target settings. The [fixture Gradle files](../../integration/android-consumer/build.gradle.kts) show one complete working setup.

The application module depends on:

```kotlin
dependencies {
    implementation(project(":logger-api"))
    debugImplementation(project(":logger"))
}
```

A customer SDK exposing logging types in its public API uses `api(project(":logger-api"))`; it never exports the recorder. Shared sources import `dev.networklog.api`, while only development sources import `dev.networklog.logger`. The two packages contain similarly named types; avoid mixing their `Session`, `Actor`, `HeaderCapture`, and `BodyCapture` classes.

## 3. Inject a logger through build-specific wiring

Use one shared injection type and the same factory symbol in `src/debug` and `src/release`. Working files to adapt are:

- [CaptureLifetime](../../integration/android-consumer/app/src/main/kotlin/example/consumer/CaptureLifetime.kt): shared logger plus explicit close ownership.
- [Debug factory](../../integration/android-consumer/app/src/debug/kotlin/example/consumer/CaptureFactory.kt): new private file, `DebugTransfer.open`, `NetworkLog`, and `RecordingLogger`.
- [Release factory](../../integration/android-consumer/app/src/release/kotlin/example/consumer/CaptureFactory.kt): `NoOpLogger` and no file/recorder/transfer initialization.
- [Host execution hook](../../integration/android-consumer/app/src/main/kotlin/example/consumer/ConsumerApplication.kt): worker-thread lifetime with no Activity retention.

The essential debug wiring, on a worker thread, is:

```kotlin
val app = context.applicationContext
val file = File(app.filesDir, "captures/capture-${UUID.randomUUID()}.ndjson")
val sink = DebugTransfer.open(app, file)
val logger: dev.networklog.api.Logger = RecordingLogger(NetworkLog(
    sink, appId = app.packageName, namespace = "${app.packageName}/development"
))
// Inject logger into the existing app/SDK. The owner closes sink after recording ends.
```

The file path is **chosen by the application**, not an automatically installed SDK service. `files/captures/*.ndjson` is the convention supported by the collector's ADB watcher. `NetworkLog` otherwise defaults its namespace to the sample's value, so explicitly set an application/environment namespace. Producer `app_version` is currently a fixed prototype value; do not claim this field automatically reflects the host's real application version.

Start a session with an opaque existing ID or omit it to generate one while recording. Supplied IDs must be nonempty and at most 512 characters; do not use an access token or secret as an ID. Multiple sessions can share one retained sink. Reusing a session ID does not merge recording instances: `recording_id` still identifies each recording. With `NoOpLogger`, an omitted ID is empty; business identity must come from the app rather than depend on debug ID generation.

Both local capture and durable transfer write synchronously; use the host's worker/IO execution context. Keep the owner independent of Activity recreation. End sessions after their operations complete and close the sink when recording ends. `NdjsonFileSink`, including unpaired `DebugTransfer.open`, **truncates an existing file**: create a unique file for a new recording, and do not reopen an old unpaired file to append. Capture setup can fail before logging starts. The compiled debug factory falls back to no-op with `capturePath=null` on setup failure, emits a fixed credential-free diagnostic, and makes close/diagnostic failures observation-only. Preserve this boundary when adapting the wiring so storage errors do not prevent a business request or replace its result. The short construction snippet above shows the successful setup path; use the complete factory for failure handling.

For paired delivery, closing a sink stops its worker and leaves unacknowledged bytes on disk; it does not wait for successful upload. Retain the sink until the chosen recording/delivery boundary, or reopen pending files after startup and pairing with `DebugTransfer.resumePending`. Own and close the returned senders before re-pairing. `awaitUploaded(...)` is optional and must run off the UI thread. The fixture closes its short lifetime immediately and verifies local recording, not background delivery.

## 4. Instrument existing HTTP and handler calls

The SDK does not intercept arbitrary HTTP traffic automatically. Add calls to the small API around an existing client, or adapt a wrapper appropriate to that client. [BusinessFlow.kt](../../integration/android-consumer/app/src/main/kotlin/example/consumer/BusinessFlow.kt) is a compiled example that uses only the shared API, calls a customer-owned client, and nests a request inside an SDK-to-app handler invocation. Its `BusinessRequest`/`BusinessResponse` types are fixture-owned stand-ins for the host's existing types, not additional SDK APIs.

For a client that already returns complete body bytes, the recording boundaries are:

```kotlin
val exchange = session.startRequest(request.method, request.url, parent,
    initiator = Actor("integrator", "CustomerHandler", "submit"),
    executor = Actor("integrator", "ExistingHttpClient", "execute"),
    headers = { HeaderCapture.partial(request.headers, "application_configured_only") })
try {
    exchange.captureRequestBody {
        request.body?.let { BodyCapture.bytes(it, "application/json") } ?: BodyCapture.none()
    }
    val response = client.execute(request) // Existing request, retry, timeout and body semantics.
    exchange.completeResponse(response.status,
        headers = { HeaderCapture.library(response.headers) },
        body = {
            response.body?.let { BodyCapture.bytes(it, response.mediaType ?: "application/octet-stream") }
                ?: BodyCapture.unavailable("client_did_not_expose_body")
        }, effectiveUrl = response.effectiveUrl)
    return response
} catch (error: java.util.concurrent.CancellationException) { exchange.cancel(error); throw error }
catch (error: java.net.SocketTimeoutException) { exchange.timeout(error); throw error }
catch (error: java.io.IOException) { exchange.fail(error); throw error }
finally { exchange.stopObservation("customer_scope_exited") }
```

Use the actual request media type for body capture; this example's request is known JSON. Mark application-configured request headers as partial. Preserve duplicate header values in `List<Pair<String, String>>`; do not flatten them into a single-value map. Construct capture-only metadata **inside** suppliers so no-op recording does not evaluate it. Pass bytes already owned by the application; do not consume a stream again, buffer an unbounded body just for logging, or mutate those bytes during synchronous capture.

For streaming clients, call `receiveResponseHeaders(...)` when native headers arrive and complete only at EOF or the app's intentional close. Supply a prefix/unavailable body when the full body was not observed, and use `intentionallyClosed=true` for a deliberate early close. A timeout or cancellation after headers retains the observed status. Map native cancellation to `cancel(...)`, preserve the original exception/callback, and keep `stopObservation` as cleanup. A received HTTP 401/500 is a response; any higher-level business failure belongs to the enclosing operation. Each native retry needs its own exchange if the app can observe it; use `retryOf` to connect attempts. Hidden native retries remain logical-call observations.

Use one instrumentation path per request. The optional debug `LoggingHttpClient` changes redirect, timeout, and body-size behavior and must not replace production business networking solely to add logging.

To trace an SDK invoking customer code, including a handler with no HTTP calls:

```kotlin
val sdkOperation = session.startOperation("MySdk.execute", Actor("sdk", "MySdk", "execute"))
try {
    val value = session.invokeHandler("CustomerHandler.run",
        caller = Actor("sdk", "MySdk", "execute"),
        handler = Actor("integrator", "CustomerHandler", "run"),
        parent = sdkOperation.context) { handlerContext ->
        customerHandler(handlerContext) // Pass this parent into the handler's HTTP calls.
    }
    sdkOperation.complete()
    return value
} catch (error: java.util.concurrent.CancellationException) {
    sdkOperation.complete("cancelled", error); throw error
} catch (error: Throwable) {
    sdkOperation.complete("error", error); throw error
} finally { session.end() }
```

`invokeHandler` always executes the customer handler, including with no-op logging, and records synchronous return/throw/cancellation. Pass context explicitly across components; there is no automatic thread-local or coroutine propagation. Returning a `Deferred` or registering a callback observes the synchronous method return, not later asynchronous completion. Do not advertise a suspending handler adapter that does not exist. See [handler semantics](../../HANDLER-TRACING.md) before adding different dispatch semantics.

## 5. Configure storage, security and the desktop connection

Keep `android.permission.INTERNET` in the host as needed. Configure capture redaction for the host's JSON/query/header field names; defaults are not a universal secret detector. Non-JSON and incomplete bodies are withheld by default. Do not enable `allowUnstructuredBodies` globally to make a screenshot look richer.

Merge narrowly into the host's existing rules:

- Exclude `files/captures` and `files/network-log` from cloud backup and device transfer, including sidecars/credentials. Apply equivalent exclusions if using custom directories. The sample disables all backup; do not copy that whole-app policy into a customer app without need.
- If using ADB loopback HTTP, add the loopback exceptions from [the sample debug network-security config](../../android/app/src/debug/res/xml/network_log_debug_security.xml) to a **debug-only** configuration. Preserve the app's existing trust/cleartext/domain rules instead of replacing its complete policy. No broad cleartext or trust-all override belongs in production.
- `DebugTransfer.saveConnection(...)` stores private pairing in `files/network-log/connection.json`. Never write pairing JSON to capture logs, screenshots, source files, or shared artifacts. A non-debuggable runtime check is a secondary guard; dependency/source separation is still required.

Build/install the host app's debug variant with its own tools. From the logger checkout, use Node **22.12+** and start the collector for the actual installed debug application ID (including suffixes):

```sh
npm ci
npm run collector -- --android CUSTOMER_APPLICATION_ID --open
```

This builds/opens the viewer, discovers ADB, selects the single phone (otherwise the sole emulator), writes private pairing, establishes ADB reverse, and watches `files/captures/*.ndjson`. If selection is ambiguous, add `--device SERIAL` after the existing `--`; use `--adb /path/to/adb` only when discovery needs an override. `npm run android:live` is for building/installing the repository sample, not the customer's app.

Open **http://127.0.0.1:4319/** and keep the collector running. Browser connection/refresh and USB reconnection/pairing repair are automatic; the live panel shows device readiness. The next `DebugTransfer.open` uses the pairing; an already-open local sink remains local, but the ADB watcher can still retrieve its complete lines. Run a host-app flow and confirm its event count/session. **Save capture** exports `artifacts/collector/capture.ndjson`; app originals stay in their private directory. **Pause live** only pauses browser updates. Stop the watcher before manually changing app pairing. See [transport and retrieval](TRANSPORT.md) for overrides, HTTPS LAN, file export, credentials, restarts and troubleshooting. A sanitized NDJSON file can also be imported directly into the file-only viewer at port `4173`.

## 6. Verify the host integration and release boundary

First reproduce the independent consumer fixture from this repository root with JDK 17 and `ANDROID_HOME` configured:

```sh
npm ci
./scripts/check-android-integration.sh
```

It compiles Debug/Release using the documented source imports, tests no-op business semantics, writes a **synthetic** handler/request capture, validates that capture, and checks release dependencies/APK. It does not run a live server or claim device delivery evidence.

Then verify the actual host:

1. Build and run a real debug flow, including a handler making a request and returning to SDK control. Confirm the documented device file exists and contains no credentials.
2. Retrieve it through the chosen transfer/export path and run `node validate.mjs /absolute/path/capture.ndjson` from this checkout. See [schema and format authority](SPECS.md); do not change emitted JSON to match an obsolete design mockup.
3. Open it in the viewer. Check the selected session/recording, domains, operation/handler nesting and return, status/error, timing, redaction and inspector details. Verify a timeout/cancellation or incomplete observation without turning it into a fabricated HTTP status.
4. Build every shipping variant. Run the host's equivalent of `:app:dependencies --configuration releaseRuntimeClasspath`; there must be no recorder module or recorder-only dependency. Adapt names for flavors/custom build types.
5. Apply [the paired R8 discard assertions and binary audit](../../android/RELEASE.md) to actual shipping APKs, including APKs produced from the app bundle. Keep an unminified production-code fixture when feasible to demonstrate exclusion without optimizer assistance. Debug recorder classes are the positive control; production has no recorder code, pairing UI, capture resources, or development network exceptions.
6. Verify real business requests and customer callbacks still run exactly once with the no-op logger. Do not use `-assumenosideeffects` on methods that invoke application code, broad package keep rules, or runtime `BuildConfig.DEBUG` branches as a substitute for source/dependency separation.

The recorder disables its Release variant. Custom production build types must not fall back to its Debug variant. A custom development type must deliberately opt into recorder dependencies and debug wiring; merely setting `isDebuggable=true` does not add them. Keep the pinned commit, tooling compatibility decisions, file paths, source-set changes, validation result, transfer mode, and shipping-binary evidence in the host's integration notes.
