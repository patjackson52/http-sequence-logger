# Prompt for an integration agent

Copy the following into an agent working in the target application's repository. Replace the bracketed fields when known; the agent can discover build settings and IDs from the app.

```text
Integrate https://github.com/patjackson52/http-sequence-logger into this application's development builds and connect its captures to the local sequence viewer.

Target app/platform: [Android, iOS, browser frontend, or a combination; application path if needed].
Representative flow: [optional: an existing app → SDK → app handler flow].

First inspect this app's repository instructions, build variants/targets, dependency conventions, HTTP clients, logging, redaction and backup/network policies. Read the logger repository's AGENTS.md and docs/integration/README.md, then its platform guide, TRANSPORT.md and SPECS.md. Pin and record the actual source revision used. Do not assume published Maven/npm artifacts or a root remote Swift package.

Plan the integration, then implement it through the app's existing networking hooks or the manual recording interface. Keep business requests, callbacks, cancellation and error handling unchanged. Track app vs SDK ownership, opaque session IDs, explicit method/handler context, and known metadata without inventing missing observations. Preserve custom HTTP-client support.

Android uses the small logger-api in shared code, RecordingLogger and file/transfer sinks only in debug wiring, and NoOpLogger in production. The iOS package is a sanitized NDJSON transfer sink, not a full Swift capture SDK. If this app lacks a compatible Swift event producer, explicitly identify and implement the scoped app-owned capture adapter needed for the chosen flow against the schema; do not claim transfer alone captures URLSession requests or use design-only APIs as existing code. Keep iOS production free of the package dependency and development source/resources.

Browser apps install the pinned web-sdk directory as a local package. Use compile-time aliases and separate setup modules: default @http-sequence-logger/web is no-op; /debug contains recorder, Fetch/XHR/manual adapters, journals and uploader; /dev-relay belongs only to the Node development server. Read WEB.md. Preserve native body consumption, use explicit Fetch readers or manual completion, dispose XHR observers before reuse, and pass handler contexts explicitly. invokeHandler observes immediate return; invokeAsyncHandler observes awaited promise settlement. Do not describe async spans as blocked JavaScript threads.

Choose app-owned canonical capture and spool locations, recording lifetimes, session namespace, bounded retention, redaction, backup exclusions and an export path. Do not add a hosted service or place the viewer in the production app. Keep pairing tokens/keys out of code, captures and commits.

For realtime viewing, run npm ci in the pinned logger checkout. For an instrumented Android debug app, build/install it using this app's toolchain, then run npm run collector -- --android ACTUAL_DEBUG_APPLICATION_ID --open. ADB discovery, device selection, reverse forwarding, private pairing and viewer build are automatic; add --device SERIAL only when needed. npm run android:live builds/installs/runs the repository sample, not our app. Use npm start for an already installed repository sample, or npm start -- --no-android for iOS/browser work. Inspect an existing collector before starting another on the same port.

Open the ordinary http://127.0.0.1:4319/ URL; no token fragment, collector ID or pasted browser configuration is needed. Keep the collector running and verify its connection, producer delivery and increasing event count. Confirm automatic viewer refresh/reconnect and, on Android USB, recovery after disconnect/reconnect. The viewer follows new sessions until inspection/filtering; Pause live and file import pause browser updates, while the collector keeps saving. Save capture exports artifacts/collector/capture.ndjson (or the chosen --dir). npm run viewer on 4173 is file-only. iOS Simulator still uses loopback pairing JSON; a physical iPhone uses paired LAN HTTPS. Obtain those through Other devices or the private connection files. Automatic viewer connection does not replace native pairing.

For browsers, record the actual origin, IndexedDB database and journal ID instead of inventing a device file path. Use one writer, flush for persistence, keep a recovery export, and explicitly upload through the same-origin loopback development relay. Relay pairing credentials stay server-side; do not bundle them or relax collector CORS. Repeated upload replays retained records and the collector deduplicates; there is no browser background sender or ACK cursor. Audit shipping chunks, source maps, copied resources and service-worker precaches for development code/UI.

Complete the acceptance checks in docs/integration/README.md using this app: build development and shipping variants, exercise the chosen real flow, validate exported NDJSON, inspect HTTP/handler nesting in the viewer, verify offline delivery recovery, and audit this app's release graph and binary for recorder/transfer code, dependencies and resources. Distinguish executed checks from environment blockers; never fabricate successful logs.

Leave a concise integration note with upstream commit, changed files, actual capture/spool/pairing paths, start/reconnect/export and device-selection commands, SDK/manual-adapter ownership, session/redaction policy, test evidence, release isolation evidence and remaining limits. Ask only for missing information that materially blocks the work; otherwise use the host's existing conventions.
```

Short version when context is already clear:

```text
Integrate https://github.com/patjackson52/http-sequence-logger into this app using its AGENTS.md and docs/integration/README.md. Preserve production isolation, support our existing/custom HTTP clients and SDK-to-app handlers, and connect real captures to the plain local viewer URL at http://127.0.0.1:4319/. Use our actual Android app ID or the documented iOS/browser delivery route. Complete the customer-app acceptance checks, including refresh/reconnect and shipping-build isolation. Document exact log locations and start/export commands.
```
