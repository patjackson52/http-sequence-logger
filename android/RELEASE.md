# Debug-only integration and release verification

Shared application/SDK code depends on `logger-api`. Only development wiring depends on `logger`. Production supplies `NoOpLogger`; the real HTTP client and customer callbacks continue to execute normally.

## Dependency boundary

```kotlin
dependencies {
    implementation(project(":logger-api"))
    debugImplementation(project(":logger"))
}
```

For an SDK that exposes logging types in its public API, use `api(project(":logger-api"))` as `demo-auth` does. Do not export the recorder from that SDK. Keep networking in the application/SDK's own client: the optional `LoggingHttpClient` belongs to the debug recorder and cannot be a production networking dependency. The sample's `DemoHttpClient` and manually instrumented customer connection both use the small API in every build.

Create the recorder and its file/transfer sink in `src/debug` and retain/close the sink according to the application's recording lifetime:

```kotlin
import dev.networklog.api.Logger
import dev.networklog.logger.NetworkLog
import dev.networklog.logger.RecordingLogger

val logger: Logger = RecordingLogger(NetworkLog(sink, appId = "your.app"))
```

In equivalent `src/release` wiring:

```kotlin
import dev.networklog.api.Logger
import dev.networklog.api.NoOpLogger

val logger: Logger = NoOpLogger
```

The runnable sample uses separate debug/release Activities around the same `SampleFlow`. A customer can instead keep one Activity and inject the logger through a source-set-specific factory or existing dependency injection setup. Keep recorder imports, pairing/export UI, capture files, and development network resources in debug sources. A runtime `BuildConfig.DEBUG` branch or the transfer factory's debuggable check alone does not remove dependencies and does not prevent a separately constructed file sink from recording.

The `logger` module disables its Release variant. Accidentally adding `releaseImplementation(project(":logger"))` fails dependency resolution. For custom production build types/flavors, avoid a fallback to the recorder's Debug variant and inspect each shipping configuration's resolved dependencies and final binary.

## Manual recording in shared code

Import `dev.networklog.api` in customer HTTP adapters. Headers and bodies are lazy suppliers so disabled logging does not inspect native metadata, copy capture bodies, redact JSON, generate IDs, read clocks, or write files.

```kotlin
import dev.networklog.api.BodyCapture
import dev.networklog.api.HeaderCapture
import dev.networklog.api.Session

// session comes from the injected Logger. Existing client semantics stay in caller code.
val exchange = session.startRequest("GET", requestUrl)
try {
    val response = existingClient.execute(request)
    // Complete only after the existing client has consumed/closed the response body.
    exchange.completeResponse(
        status = response.status,
        headers = { HeaderCapture.partial(response.headers) },
        body = { BodyCapture.bytes(response.bodyBytes, "application/json") },
        effectiveUrl = response.effectiveUrl
    )
} catch (error: java.net.SocketTimeoutException) {
    exchange.timeout(error)
    throw error
} catch (error: java.io.IOException) {
    exchange.fail(error)
    throw error
} finally {
    exchange.stopObservation("customer_scope_exited")
}
```

Construct capture-only data **inside** suppliers. Ordinary arguments, closures, and attribution objects can still allocate at the call site; no-op does not mean literally zero instructions. Disabled handles/context are shared singletons. A supplied session ID is preserved; an omitted ID stays empty when disabled, so application business identity must not depend on the logger generating one in production.

`invokeHandler` always runs the customer's handler exactly once. Its result and thrown exception/cancellation are preserved when logging is disabled. Handler bodies may contain business HTTP calls; never use optimizer rules that declare the whole API or these methods side-effect-free. Synchronous and callback-style manual recording remain available without using the built-in HTTP client.

## R8 and ProGuard configuration

The sample enables R8 and resource shrinking in Release with `proguard-android-optimize.txt`. Its app-owned assertion is:

```proguard
# Allow removal, but prevent surviving recorder code being hidden by inlining/renaming.
-keep,allowshrinking class dev.networklog.logger.** { *; }
-checkdiscard class dev.networklog.logger.**
```

These rules assert absence; they do not replace the dependency boundary. `-checkdiscard` alone can miss inlined code, hence the paired rule. The API uses direct Kotlin calls and requires no reflection/JNI keep rules or consumer keep file. Avoid broad `-keep class dev.networklog.**`, blanket `-dontwarn`, or `-assumenosideeffects` rules. Save the normal R8 mapping for troubleshooting the shipping app.

See Android's [optimization setup](https://developer.android.com/topic/performance/app-optimization/enable-app-optimization), [discard assertions](https://developer.android.com/topic/performance/app-optimization/troubleshooting-rules), and [library optimization guidance](https://developer.android.com/topic/performance/app-optimization/library-optimization).

## Verify the delivered binary

From the repository root, with JDK 17, `ANDROID_HOME`, and Android command-line tools installed:

```sh
android/scripts/verify-release.sh
```

This runs unit tests, builds Debug, Release, and a `releaseUnminified` inspection fixture, then verifies:

- Only the API, demo business module, Kotlin standard library, and its annotations appear in production dependency graphs.
- The API JAR contains no recorder, Android, JSON, I/O, network, clock, or cryptographic implementation dependencies or resources. The demo SDK's Release AAR does not reference recorder classes.
- APK Analyzer reports recorder classes/resources in Debug as a positive control, and none in either production APK. Raw DEX markers and merged manifests are also inspected.
- Production is non-debuggable, has no development network configuration, disallows cleartext traffic, and retains the app's explicit backup/device-transfer exclusions after shrinking.
- Generated R8 configuration contains the discard assertion, and deliberately adding a Release recorder dependency fails for the expected missing-variant reason.

Results are written to `artifacts/release-audit/`. The unminified fixture demonstrates removal does not rely on R8. The audit's dependency allowlist is specific to this small sample; adapt it for your application, retaining recorder/transitive-dependency and resource exclusions. Apply equivalent verification to the actual APKs generated from your shipping app bundle.

In the reviewed build, `logger-api` is 24,061 bytes as a JAR and 8,224 bytes of defined DEX classes in the unminified sample. Both production builds contain zero recorder classes and no logging resources. These are measurements, not a fixed size promise. Whole-APK size differences also include shrinking Kotlin and application code; renamed/inlined API code in Release cannot be measured by counting its original package name.
