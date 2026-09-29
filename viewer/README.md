# Network Log Lab

A local browser viewer for the SDK's schema 1.0 and 1.1 NDJSON. It follows the [imported Claude design](../docs/design/README.md), including SDK → app handler → SDK control flow.

Agents integrating a mobile app should start with the [integration guide](../docs/integration/README.md). Keep this viewer on the desktop; the [transport map](../docs/integration/TRANSPORT.md) distinguishes live collector port 4319 from file-import development/preview port 4173.

From the repository root, with Node 22.12+:

```sh
npm ci
npm run viewer
```

Open **http://127.0.0.1:4173**. Choose or drop one or more capture files. Select **Open** beside a session. **Open sample** includes the real Android successful/recovered sign-ins and focused edge-case fixtures.

For a production build:

```sh
npm run build:viewer
npm run preview:viewer
```

The static output is `viewer/dist/`. Serve this directory over HTTP; direct `file://` loading is not supported because the importer uses a module worker. No server backend, account, or dashboard is needed. Bundled fonts and samples are served from the same origin. Imported files remain in memory and are cleared on refresh; no persistence or upload is performed. A strict content-security policy is included in `index.html`.

## Live device captures

Run `npm run build:viewer` and `npm run collector`, then open the printed viewer link. Android ADB pairing, iOS Simulator and Wi-Fi HTTPS setup are in the [transfer guide](../docs/transfer/README.md). The collector feeds durable NDJSON into the same validation/diagram pipeline. Live updates preserve selected sessions, filters, collapsed blocks and inspector state. Connection loss is separate from request outcomes; reconnect retrieves missing events. Save capture downloads the persisted file. Refreshing clears the in-memory browser pairing, so reopen the printed link.

## Reading a capture

- Sessions group the exact namespace and session ID. A session can contain multiple independent recording periods; select a recording or show them in file order. Schema version is visible per recording.
- App and SDK lifelines represent **execution** ownership. Expand their components for more detail. Every observed HTTP origin has a distinct lane; the Attribution tab also retains the business initiator.
- Solid filled arrows are HTTP requests. Header observations and terminal outcomes are distinct. HTTP 200 followed by a body timeout remains a failure with the 200 visible. Unknown, cancelled, unfinished and application-error outcomes remain distinct.
- Indigo open arrows are local handler calls and confirmed returns. Waiting hatching belongs only to the calling method. Stopped or missing handler exits have no fabricated return. Arguments, return values and business results are not captured.
- Click any request, response, outcome, method or handler to inspect it. HTTP details include repeated headers/query parameters, bodies and their capture state, timing, native metrics, attribution, retries and recorded NDJSON. Handler details include caller/callee, outcome, direct children and raw events. IDs live in detail views, not diagram labels.
- Search paths, method/component names, caller names or span IDs. Filter by execution owner, outcome, origin, or HTTP/local calls. HTTP-only mode preserves handler ancestry. Collapse individual methods or all methods. Mobile has horizontally pannable Sequence and paginated List views, session/filter sheets and a full-screen details dialog.
- Arrow keys or j/k select sequence rows; Enter inspects; Escape closes details. Left/right navigate caller and children; brackets collapse/expand a selected method; h toggles HTTP-only. Resize the desktop inspector by dragging its divider or using left/right on the focused divider.

## Import behavior and limits

The shared contract validator is compiled into a CSP-safe standalone schema validator at build time. Parsing/validation runs in a browser worker. Each file preserves its own final-line recovery semantics. Overlapping exports deduplicate identical event IDs and preserve source attribution; contradictory duplicates are diagnosed. Malformed/schema-invalid lines are skipped, semantic contradictions are flagged, and partial recordings remain inspectable. Orphan observations remain visible without invented request starts or owners.

Limits: **16 MiB/file, 64 MiB/import, 100,000 events**. The intended session size is around 10–20 HTTP requests. List view pages at 200 items; sequence layout is not virtualized, so collapse large sessions. The importer limits are memory guards, not a claim that 100,000-event diagrams remain interactive.

The viewer displays the capture's existing redaction; it does not apply another privacy policy. All imported values are rendered as text, including URLs, markup and payloads. It never opens a URL from a capture.

## Verification

```sh
npm test
npm run build:viewer
# Optional fresh native run; requires Android SDK + emulator:
JAVA_HOME=/path/to/jdk17 ANDROID_SERIAL=emulator-5554 scripts/run-android-e2e.sh
```

Import the resulting `artifacts/live/multi-session.ndjson` to inspect the fresh native output. [Review and end-to-end evidence](../docs/VIEWER-REVIEW.md) records the verification. [Design history](../docs/design/README.md) documents deliberate resolutions where prototype and contract differ.

Deferred: server-side log merging, asynchronous continuation telemetry, session comparison, persisted imports and Mermaid/PlantUML export. The viewer preserves trace/correlation metadata for that future work without inferring cross-device timing.
