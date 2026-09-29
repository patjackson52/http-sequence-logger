# End-to-end evidence

The Kotlin sample was built and run against real public HTTPS services on **2026-09-29 UTC** (September 28 in the development machine's local time), using an **Android 17 / API 37 arm64 emulator**. The source is MIT licensed. This repository is local; no GitHub remote or publication has been configured.

## Recorded results

| Capture | Sessions | Requests | HTTP successes | Expected HTTP errors | Unfinished |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Successful sign-in](samples/live/successful-sign-in.ndjson) | 1 | 8 | 8 | 0 | 0 |
| [401 recovery](samples/live/recovered-sign-in.ndjson) | 1 | 9 | 8 | 1 | 0 |
| [Combined file](samples/live/multi-session.ndjson) | 2 | 17 | 16 | 1 | 0 |

All three files pass schema and relationship validation **without warnings**. The 401 is deliberately induced using an invalid demo token. The SDK then refreshes the real demo token and makes a correlated successful retry; the surrounding app operation succeeds. Every recording contains one customer-owned manually instrumented request inside an SDK-invoked app handler, an explicit handler return, subsequent `DemoAuthSdk.acceptTask`, and SDK-owned requests. There are two completed handler invocations across 17 HTTP requests; local calls do not inflate HTTP counts. The three actual origins are `dummyjson.com`, `httpbin.org`, and `jsonplaceholder.typicode.com`.

The recorder redacted credentials on the Android device before file writes. The collector only splits recordings and validates them; it does not invent events, alter timestamps, or replace failed requests. [The manifest](samples/live/manifest.json) contains source timestamps and validation summaries. The original `examples/` directory remains explicitly synthetic and separate.

## Verification

- **26 Kotlin unit tests passed:** manual capture defaults, body lifecycle, status retention on timeout, concurrent terminal callbacks, header/query/body redaction, relative Location sanitation, binary/prefix opt-in, byte limits, sink failure isolation, retry context, session reuse, stop reasons, GET/body rejection, native adapter error behavior, and handler return/throw/cancel/stop, nesting, lock isolation, and sink-failure behavior.
- **85 Node tests passed:** 82 contract/fixture/validator cases plus three recorded Android capture regressions, including handler calls and returns.
- **One live Android instrumentation test passed:** two actual full flows, 17 network requests, validated result content, both adapter types, three origins, correct handler parenting/return-before-SDK-resume, no retained public password or raw JWT.
- **Android APK and test APK built.** Android lint completed with no errors. Remaining warnings concern newer dependency/SDK versions, sample UI localization/icon, and backup configuration guidance; these are not a claim of production release qualification.
- **UI flow exercised:** launched the app, tapped successful sign-in, observed Emily's completed session and all steps, then exported the capture through Android's document picker. The exported file was byte-for-byte identical to the private original and passed validation. The refreshed [screenshot](docs/android-success.png) also shows SDK → app handler, the app HTTP step, and app handler → SDK return.
- **Independent network and Android reviewers rechecked the fixes** for relative redirect redaction, native GET-to-POST rewriting, lazy-connection error stages, serialized observation-stop reasons, and opaque session ID preservation. No blocker remained in that bounded re-review.

## Reproduce

Follow [Android setup](android/README.md), then run:

```sh
JAVA_HOME=/path/to/jdk17 ANDROID_SERIAL=your-device scripts/run-android-e2e.sh
npm test
node validate.mjs artifacts/live/*.ndjson
```

The APK is generated at `android/app/build/outputs/apk/debug/app-debug.apk`. Build products and local captures are ignored by Git; the three explicitly selected captures under `samples/live/` are committed evidence.

This completes the requested Kotlin SDK/sample/capture milestone. The interactive web sequence viewer, server-side merging, iOS implementation, full transparent native adapters, and physical-device/API-range release testing remain separate work. The sample is an auth-style development exercise using fake account data, not an OAuth implementation or a production identity-verification service.


## Handler extension

The updated live files use schema 1.1 and recorder version 0.2.0. The public demo now exercises the app-supplied handler in both normal and 401-recovery runs. Six additional synthetic fixtures cover HTTP/no-HTTP, throw, cancellation, observation stop, and a missing end. The sequence-view design requirements and copy-ready Claude prompt are in [HANDLER-TRACING.md](HANDLER-TRACING.md) and [docs/claude-handler-design-prompt.md](docs/claude-handler-design-prompt.md). The web viewer itself remains a design deliverable, not an implemented GUI.
