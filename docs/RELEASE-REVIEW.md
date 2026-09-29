# Production isolation and multi-agent review

Reviewed after the native capture/transfer milestone, using independent Android and iOS agents plus the integrating reviewer. The review covered dependency boundaries, simplification, handler semantics, release shrinking, binary contents, native transfer, collector failure handling, and viewer lifecycle.

## Findings resolved

| Finding | Resolution |
| --- | --- |
| Android app and demo SDK included the entire recorder in Release; disabling pairing still allowed a local file sink. | Extracted the small Kotlin `logger-api` and no-op implementation. Recorder, transfer, pairing/export UI, and development resources are debug-only. Release dependency resolution rejects the recorder. |
| The demo SDK depended on the recorder's HTTP implementation for business requests. | SDK-owned HTTP implementation now depends only on the API; debug and production execute the same business flow. Manual customer adapters also use the API. |
| Eager metadata capture would still inspect headers/copy bodies with logging disabled. | Lazy header/body suppliers and singleton disabled handles; tests verify suppliers are never evaluated. |
| Removing handler instrumentation could accidentally remove application code or alter exceptions. | Shared `invokeHandler` executes exactly once and preserves results, exceptions, cancellation, and errors; no side-effect stripping rules. |
| New production Activity worker could outlive its Activity or allow duplicate sign-ins after rotation. | Process-scoped operation state and worker; Activity listeners attach/detach with lifecycle. |
| iOS development package/demo/resources could enter a production build. | Separate production target with no package dependency; compile-time guards on development sources; unsigned device archive audit and an intentional failing development Release build. |
| `allowBackup=false` alone does not cover every Android device-transfer implementation. | Explicit legacy/cloud/device-transfer exclusions; final APK XML verified after shrinking. |
| An unreadable collector download journal emitted an unhandled stream error. | Awaited stream pipeline with response teardown; collector remains healthy after failed download. Writes to missing/replaced/truncated journals are rejected without ACK. |
| Valid batches with long IDs could produce ACKs larger than the old 512 KiB client limit. | Shared 2 MiB ACK bound per platform; valid large Unicode/ASCII ACKs accepted and oversized replies rejected with pending data retained. |
| Reconnecting during file import could leave import buttons disabled. | Reconnect clears the cancelled import's busy state before restarting live capture. |

## Verification

- **Android:** 40 recorder/transfer/bridge JVM tests; 3 no-op API tests; 8 controlled HTTP tests in each of Debug and Release. Debug, minified Release, unminified Release, and demo SDK Release AAR built successfully. Both production dependency graphs and final APKs passed the exclusion audit. The accidental Release dependency probe failed as intended.
- **Native Android:** successful and recovery flows passed on API 37 after the API migration: 109 events, 17 requests, 3 origins, 2 explicit handler calls/returns, no unfinished exchanges. The single HTTP 401 is the intentional recovery scenario. New logs validated under `artifacts/release-review/live/`; existing public sample captures remain available under `samples/live/`.
- **Android lint:** app Debug/Release, recorder Debug, and demo SDK Release checks passed. Remaining warnings concern pinned/older dependency and target versions, demo icon/localization, and the deliberately custom debug certificate-pin trust manager. They are not suppressed. No backup-rule warnings remain. This sample is not claimed to meet future app-store target/API policies.
- **iOS:** 15 Swift package tests and 22 simulator tests (15 package + 7 native integration) passed. Includes large valid ACK acceptance, chunked oversized ACK rejection, TLS pin/hostname/date checks, redirect refusal, and offline recovery. Six native exported captures validated. The unsigned iOS device archive contains no transfer dependency/code/resources/development network permissions; a Release build of the development target is rejected.
- **Web/collector:** root JavaScript tests and production viewer build passed, including failed download/storage and maximum-ID ACK regressions. The browser loaded the rebuilt viewer and live capture. The specific reconnect-during-import UI regression was code-reviewed but could not be completed through Chrome automation because its connection timed out; it is not claimed as an automated UI pass.

Run [Android release verification](../android/RELEASE.md) and `node ios/scripts/verify-release-isolation.mjs` to reproduce binary audits. Machine-readable local reports are `artifacts/release-audit/result.json` and `ios/.local/release-isolation/result.json`; native simulator results and captures live under `ios/.local/`. These directories are ignored because they can contain build artifacts and private pairing configuration.

The iOS module remains a Swift transfer sink with a small manual demo, not a complete capture SDK. Production target separation is verified for the supplied sample; a customer's own archive needs the same dependency/resource checks. Physical-device Wi-Fi and physical backup/restore were not exercised in this review.
