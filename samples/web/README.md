# Real browser captures

These are sanitized NDJSON exported by the runnable [web sample](../../web-sample/) in isolated headless Google Chrome. The servers are actual loopback HTTP fixture processes with demonstration data, not mock Fetch/XHR implementations and not a real identity provider. No live user credentials are involved.

- [browser-auth-recovery.ndjson](browser-auth-recovery.ndjson): 36 events, 6 requests across 2 server origins, SDK → awaited app XHR handler → SDK, expected HTTP 401 followed by refresh and success.
- [browser-multi-session.ndjson](browser-multi-session.ndjson): the auth flow plus boundary checks; 63 events, 11 requests, 2 sessions. Includes native AbortError, opaque response and explicitly stopped unread-body observation. The 2 unknown outcomes are intentional.
- [manifest.json](manifest.json): browser version, observed UTC date, validated summaries and exercised checks.

Reproduce from the repository root with installed Google Chrome:

```sh
npm ci
npm run check:web-browser
```

The harness builds the viewer/production sample, starts an isolated collector and two fixture servers, runs the actual development page, exports downloads, reopens IndexedDB, reloads the page, uploads/replays, tests collector recovery, inspects the viewer, and runs the production no-op sign-in. It uses a new browser profile and cleans up servers/pairing files. Ports 4180–4182 must be free. `WEB_TEST_CHANNEL` can select another Playwright Chromium channel already installed; this evidence only claims the recorded Chrome version.

Fresh private test outputs/screenshots are under ignored `artifacts/web-browser/`. Intentional updates to committed captures use `UPDATE_WEB_SAMPLES=1 npm run check:web-browser`; review the exported data before committing. Public API availability is not required by this deterministic test. The optional public API button is a separate best-effort demonstration.
