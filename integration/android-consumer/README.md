# External Android consumer fixture

This standalone Android Gradle build imports only the SDK's two source modules through `projectDir`. It does not import the original application, demo-auth module, or root Android settings. It verifies the [existing-app installation recipe](../../docs/integration/ANDROID.md).

The application is a build/injection fixture with no launcher UI. Its host hook accepts an existing `BusinessHttpClient`; the test supplies a deterministic synthetic response for `https://example.test/submit`. No HTTP request is sent. The debug test writes a **synthetic**, sanitized NDJSON file and checks handler parenting and return. Shared tests verify no-op recording preserves the business client's response, timeout, cancellation, and other I/O failure. This is integration/build evidence, not a device/network E2E result.

From the repository root, with Node 22.12+, `npm ci`, JDK 17 (`JAVA_HOME`), `ANDROID_HOME`, Platform 35, and Android SDK command-line tools installed:

```sh
./scripts/check-android-integration.sh
```

The script builds Debug and minified unsigned Release, runs seven test executions (five Debug and two Release), validates the synthetic capture, confirms the Debug recorder positive control, and checks Release dependencies/APK for recorder exclusion. R8's paired keep/discard assertions prevent surviving recorder classes from being concealed by optimization. Reports are under ignored `artifacts/android-integration/`; APKs are under this fixture's `app/build/outputs/apk/`.

`CaptureFactory` is the same symbol in `src/debug` and `src/release`. Shared `BusinessFlow` imports only `dev.networklog.api`. `ConsumerApplication.submit` owns a short recording lifetime on a worker and invokes its completion callback on that worker. A real app should adapt this to its existing executor and callback delivery contract. Its debug factory closes immediately after the operation; for HTTP transfer, retain/reopen pending sinks as explained in the integration guide. This fixture intentionally tests local capture wiring without asserting background upload delivery.

Debug capture setup failure falls back to the no-op with `capturePath=null`. Setup/cleanup failures produce only a fixed diagnostic, and cleanup/diagnostic exceptions cannot replace the application's result or original exception. Two regression tests verify these failure paths independently of Android storage/device availability.
