# Network Log Lab

A local browser viewer for the SDK's schema 1.0, 1.1 and 1.2 NDJSON. It follows the [imported Claude design](../docs/design/README.md), including SDK → app handler → SDK control flow.

Agents integrating an app should start with [AGENTS.md](../AGENTS.md) and the [integration guide](../docs/integration/README.md). Keep this viewer on the desktop; the [transport map](../docs/integration/TRANSPORT.md) distinguishes live collector port 4319 from file-import development/preview port 4173.

## Live device captures

From the repository root, with Node 22.12+:

```sh
npm ci
npm start
```

Open **http://127.0.0.1:4319/**. The command builds/opens the viewer, starts the collector and watches the installed Android sample. The ordinary URL connects automatically; refresh normally. No token URL, browser storage or pasted browser configuration is needed. **`npm run android:live`** also builds/installs the sample, pairs USB and runs a sign-in on the selected phone. For a customer Android debug app use `npm run collector -- --android YOUR_APPLICATION_ID --open`; for iOS/browser work use `npm start -- --no-android` and complete its [producer transfer route](../docs/integration/TRANSPORT.md#select-the-device-route). Keep the collector terminal running.

The live panel distinguishes collector connection, event count and Android device readiness. **Live** means this browser is connected, even when no producer has sent events yet. USB disconnects and reinstalls are retried automatically. A collector restart reconnects; changing its identity clears the old capture before loading the new one. Device upload credentials still stay private and upload authentication is unchanged. **Other devices** exposes explicit iOS/manual pairing; browser producers use a server-side relay and explicit upload.

**Follow newest session** is enabled initially. New sessions come into view as events arrive; selecting a session/request, changing filters or collapsing a method stops following so inspection stays in place. Enable it again to return to the newest session. Updates within the selected session preserve its diagram state. **Pause live** or importing a file stops browser updates; **Resume live** returns to the collector. The collector continues saving while paused. **Save capture** downloads its persisted NDJSON across all sessions, stored by default in `<checkout>/artifacts/collector/capture.ndjson`. [Storage and troubleshooting](../docs/integration/TRANSPORT.md) cover custom directories and connection failures.

The file-only Vite viewer at port 4173 remains available via `npm run viewer`; its live link opens the collector at 4319. It never probes unrelated sites or scans local ports. Legacy token links remain accepted, but the collector now prints only its ordinary URL.

## File import only

After `npm ci`, run `npm run viewer` and open **http://127.0.0.1:4173/**. Choose or drop one or more capture files, then select **Open** beside a session. **Open sample** includes the real Android successful/recovered sign-ins and focused edge-case fixtures. For a built static bundle:

```sh
npm run build:viewer
npm run preview:viewer
```

The static output is `viewer/dist/`. Serve this directory over HTTP; direct `file://` loading is not supported because the importer uses a module worker. File mode needs no collector, account or dashboard. Bundled fonts and samples are served from the same origin. Imported files remain in memory and are cleared on refresh; no persistence or upload is performed. A strict content-security policy is included in `index.html`.

## Reading a capture

- Sessions group the exact namespace and session ID. A session can contain multiple independent recording periods; select a recording or show them in file order. Schema version is visible per recording.
- App and SDK lifelines represent **execution** ownership. Expand their components for more detail. Every observed HTTP origin has a distinct lane; the Attribution tab also retains the business initiator.
- Solid filled arrows are HTTP requests. Header observations and terminal outcomes are distinct. HTTP 200 followed by a body timeout remains a failure with the 200 visible. Unknown, cancelled, unfinished and application-error outcomes remain distinct.
- Indigo open arrows are local handler calls and confirmed returns. Waiting hatching belongs only to the calling method. Stopped or missing handler exits have no fabricated return. Arguments, return values and business results are not captured.
- Click any request, response, outcome, method or handler to inspect it. HTTP details include repeated headers/query parameters, bodies and their capture state, timing, native metrics, attribution, retries and recorded NDJSON. Handler details include caller/callee, outcome, direct children and raw events. IDs live in detail views, not diagram labels.
- Search paths, method/component names, caller names or span IDs. Filter by execution owner, outcome, origin, or HTTP/local calls. HTTP-only mode preserves handler ancestry. Collapse individual methods or all methods. Mobile has horizontally pannable Sequence and paginated List views, session/filter sheets and a full-screen details dialog.
- Arrow keys or j/k select sequence rows; Enter inspects; Escape closes details. Left/right navigate caller and children; brackets collapse/expand a selected method; h toggles HTTP-only. Resize the desktop inspector by dragging its divider or using left/right on the focused divider.

## Share a sequence as SVG

Choose a session, apply any filters, expand component lanes or collapse methods, and select an item to highlight it. Click **Download SVG** beside the Sequence/List controls. The downloaded image includes the session title, client and server lane headings, recording bands, method/handler blocks, arrows, status, timing labels and visible payload snippets.

The export uses the current sequence layout, including the selected recording, filters, collapsed methods, expanded components and selection highlight. It contains the **full diagram**, including rows and lanes outside the scroll viewport. Downloading from List view exports that same sequence. An empty filter result disables the button. Live captures export a snapshot of the events currently loaded; download again for later updates.

Filters, navigation, inspector details, focus/hover effects and expand/collapse buttons are excluded. Hidden child events remain hidden, with their static count retained. This is an image, not an NDJSON export; use **Save capture** in a live collector session to retain the underlying events.

SVG uses native vector shapes and escaped text with system font fallbacks. It has no scripts, HTML overlays, external resources or embedded source logs, so it can be opened independently or embedded as an image in documentation. Exact glyphs and text widths can vary with installed fonts; long labels are ellipsized. It retains the capture's existing redaction and the currently visible snippets. It does not perform additional redaction.

For a GitHub README, commit the SVG and use a relative image link such as `![Sign-in sequence](docs/sign-in-sequence.svg)`. Keep the file beside the documentation when sharing elsewhere.

## Import behavior and limits

The shared contract validator is compiled into a CSP-safe standalone schema validator at build time. Parsing/validation runs in a browser worker. Each file preserves its own final-line recovery semantics. Overlapping exports deduplicate identical event IDs and preserve source attribution; contradictory duplicates are diagnosed. Malformed/schema-invalid lines are skipped, semantic contradictions are flagged, and partial recordings remain inspectable. Orphan observations remain visible without invented request starts or owners.

Limits: **16 MiB/file, 64 MiB/import, 100,000 events**. The intended session size is around 10–20 HTTP requests. List view pages at 200 items; sequence layout is not virtualized, so collapse large sessions. The importer limits are memory guards, not a claim that 100,000-event diagrams remain interactive.

The viewer displays the capture's existing redaction; it does not apply another privacy policy. All imported values are rendered as text, including URLs, markup and payloads. It never opens a URL from a capture.

## Verification

```sh
npm test
npm run build:viewer
# Real SVG downloads, offline rendering and desktop/mobile controls; requires Chrome:
npm run check:svg-export
npm run check:live-setup
# Optional fresh native run; requires Android SDK + emulator:
JAVA_HOME=/path/to/jdk17 ANDROID_SERIAL=emulator-5554 scripts/run-android-e2e.sh
```

Import the resulting `artifacts/live/multi-session.ndjson` to inspect the fresh native output. [Review and end-to-end evidence](../docs/VIEWER-REVIEW.md) records the verification. [Design history](../docs/design/README.md) documents deliberate resolutions where prototype and contract differ.

Deferred: server-side log merging, asynchronous continuation telemetry, session comparison, persisted imports and Mermaid/PlantUML export. The viewer preserves trace/correlation metadata for that future work without inferring cross-device timing.
