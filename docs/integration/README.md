# Integrate an existing app

Give an agent this repository URL: **https://github.com/patjackson52/http-sequence-logger**. The root [AGENTS.md](../../AGENTS.md) points here. A [ready-to-use agent prompt](AGENT-PROMPT.md) supplies the requested outcome when the receiving agent has no conversation history.

This is source integration for development builds. Keep the collector and viewer on the developer's computer; no mobile WebView, hosted backend, service account, or dashboard is required.

## Choose the platform route

| Component | Implemented | Integration responsibility |
| --- | --- | --- |
| Android Kotlin capture | HTTP/manual logging, method and synchronous handler spans, redaction, file/HTTP sinks | Import source modules, inject API/no-op or debug recorder, adapt existing client callbacks |
| iOS Swift transfer | Durable delivery of sanitized NDJSON; native manual demo | Add local `ios/` package to a development target; supply a compatible event producer |
| General Swift capture SDK | **Not implemented** | If no producer exists, implement an app-owned adapter against the format; this is additional work, not a package-install step |
| Desktop collector/viewer | ADB file retrieval, paired HTTP/HTTPS upload, SSE updates, file import, interactive HTTP/handler sequence | Start local tools, pair the app or import a canonical capture |
| Client/server trace merging | Format has correlation concepts; no turnkey server instrumentation/merge integration | Future work; don't enable trace headers or claim distributed tracing automatically |

Read [Android integration](ANDROID.md) or [iOS integration](IOS.md), then [connection and file map](TRANSPORT.md). Consult [the JSON/spec index](SPECS.md) when implementing adapters or diagnosing validation failures. The independent examples under [integration/](../../integration/) verify consumption without importing the sample apps.

## Start from the URL

Inspect the host app first: platform targets/build variants, HTTP clients and interception hooks, existing logging, application/bundle IDs, minimum OS, build tool versions, release graph, security configuration, and its dependency policy. Infer these from source/build files where possible. Ask only for missing choices that change the integration, such as which app/SDK operation to instrument or an unavailable device.

Use a reviewed source revision. There is no Maven publication or Swift package at the repository root. For example, from the host repository:

```sh
git clone https://github.com/patjackson52/http-sequence-logger.git third_party/http-sequence-logger
git -C third_party/http-sequence-logger rev-parse HEAD
```

Record that full commit in the host's dependency lock record, submodule, or vendoring manifest according to its existing convention. Do not leave an integration dependent on a moving `main`. Preserve the MIT license if vendoring. If a checkout already exists, inspect/reuse it rather than cloning over or replacing it. The guides assume `third_party/http-sequence-logger`; substitute the actual path consistently.

## Implement in this order

1. Establish debug/production dependency and source membership before adding call sites. Production retains only an app-owned abstraction or Android `logger-api`/no-op.
2. Own the recording lifetime and a unique canonical capture path. Pick an app-specific session namespace; accept an existing opaque session/instance ID or generate one when recording starts. Multiple sessions may share a file; each new recording has distinct recording/event IDs.
3. Instrument one existing app request, then an SDK request and an SDK-supplied app handler. Preserve the application's HTTP and callback behavior. Extend to other clients with the same manual API/format, not another log format.
4. Validate the local NDJSON before enabling transfer. Configure app-specific redaction, body bounds, backup exclusions, rotation and a local export path. Do not collect passwords/tokens to prove logging works.
5. Connect via the [platform transport route](TRANSPORT.md), open the printed viewer link, and inspect the actual capture. Retain local export when delivery is unavailable.
6. Verify the customer's development and shipping variants and leave a short app-specific integration note with the actual paths, commands and ownership decisions.

## Acceptance evidence

An integration is complete when its own app has evidence for these checks:

- Development build succeeds; real app/SDK HTTP requests appear with correct origin lanes, ownership, status, body-capture state, and session grouping. A custom client can add manual observations without switching networking stacks.
- An SDK → app handler → SDK scenario preserves application behavior and shows a local call/return with nested HTTP. Missing or unobserved exits remain incomplete. If this app has no such handler, record that scope explicitly instead of manufacturing one in its business code.
- `node validate.mjs <export.ndjson>` passes; warnings are reviewed. Schema validation alone does not prove redaction or correct app behavior: inspect a sanitized sample and compare known request counts/outcomes.
- Collector offline/reconnect or close/reopen retains pending events with unchanged IDs. Viewer catches up without duplicate requests; exported canonical logs stay usable without the collector.
- Shipping artifact contains no recorder/transfer classes, native libraries, pairing/export UI, development resources, or added logging dependencies. Check both the graph and final artifact; shrinking or `#if DEBUG` alone is insufficient. The small shared abstraction is allowed.
- Existing host tests pass and native request results/errors/cancellation remain unchanged. Report actual commands/devices tested and anything not exercised.

Leave the upstream commit, build configurations, logger/provider owner, capture/spool/pairing paths, session policy, adapters, redaction keys, collector invocation, release-audit evidence, and known limitations in the host's integration note. Never include pairing tokens, private keys, real credentials or raw unsanitized payloads in that note.

For repository examples and prior evidence see [Android setup](../../android/README.md), [iOS setup](../../ios/README.md), [release review](../RELEASE-REVIEW.md), and [native transfer evidence](../../samples/transfer/README.md). These establish a baseline, not proof that a different app is already integrated.

The [agent integration review](REVIEW.md) records the plan-review decisions, independent consumer checks, and their limits.
