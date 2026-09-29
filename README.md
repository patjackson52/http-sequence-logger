# HTTP sequence logger

Draft **1.2** capture format (reader also accepts **1.0/1.1**) for mobile and browser development SDKs. Includes Kotlin Android and browser recorders with auth samples, a Swift transfer package and manually instrumented iOS demo, a local desktop collector, and an interactive web sequence viewer.

Repository: [patjackson52/http-sequence-logger](https://github.com/patjackson52/http-sequence-logger) · [MIT license](LICENSE).

**Integrating an existing app with a coding agent?** Start at [AGENTS.md](AGENTS.md) and the [integration guide](docs/integration/README.md), or copy the [agent prompt](docs/integration/AGENT-PROMPT.md). They cover Android/iOS/browser installation, implemented capabilities, JSON specs, files and IndexedDB, transfer, the viewer, and production isolation.

## Stream logs into the viewer

See [device transfer and pairing](docs/transfer/README.md) for Android ADB, iOS Simulator, paired Wi-Fi HTTPS, and offline file import. The collector persists NDJSON and streams updates to the viewer without a hosted backend.

```sh
npm ci
npm run build:viewer
npm run collector
```

Open the printed viewer link. [Web viewer guide](viewer/README.md) · [Swift transport and iOS demo](ios/README.md).

## Run the browser sample

```sh
npm ci
npm run web:sample
```

Open `http://127.0.0.1:4180`. The simulated auth flow uses two local servers, a small SDK, Fetch, and an SDK-awaited app handler making an XHR request. It includes expected token expiry and refresh; no account is needed. A separate action exercises two public APIs. Export NDJSON from the development panel, or configure its same-origin relay for explicit collector upload.

The [browser SDK](web-sdk/README.md) includes manual customer-client recording, bounded memory/IndexedDB storage, redaction and a small production no-op entry. [Existing frontend integration](docs/integration/WEB.md) explains source installation, build aliases, log locations and delivery. Run `npm run check:web-types` and `npm run check:web-release` for typed consumer and shipping isolation checks. [Real browser captures](samples/web/README.md) · [Browser design](docs/web/PLAN.md) · [Review/evidence](docs/web/REVIEW.md).

## Run the Android sample

See [Android setup and integration](android/README.md). The MIT-licensed sample makes real HTTPS requests to three free public services, records both SDK-owned and manually instrumented app requests, and exports local NDJSON. No service registration is required.

- [Successful live capture](samples/live/successful-sign-in.ndjson): 8 successful requests.
- [Recovered live capture](samples/live/recovered-sign-in.ndjson): 9 requests with an expected 401 followed by refresh/retry.
- [Both sessions in one file](samples/live/multi-session.ndjson).
- [End-to-end verification](E2E.md).
- [Native captures delivered through the collector](samples/transfer/README.md): Android recovery and iOS HTTP/TLS/offline recovery.
- [SDK → app handler → SDK tracing](HANDLER-TRACING.md): local calls, nested HTTP, explicit return/throw/cancel, and incomplete observation.
- [Claude design-spec update prompt](docs/claude-handler-design-prompt.md).

## Start here

- [Contract](CONTRACT.md): event semantics, identity, timing, capture fidelity, and importer behavior.
- [Standalone JSON Schema](schema/event.schema.json): JSON Schema 2020-12 for one event/NDJSON line.
- [Adapter contract](ADAPTERS.md): native wrappers and the client-independent recording API.
- [Customer manual logging](MANUAL-LOGGING.md): required public API, defaults, and Kotlin/Swift integration sketches.
- [Correctness review](REVIEW.md): network, Android, and iOS findings, fixes, and remaining native verification.
- [Production isolation review](docs/RELEASE-REVIEW.md): multi-agent findings and native/build verification.
- [Debug-only Kotlin integration](android/RELEASE.md): small production API, manual logging, R8/ProGuard rules, and binary audits.
- [Example manifest](examples/manifest.json): scenarios, descriptions, and expected summaries.
- [Multi-session capture](examples/multi-session.ndjson): 14 requests, six origins, two sessions, three recording periods.

## Validate locally

Use Node.js 22.12 or later from this directory:

```sh
npm ci
npm run validate
npm test
node validate.mjs /absolute/path/to/capture.ndjson
```

Validation performs JSON Schema checks and additional relationship, timing, body-byte, retry, and outcome checks. Exit code `0` means no detected contradictions; warnings can still identify missing data. Exit code `1` means invalid input; `2` means the CLI was called without a filename.

`interrupted.ndjson` and `handler-interrupted.ndjson` deliberately produce warnings for missing lifecycle ends. The importer preserves those records rather than inventing completion.

## Reference scenarios

| File | Expected behavior |
| --- | --- |
| [success](examples/success.ndjson) | App → SDK → API, HTTP 200; duplicate query parameters and headers retained |
| [direct-integrator](examples/direct-integrator.ndjson) | Generated session ID; request executes in integrator code through a custom adapter |
| [http-error](examples/http-error.ndjson) | HTTP 400 with an inspectable JSON error body |
| [timeout](examples/timeout.ndjson) | No response; null status and unavailable body |
| [retry](examples/retry.ndjson) | HTTP 503, backoff, then HTTP 200 under one successful method operation |
| [concurrent](examples/concurrent.ndjson) | Overlapping iOS requests finish in reverse order; native metrics arrive later |
| [cancelled](examples/cancelled.ndjson) | Cancellation remains distinct from HTTP and transport errors |
| [interrupted](examples/interrupted.ndjson) | Unfinished request and method blocks survive an interrupted recording |
| [redacted-truncated](examples/redacted-truncated.ndjson) | Both capture conditions are visible; partial JSON is retained as text |
| [redirect](examples/redirect.ndjson) | New origin/attempt; redirect response body is unavailable |
| [multi-session](examples/multi-session.ndjson) | Interleaved sessions and a reused external session ID; 12 requests in the resumed session |
| [manual-minimal](examples/manual-minimal.ndjson) | Customer request without method spans or complete metadata |
| [manual-observation-stopped](examples/manual-observation-stopped.ndjson) | Known HTTP status, explicitly unknown transfer outcome |
| [stream-read-timeout](examples/stream-read-timeout.ndjson) | Calling method returns at headers; later body timeout remains a failure |
| [ios-partial-metrics](examples/ios-partial-metrics.ndjson) | Failed TLS phase retains start and null end |
| [ios-logical-transactions](examples/ios-logical-transactions.ndjson) | Multiple native transaction snapshots under one logical task |
| [handler-http](examples/handler-http.ndjson) | SDK → app handler → HTTP → app return → SDK resumes |
| [handler-no-http](examples/handler-no-http.ndjson) | Handler call and return without any HTTP |
| [handler-throw](examples/handler-throw.ndjson) | Handler exception caught by a successful SDK caller |
| [handler-cancelled](examples/handler-cancelled.ndjson) | Cancellation exit stays distinct from normal return |
| [handler-stopped](examples/handler-stopped.ndjson) | Observation stops without claiming method exit |
| [handler-interrupted](examples/handler-interrupted.ndjson) | Missing handler end remains unfinished |

All examples are synthetic. Hosts use reserved `.example` names. Readable event/recording IDs make review easier; real producers should generate collision-resistant IDs. The generated session example uses a UUID.

## Maintain the contract

`scripts/build-schema.mjs` is the authoring source for the standalone JSON Schema. `scripts/build-examples.mjs` generates deterministic NDJSON and the manifest. Consumers can use the generated schema directly without either script or Node.js.

```sh
npm run generate
npm test
```

The tests check generated-file reproducibility, all reference examples, import recovery, and rejection of contradictory records. Modify the authoring sources and regenerate; do not edit generated files independently.

Version `1.1` adds explicit synchronous handler calls and returns; `1.2` adds browser producers and explicitly awaited handler settlement. Older recordings retain their original semantics. SDKs are source-integrated development prototypes, not published production releases. Dependencies and lockfile are scoped to this repository, independent of the surrounding application.

## Interactive viewer

Run `npm ci && npm run viewer`, then open http://127.0.0.1:4173. Import NDJSON or open a bundled sample to inspect HTTP exchanges and SDK/app handler calls. See [viewer setup and controls](viewer/README.md), [design provenance](docs/design/README.md), and [verification evidence](docs/VIEWER-REVIEW.md).
