# External Swift consumer smoke fixture

Run `scripts/check-ios-integration.sh` from the repository root on a Mac with Swift 6, Node.js 22.12+, and `rg`. No collector, credentials, simulator, or network requests are needed.

This fixture demonstrates two independent package graphs:

- `Package.swift` is the development consumer. It adds `../../ios` as a local package and builds an app-owned adapter against the actual `NetworkLogTransfer` API.
- `Production/Package.swift` has **no package dependencies**. It builds the same `AppLogging` abstraction and no-op implementation, plus a small executable that verifies the file supplier is never evaluated.

The development manifest references the shared source directory inside `Production/`; the production package never references the development adapter or transfer package. The explicit Release compile error in the development adapter catches accidentally building the wrong fixture. This is not a recommendation to copy these two package manifests into an existing Xcode app: use separate app-target dependency and source membership as described in the [iOS integration guide](../../docs/integration/IOS.md).

`DevelopmentCaptureDelivery` relays an already-sanitized, already-persisted canonical capture or appends a line that its producer has already persisted. It does not implement HTTP observation, session/event generation, handlers, redaction, or canonical file writing. Those responsibilities belong to the upstream producer. Its shared abstraction concerns **delivery only**; a customer's capture abstraction must separately ensure production never creates or serializes events.

Checks performed:

1. Debug consumer compiles against the real local package; a test opens/closes an empty spool through the adapter without uploading anything.
2. The independent production package builds and tests in Release, with a lazy no-op supplier test and executable smoke check.
3. The production manifest has zero dependencies and its executable has no transfer/adapter symbols.
4. Building the development fixture in Release fails with its intended diagnostic.

Reports go to ignored `artifacts/integration-ios/`; compiler output stays in the terminal. Build outputs are ignored under each package's `.build/`. These are macOS host API/build checks. They do **not** prove an iOS customer's target membership, linked frameworks, shipping archive, real request capture, file relay, or physical-device LAN connectivity. Complete the customer's acceptance checks in the integration guide.
