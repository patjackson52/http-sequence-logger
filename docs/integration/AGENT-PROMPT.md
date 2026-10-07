# Prompt for an integration agent

Copy the following into an agent working in the target application's repository. Replace the bracketed fields when known; the agent can discover build settings and IDs from the app.

```text
Integrate https://github.com/patjackson52/http-sequence-logger into this application's development builds and connect its captures to the local sequence viewer.

Target app/platform: [Android, iOS, browser frontend, or a combination; application path if needed].
Representative flow: [optional: an existing app → SDK → app handler flow].

First inspect this app's repository instructions, build variants/targets, dependency conventions, HTTP clients, logging, redaction and backup/network policies. Read the logger repository's AGENTS.md and docs/integration/README.md, then only its relevant platform guide, docs/integration/TRANSPORT.md and docs/integration/SPECS.md. Pin and record the actual source revision used. Do not assume published Maven/npm artifacts or a root remote Swift package. Run logger npm/Node commands from that pinned checkout; host-app commands follow the host's own tooling.

Plan the integration, then implement it through the app's existing networking hooks or the manual recording interface. Keep business requests, callbacks, cancellation and error handling unchanged. Track app vs SDK ownership, opaque session IDs, explicit method/handler context, and known metadata without inventing missing observations. Preserve custom HTTP-client support.

Android uses the small logger-api in shared code, RecordingLogger and file/transfer sinks only in debug wiring, and NoOpLogger in production. The iOS package is a sanitized NDJSON transfer sink, not a full Swift capture SDK. If this app lacks a compatible Swift event producer, explicitly identify and implement the scoped app-owned capture adapter needed for the chosen flow against the schema; do not claim transfer alone captures URLSession requests or use design-only APIs as existing code. Keep iOS production free of the package dependency and development source/resources.

Browser apps install the pinned web-sdk directory as a local package. Use compile-time aliases and separate setup modules: default @http-sequence-logger/web is no-op; /debug contains recorder, Fetch/XHR/manual adapters, journals and uploader; /dev-relay belongs only to the Node development server. Read WEB.md. Preserve native body consumption, use explicit Fetch readers or manual completion, dispose XHR observers before reuse, and pass handler contexts explicitly. invokeHandler observes immediate return; invokeAsyncHandler observes awaited promise settlement. Do not describe async spans as blocked JavaScript threads.

Use the default debug bootstrap canonical journal locations, recording lifetimes, session namespace, bounded retention, redaction, backup exclusions and an export path. Do not add a hosted service or place the viewer in the production app. Keep pairing tokens/keys out of code, captures and commits.

For realtime viewing, run npm ci then npm start in the pinned logger checkout. Discover participating Android apps on all authorized devices and iOS apps on all booted simulators through their initialized debug descriptors. Optional --android ACTUAL_DEBUG_APPLICATION_ID, --device SERIAL, --ios BUNDLE_ID and --simulator UDID narrow discovery. npm run android:live -- --device SERIAL installs the repository sample, not our app. Missing tools/permissions disable only their adapter. The app/collector/frontend can start in either order.

Open the ordinary http://127.0.0.1:4319/ URL. Verify source registration, real events and Devices and environments → Apps → Sessions. Viewer Pause/file import pauses reads while collection continues; Save capture exports current NDJSON from artifacts/collector-v2/capture.sqlite. File-only port 4173 remains available. Use source-aware transfer version 2 and event schema 1.3 only; old state/sources/captures are left untouched, with no migration/backward-compatibility work. Physical iOS uses explicit trusted HTTPS enrollment; Bonjour only supplies candidates. Simulator pairing is automatic. Use collector/README.md and npm run collector -- --help for defaults and read-only status/doctor diagnostics.

Browser journals use origin-scoped environment/installation IDs and separate page journals with transactional writer epochs. startJournalDelivery registers zero-event pages and sends indexed ranges through an always-mounted same-origin Node relay. Collector credentials stay server-side. Retain canonical records and export on storage failure; no page-unload/closed-tab delivery guarantee. A remote HTTPS frontend requires authenticated development access, session-bound handles and CSRF, not just Host/Origin checks. Audit shipping chunks/maps/resources/precache for all debug code and UI.

Complete the acceptance checks in docs/integration/README.md using this app: build development and shipping variants, exercise the chosen real flow, validate exported NDJSON, inspect HTTP/handler nesting in the viewer, verify offline delivery recovery, and audit this app's release graph and binary for recorder/transfer code, dependencies and resources. Distinguish executed checks from environment blockers; never fabricate successful logs.

If the task includes server sources, read docs/integration/SERVER.md and ADAPTERS.md. Use explicit per-request contexts, first-party W3C propagation, and independent retrieval/parsing adapters. Keep credentials private in collector configuration. Verify actual local and deployed host requests, concurrent traces, replay, collection status/cancellation, remote links and unchanged-poll UI stability. A retained Cloudflare application endpoint is distinct from native console history.

If the task includes comparing captures, follow viewer/README.md and sequence-diff/README.md. Compare exactly one session per side by namespace plus session ID. Retain the frozen snapshots and applied profile, preserve unknown observations, and cite source event IDs/pointers. Replay viewer exports through the CLI with their exported profile; do not infer new matching or causality from layout positions.

Leave a concise integration note with upstream commit, changed files, actual canonical journal/pairing paths, start/reconnect/export and device-selection commands, SDK/manual-adapter ownership, session/redaction policy, test evidence, release isolation evidence and remaining limits. Ask only for missing information that materially blocks the work; otherwise use the host's existing conventions.
```

Short version when context is already clear:

```text
Integrate https://github.com/patjackson52/http-sequence-logger into this app using its AGENTS.md and docs/integration/README.md. Preserve production isolation, support our existing/custom HTTP clients and SDK-to-app handlers, and connect real captures to the plain local viewer URL at http://127.0.0.1:4319/. Use our actual Android app ID or the documented iOS/browser delivery route. Complete the customer-app acceptance checks, including refresh/reconnect and shipping-build isolation. Document exact log locations and start/export commands.
```
