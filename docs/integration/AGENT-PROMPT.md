# Prompt for an integration agent

Copy the following into an agent working in the target application's repository. Replace the bracketed fields when known; the agent can discover build settings and IDs from the app.

```text
Integrate https://github.com/patjackson52/http-sequence-logger into this application's development builds and connect its captures to the local sequence viewer.

Target app/platform: [Android, iOS, or both; application path if needed].
Representative flow: [optional: an existing app → SDK → app handler flow].

First inspect this app's repository instructions, build variants/targets, dependency conventions, HTTP clients, logging, redaction and backup/network policies. Read the logger repository's AGENTS.md and docs/integration/README.md, then its platform guide, TRANSPORT.md and SPECS.md. Pin and record the actual source revision used. Do not assume published Maven artifacts or a root remote Swift package.

Plan the integration, then implement it through the app's existing networking hooks or the manual recording interface. Keep business requests, callbacks, cancellation and error handling unchanged. Track app vs SDK ownership, opaque session IDs, explicit method/handler context, and known metadata without inventing missing observations. Preserve custom HTTP-client support.

Android uses the small logger-api in shared code, RecordingLogger and file/transfer sinks only in debug wiring, and NoOpLogger in production. The iOS package is a sanitized NDJSON transfer sink, not a full Swift capture SDK. If this app lacks a compatible Swift event producer, explicitly identify and implement the scoped app-owned capture adapter needed for the chosen flow against the schema; do not claim transfer alone captures URLSession requests or use design-only APIs as existing code. Keep iOS production free of the package dependency and development source/resources.

Choose app-owned canonical capture and spool locations, recording lifetimes, session namespace, bounded retention, redaction, backup exclusions and an export path. Configure the local collector for the actual installed application ID/device; use ADB reverse for Android USB/emulator, loopback for iOS Simulator, or paired HTTPS for a physical device. Do not add a hosted service or place the viewer in the production app. Keep pairing tokens/keys out of code, captures and commits.

Complete the acceptance checks in docs/integration/README.md using this app: build development and shipping variants, exercise the chosen real flow, validate exported NDJSON, inspect HTTP/handler nesting in the viewer, verify offline delivery recovery, and audit this app's release graph and binary for recorder/transfer code, dependencies and resources. Distinguish executed checks from environment blockers; never fabricate successful logs.

Leave a concise integration note with upstream commit, changed files, actual capture/spool/pairing paths, configuration and device-selection commands, SDK/manual-adapter ownership, session/redaction policy, test evidence, release isolation evidence and remaining limits. Ask only for missing information that materially blocks the work; otherwise use the host's existing conventions.
```

Short version when context is already clear:

> Integrate https://github.com/patjackson52/http-sequence-logger into this app using its AGENTS.md and docs/integration/README.md. Preserve production isolation, support our existing HTTP clients, connect the local viewer, and complete the customer-app acceptance checks with real sanitized logs.
