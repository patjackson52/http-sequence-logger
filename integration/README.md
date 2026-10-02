# Independent consumer examples

These minimal builds exercise source/local-package installation without importing the original Android or iOS sample applications. They are references for [integrating an existing app](../docs/integration/README.md), not another SDK or a substitute for testing the customer's app.

| Fixture | Run from repository root | Evidence |
| --- | --- | --- |
| [Android](android-consumer/README.md) | `scripts/check-android-integration.sh` | Shared manual HTTP/handler API, source-set injection, synthetic NDJSON validation, Debug/Release builds, business/no-op behavior and recorder exclusion |
| [Swift](ios-consumer/README.md) | `scripts/check-ios-integration.sh` | Local `ios/` package API, empty-spool lifecycle, independent production abstraction/no-op with no transfer dependency, wrong-configuration rejection |

Use Node 24.13.x and `rg` for the scripts. Android additionally needs JDK 17, `ANDROID_HOME`, SDK Platform 35 and SDK command-line tools; run `npm ci` first for its validator. Swift requires a Mac with Swift 6. See each fixture's README for exact limits and output paths. Generated output goes to ignored build/artifact directories; never commit pairing configuration or customer captures from a verification run.
