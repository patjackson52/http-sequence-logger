# Browser SDK review and verification

The [plan](PLAN.md) was reviewed before implementation by two independent agents: one covered networking, capture and handler semantics; the other covered persistence, transfer and build isolation. Both reviewed the implementation afterward. The root agent integrated the work and ran browser/build verification.

## Decisions retained after review

- Opt-in Fetch/XHR adapters plus lazy manual observations, with no global patch, request header injection, response clone/tee or background body drain.
- Schema 1.2 adds web producers and explicitly awaited handler settlement. Legacy 1.0/1.1 remain strict and readable. Synchronous Promise return identity is preserved; async helpers preserve value/rejection identity through a wrapper Promise.
- A bounded sanitized journal with optional IndexedDB persistence; explicit foreground full replay uses collector deduplication. No browser cursor/compaction/background retry machinery for these small development sessions.
- Same-origin development relay keeps pairing on the desktop. Collector protections are unchanged. Separate no-op/default and debug entry points plus separate setup files establish the production boundary.

## Findings fixed

| Review finding | Fix / evidence |
| --- | --- |
| Browser hidden headers, opaque status 0, redirect hops cannot be claimed as observed wire facts | Partial/unavailable metadata, logical attempts, opaque unknown outcome; adapter + real browser checks |
| Fetch JSON parsing could be confused with network completion | Native body EOF records HTTP end before JSON.parse; parse error stays an application error |
| XHR upload listeners can change CORS behavior; parsed JSON is not original bytes | No upload listeners; JSON/Blob/Document canonical bodies withheld; native XHR exercised |
| Error-name getters could bypass a whitelist on the second access | Single read; messages/stacks withheld; hostile getter regression |
| BOM bytes and decoded text byte counts disagreed | Preserve BOM in byte-originated text snapshots; regression validates counts |
| Redacting query parameters changed unaffected escaping; relative Location authority was lost | Selective raw query-value replacement; preserve reference authority; regressions |
| Large header collections could exceed a 1 MiB upload event | Aggregate 64 KiB UTF-8 header cap, partial reason; regression |
| Supplied opaque session IDs were silently truncated | Validate IDs and fail open with diagnostics; never rewrite identity |
| Awaited inspector/badges used synchronous wording; orphan handler could crash inspector | Resolved/rejected settlement wording and missing-start guard; viewer regressions |
| Sample journal reopen could race with active capture | One shared action gate for application and debug controls |
| Aborted fixture POST could reject an uncaught async request handler | Catch request-stream errors; skip sends on disconnected responses |
| Vite production preview selected debug configuration | Preview distinguishes production from development serve |
| Declarations omitted implemented persistence/timeout fields and Node relay API | Expanded declarations and strict TypeScript consumer check |

## Verification

- `npm test`: **207 tests pass**, covering contract generation/reproducibility, legacy fixtures, viewer, native transfer fixtures, browser recorder/adapters, memory/IndexedDB journals, and real relay/collector integration all pass. IndexedDB unit failure tests use **fake-indexeddb only as a development dependency**.
- `npm run check:web-types`: typed standalone consumer and relay imports pass.
- `npm run check:web-release`: positive debug controls, production module graph and every emitted chunk/map/asset checked. No recorder, persistence, uploader, relay or capture UI in production output. Web SDK runtime dependencies: **zero**. No-op entry has no imports.
- `npm run check:web-browser`: actual Google Chrome **154.0.8037.58**, isolated profile, real Fetch/XHR and IndexedDB; 63 exported events validate without errors/warnings. Native capture, synchronous Promise identity, awaited handler, abort, opaque response, unread body, parsing failure, manual client, persistence reopen/page reload, NDJSON download, collector replay/offline recovery, live viewer and handler drill-down pass. The shipping sample completes the same sign-in without logging. See [committed evidence](../../samples/web/README.md).

The app's interactive browser automation connection timed out; the repository's isolated headless Chrome suite supplied browser runtime verification without touching the user's signed-in profile. Screenshots were visually inspected from ignored test artifacts.

## Limits

This is a source-distributed development prototype. Chrome was exercised; Safari/Firefox/mobile web and framework-specific integrations still need host testing. Public API demo availability is not a deterministic acceptance dependency. Fixtures simulate an auth flow; they implement no production OAuth or authentication security. Browsers cannot expose all wire metadata. Streaming/FormData and unsupported body types require manual observations or remain unavailable. IndexedDB can be unavailable or evicted; abrupt shutdown does not guarantee pending commits. No automatic cross-tab merge, trace propagation, server capture merging, remote relay exposure, or continuous browser uploading is implemented. Defaults cannot redact arbitrary secrets embedded in developer-provided labels/paths or unknown application fields; configure and inspect the host capture policy.
