# Integrate an existing app

Give an agent this repository URL: **https://github.com/patjackson52/http-sequence-logger**. The root [AGENTS.md](../../AGENTS.md) points here. A [ready-to-use agent prompt](AGENT-PROMPT.md) supplies the requested outcome when the receiving agent has no conversation history.

This is source integration for development builds. Keep the collector and viewer on the developer's computer; no mobile WebView, hosted backend, service account, or dashboard is required. Browser frontend capture uses the separate web SDK, not the viewer's implementation.

## Choose the platform route

| Component | Implemented | Integration responsibility |
| --- | --- | --- |
| Android Kotlin capture | HTTP/manual logging, method and synchronous handler spans, redaction, file/HTTP sinks | Import source modules, inject API/no-op or debug recorder, adapt existing client callbacks |
| iOS Swift transfer | Durable delivery of sanitized NDJSON; native manual demo | Add local `ios/` package to a development target; supply a compatible event producer |
| General Swift capture SDK | **Not implemented** | If no producer exists, implement an app-owned adapter against the format; this is additional work, not a package-install step |
| Browser JavaScript/TypeScript capture | Fetch/XHR/manual HTTP, methods, synchronous/awaited handlers, redaction, memory/IndexedDB, continuous foreground delivery | Install pinned `web-sdk/` source package; wire debug/no-op build aliases, app-owned contexts and a same-origin development relay or export |
| Desktop collector/viewer | All-device Android and booted-simulator discovery, source registry, scoped HTTP/HTTPS upload, durable SQLite worker and SSE hints, file import, interactive HTTP/handler sequence | Start local tools for the actual app; initialize native debug bootstrap or browser journal/relay; physical iOS uses explicit HTTPS pairing |
| Client/server trace merging | Format has correlation concepts; no turnkey server instrumentation/merge integration | Future work; don't enable trace headers or claim distributed tracing automatically |

Read [Android integration](ANDROID.md), [iOS integration](IOS.md), or [browser integration](WEB.md), then [connection and file map](TRANSPORT.md). Consult [the JSON/spec index](SPECS.md) when implementing adapters or diagnosing validation failures. The independent examples under [integration/](../../integration/) verify consumption without importing the sample apps.

## Start from the URL

Inspect the host app first: platform targets/build variants, HTTP clients and interception hooks, existing logging, application/bundle IDs, minimum OS, build tool versions, release graph, security configuration, and its dependency policy. Infer these from source/build files where possible. Ask only for missing choices that change the integration, such as which app/SDK operation to instrument or an unavailable device.

Use a reviewed source revision. There is no Maven/npm publication or Swift package at the repository root. For example, from the host repository:

```sh
git clone https://github.com/patjackson52/http-sequence-logger.git third_party/http-sequence-logger
git -C third_party/http-sequence-logger rev-parse HEAD
```

Record that full commit in the host's dependency lock record, submodule, or vendoring manifest according to its existing convention. Do not leave an integration dependent on a moving `main`. Preserve the MIT license if vendoring. If a checkout already exists, inspect/reuse it rather than cloning over or replacing it. The guides assume `third_party/http-sequence-logger`; substitute the actual path consistently.

## Start realtime viewing

After instrumenting/installing a host debug app and initializing its bootstrap, run `npm ci` then **`npm start`** in the logger checkout. It discovers all authorized Android devices and booted iOS simulators. Device/package/bundle flags are optional filters. The app and collector can start in either order. `npm run android:live -- --device SERIAL` builds/installs the repository sample only.

Physical iOS uses private version 2 HTTPS enrollment; browser debug pages register and drain IndexedDB through their same-origin Node relay. The relay stays mounted and waits if collector configuration is absent. Source credentials stay in native private storage or Node. See the [platform routes](TRANSPORT.md#select-the-device-route).

Open **http://127.0.0.1:4319/** normally; guarded viewer bootstrap and refresh/reconnect are automatic. Devices and environments → Apps → Sessions lists zero-event registrations and retained history. Confirm actual events, rather than relying on viewer Live status alone. Collection continues while viewer updates are paused. **Save capture** exports current NDJSON from `artifacts/collector-v2/capture.sqlite`. File-only viewer port `4173` does not subscribe. Earlier state/capture formats are left untouched and are not migrated.

## Implement in this order

1. Establish debug/production dependency and source membership before adding call sites. Production retains only an app-owned abstraction, Android `logger-api`, or the browser package's default no-op entry.
2. Own the recording lifetime and a unique canonical capture path, or a browser database/journal ID with one writer. Pick an app-specific session namespace; accept an existing opaque session/instance ID or generate one when recording starts. Multiple sessions may share a file/journal; each new recording has distinct recording/event IDs.
3. Instrument one existing app request, then an SDK request and an SDK invocation of an app-supplied handler. Preserve the application's HTTP and callback behavior. Extend to other clients with the same manual API/format, not another log format.
4. Validate the local NDJSON before enabling transfer. Configure app-specific redaction, body bounds, backup exclusions, rotation and a local export path. Do not collect passwords/tokens to demonstrate logging works.
5. Connect via the [platform transport route](TRANSPORT.md), open the ordinary collector URL, and inspect the actual capture. Check live delivery, refresh and reconnect; retain local export when delivery is unavailable.
6. Verify the customer's development and shipping variants and leave a short app-specific integration note with the actual paths, commands and ownership decisions.

## Acceptance evidence

An integration is complete when its own app has evidence for these checks:

- Development build succeeds; real app/SDK HTTP requests appear with correct origin lanes, ownership, status, body-capture state, and session grouping. A custom client can add manual observations without switching networking stacks.
- An SDK → app handler → SDK scenario preserves application behavior and shows a local call/return with nested HTTP. Missing or unobserved exits remain incomplete. If this app has no such handler, record that scope explicitly instead of manufacturing one in its business code.
- `node validate.mjs <export.ndjson>` passes; warnings are reviewed. Schema validation alone does not establish redaction or correct app behavior: inspect a sanitized sample and compare known request counts/outcomes.
- Collector offline/reconnect or close/reopen retains pending events with unchanged IDs. Browser foreground delivery retries automatically; page unload/closed-tab background transfer is not promised. The plain viewer URL reconnects after refresh and catches up without duplicate requests. For Android USB, reconnect the authorized device and check automatic pairing/retrieval. Exported canonical logs stay usable without the collector.
- Shipping artifact contains no recorder/transfer classes, native libraries, pairing/export UI, development resources, or added logging dependencies. Check both the graph and final artifact, including browser chunks/maps/precache; shrinking, `#if DEBUG`, or a runtime frontend flag alone is insufficient. The small shared abstraction is allowed.
- Existing host tests pass and native request results/errors/cancellation remain unchanged. Report actual commands/devices tested and anything not exercised.

Leave the upstream commit, build configurations, logger/provider owner, canonical journal/pairing paths (or browser origin/database/journal and relay setup), session policy, adapters, redaction keys, collector invocation, release-audit evidence, and known limitations in the host's integration note. Never include pairing tokens, private keys, real credentials or raw unsanitized payloads in that note.

For repository examples and prior evidence see [Android setup](../../android/README.md), [iOS setup](../../ios/README.md), [release review](../RELEASE-REVIEW.md), and [native transfer evidence](../../samples/transfer/README.md). These establish a baseline, not proof that a different app is already integrated.

The [agent integration review](REVIEW.md) records the plan-review decisions, independent consumer checks, and their limits.
