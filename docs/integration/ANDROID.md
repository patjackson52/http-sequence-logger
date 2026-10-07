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

Initialize once on a host setup/IO context; capture callbacks then use bounded memory admission:

```kotlin
val app = context.applicationContext
val sink = DebugTransfer.open(app)
val logger: dev.networklog.api.Logger = RecordingLogger(NetworkLog(
    sink, appId = app.packageName, namespace = "${app.packageName}/development"
))
// Inject logger into the existing app/SDK. The owner closes sink after recording ends.
```

`DebugTransfer.open` creates a new process journal under `context.noBackupFilesDir/HTTPSequenceLogger/journals/<uuid>/capture.ndjson`, publishes the fixed installation descriptor and starts one pairing/connection manager. Keep one sink across sessions. It rotates retained generations without deleting acknowledged history; use `captureFiles` at export time, since `file` names the current generation. `DebugTransfer.initialize(context)` can publish discovery without opening a recording. The descriptor uses `context.packageName`, including the host's debug suffix. Set an application/environment namespace explicitly.

Initialization performs synchronous filesystem work. Run `open`, `initialize` and private configuration writes on a worker thread, as the external consumer does. Callback-safe append admission does not make initial journal creation or setup UI-thread safe.

Supply an opaque existing session ID or generate one; do not use tokens as IDs. All events use schema 1.3. `recording_id` separates recording periods even when logical session IDs are shared across sources. Logging-disabled business identity must not depend on a generated debug ID.

Append takes an immutable sanitized snapshot into a bounded queue. One serial writer performs serialization/grouped append/sync away from callback threads. `sink.flush()` returns a `CompletableFuture<Unit>` persistence barrier; await it off the UI thread when a durable prefix is required. An unflushed tail may be lost on process kill. Admission/storage failure is an observation diagnostic and must not replace application responses or callback results. Construction still needs the complete factory's setup failure/no-op boundary.

The open sink refreshes private pairing and rebinds its sender while canonical capture continues. Retained journals survive ACK; each delivery cursor binds to collector/source/journal generation. `DebugTransfer.resumePending(context, maximumFiles=16)` reopens retained current-format journals with exclusive disk ownership; own/close the returned senders. `awaitUploaded` is optional and runs off the UI thread. Close stops admission and releases ownership only after accepted disk jobs finish; it is not a successful-upload guarantee. No old files/cursors are imported.

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

- Use the bootstrap's no-backup directory for installation, descriptor, pairing and journals. Do not disable the host's entire business backup policy. Validate data reset/restore/reinstall behavior and keep unmatched restored state visibly unlinked.
- If using ADB loopback HTTP, merge the [debug network-security config](../../android/app/src/debug/res/xml/network_log_debug_security.xml) into a debug-only configuration. Preserve business trust/domain/cleartext rules; no global trust-all or cleartext override belongs in production.
- `DebugTransfer.saveConnection(context, json)` stores private version 2 enrollment/source input under `no_backup/HTTPSequenceLogger/pairing.json`. Never log/commit/export this input. Build separation remains the shipping guard.

Build/install the host's debuggable variant using its own tools. Start agnostic collection from the logger checkout:

```sh
npm ci
npm start
```

The collector discovers participating packages on all authorized Android devices. Optional `--android CUSTOMER_APPLICATION_ID --device SERIAL` filters narrow discovery. Enumeration, descriptor/pairing access and bounded capture reads use the validated numeric default user; other profiles remain unsupported pending validation. The sample install command is separate.

Open **http://127.0.0.1:4319/**. Device/app/session navigation, source status and event counts establish delivery. The collector and app can start in either order; an open sink observes pairing refresh. ADB reverse and private pairing recover after reconnect. Native HTTP and bounded file replay share source ownership and deduplicate event IDs. A different selected collector is not silently replaced.

**Save capture** exports current NDJSON from `artifacts/collector-v2/capture.sqlite`; native originals remain canonical private journals. Viewer pause leaves collection running. Physical LAN delivery uses explicitly paired HTTPS, applicable debug local-network permission and optional NSD candidate discovery. See [TRANSPORT.md](TRANSPORT.md) for trust, paths, bounded recovery and troubleshooting.

On Android 17, apps targeting SDK 37 or higher must declare `android.permission.ACCESS_LOCAL_NETWORK` and request it at runtime before direct LAN access. Apps targeting SDK 36 or lower receive implicit LAN access through `INTERNET`; do not add or request the new permission for those targets. Android 16's opt-in testing uses `NEARBY_WIFI_DEVICES` temporarily. Keep permission declarations and requests in the host's debug integration, and exercise denial and revocation on the actual OS/target combination. These distinctions follow [Android's local-network permission guidance](https://developer.android.com/privacy-and-security/local-network-permission).

The host app owns permission UX. Optional discovery reports availability diagnostics; discovered labels do not authorize enrollment or establish TLS trust. USB delivery and explicit pairing remain separate paths, and successful loopback USB capture does not establish LAN permission behavior.

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

## First-party server correlation

Configure debug `NetworkLog(..., propagationOrigins = listOf("https://your-server.example"))`. Its session metadata declares the normalized origin allowlist. Shared HTTP code calls `exchange.context.traceparent(actualDestination)` after starting the **outbound request** and adds the returned header when non-null. The shared API default/no-op returns null; production does not generate trace IDs or emit headers. The debug bridge returns that request's W3C trace/span identity only for exact configured origins, preserving the operation parent and distinct concurrent/retry spans.

```kotlin
exchange.context.traceparent(url)?.let { connection.setRequestProperty("traceparent", it) }
```

Keep app networking and header application under host ownership. The helper does not install an interceptor or propagate arbitrary destinations. Instrument the receiving server using [server contexts](SERVER.md), then configure the collector's [retrieval/parsing adapters](ADAPTERS.md). A server recording has its own session/recording IDs; lookup and remote arrows join by trace/parent span identity.

Propagation allowlists authorize the initial destination. Automatic redirects can forward ordinary custom headers outside instrumentation visibility; the host owns redirect/header-forwarding policy for allowed endpoints. The logger preserves existing HTTP behavior and does not fabricate per-hop observations.
