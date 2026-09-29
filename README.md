# Mobile network log contract

Draft **1.0** capture format for Android and iOS development SDKs and a local-file sequence viewer. This package defines the shared contract and synthetic examples; it does not implement a mobile SDK or the viewer.

## Start here

- [Contract](CONTRACT.md): event semantics, identity, timing, capture fidelity, and importer behavior.
- [Standalone JSON Schema](schema/event.schema.json): JSON Schema 2020-12 for one event/NDJSON line.
- [Adapter contract](ADAPTERS.md): native wrappers and the client-independent recording API.
- [Customer manual logging](MANUAL-LOGGING.md): required public API, defaults, and Kotlin/Swift integration sketches.
- [Correctness review](REVIEW.md): network, Android, and iOS findings, fixes, and remaining native verification.
- [Example manifest](examples/manifest.json): scenarios, descriptions, and expected summaries.
- [Multi-session capture](examples/multi-session.ndjson): 14 requests, six origins, two sessions, three recording periods.

## Validate locally

Use Node.js 22 or later from this directory:

```sh
npm ci
npm run validate
npm test
node validate.mjs /absolute/path/to/capture.ndjson
```

Validation performs JSON Schema checks and additional relationship, timing, body-byte, retry, and outcome checks. Exit code `0` means no detected contradictions; warnings can still identify missing data. Exit code `1` means invalid input; `2` means the CLI was called without a filename.

`interrupted.ndjson` deliberately produces warnings for its missing session/operation/request ends. The importer preserves those records rather than inventing completion.

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

All examples are synthetic. Hosts use reserved `.example` names. Readable event/recording IDs make review easier; real producers should generate collision-resistant IDs. The generated session example uses a UUID.

## Maintain the contract

`scripts/build-schema.mjs` is the authoring source for the standalone JSON Schema. `scripts/build-examples.mjs` generates deterministic NDJSON and the manifest. Consumers can use the generated schema directly without either script or Node.js.

```sh
npm run generate
npm test
```

The tests check generated-file reproducibility, all reference examples, import recovery, and rejection of contradictory records. Modify the authoring sources and regenerate; do not edit generated files independently.

This draft remains reviewable before native implementation. Version `1.0` identifies the proposed format, not a claim of a released SDK. Dependencies and lockfile are scoped to this package, independent of the surrounding application.
