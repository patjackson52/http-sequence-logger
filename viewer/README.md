# Local sequence viewer

Choose the route from the logger checkout after `npm ci` with Node 24.13.x:

| Task | Command / guide |
| --- | --- |
| Collect live app captures and open the viewer | `npm start` → `http://127.0.0.1:4319/`; [collector setup and help](../collector/README.md) |
| Inspect existing local NDJSON without a collector | `npm run viewer` → `http://127.0.0.1:4173/` |
| Compare captures in a terminal, agent or CI | [Standalone diff CLI](../sequence-diff/README.md); `node sequence-diff/cli.mjs compare --help` |
| Add capture/delivery to an existing app | [Platform integration routes](../docs/integration/README.md) |

Run `npm start` from the contract repository. Open the collector's ordinary loopback URL. Reader credentials bootstrap automatically and stay separate from producer credentials.

The sidebar (**Logs and sessions**) is one explorer. **Devices and environments** → Apps → Sessions lists enrolled sources, including apps with no events; it stays listed while live viewing is paused or a file is open, with **Resume live** in its header. Clicking a source or session while paused resumes live with that selection. Browser environments are origin-scoped local IDs, not verified physical devices. Native labels use actual package/bundle identifiers. Last-seen means recent presence is unknown; it does not complete a session.

Session summaries are paged separately from capture events. Selecting a source or logical session uses its retained trace IDs as entry points and includes related server events at a fixed high-water mark. Selection, pause and collector changes fence old responses. Shared logical sessions preserve their identity across sources; source filtering restricts the seed client recordings; correlated server recordings remain visible. Very large selected sessions exceed the diagram limit and require capture export/smaller file inspection.

Rows show `{session name}` and a short 24-hour start time (`14:32`, `Tue 14:32`, `Oct 3`, `2025-10-03`); hover for the full name, file or session ID, ISO time and event count. The open log or session is marked `aria-current` with an accent bar. Source rows show the platform with ● (ready/delivering) or ◌ (last seen); status details are in the tooltip unless attention is needed.

Pause live stops viewer updates; collection continues. Importing a file pauses live viewing. Resume live returns to the collector. Save capture exports collector retention, rather than only the selected session. Static `npm run viewer` remains a local file viewer.

Build with `npm run build:viewer`; verify live bootstrap/reconnect/import/pause/resume through `npm run check:live-setup` with installed Google Chrome.

## Log folders and imported files

**This machine · {name}** (the collector's host name from `/api/v2/status`; **This computer** in the static viewer) lists folders you add. **+ Add folder…** uses the browser's read-only folder picker (desktop Chrome or Edge). Folder handles are remembered per viewer origin in IndexedDB (`network-log-lab-explorer`), up to 20; after reload a folder whose permission needs confirmation shows **Reconnect**. Expanding a folder lists its subfolders (A→Z) and `*.ndjson` logs newest first, reading at most 256 KiB per file for the first `session.started` name and time; dot-folders and `node_modules` are skipped, 500 entries per level and 5,000 scanned files are shown at most. Files over 16 MiB are listed as **Too large**; unreadable heads are marked. **Refresh** re-lists and **Remove** forgets the folder; files on disk are never changed. Without the picker, **Add folder (this visit only)** lists a one-time snapshot of a chosen directory; with neither, use **Import files**.

Clicking a log opens it through the same import pipeline and limits, goes straight to the workspace and pauses live viewing (a too-large file is rejected first, so live keeps running). A multi-session log lists its sessions under the row once open. **Imported files** lists the latest import: single-session files as rows, multi-session files as expandable nodes. Recording periods for a multi-recording session are in a collapsed node at the bottom.

Verify with `npm run check:log-explorer` (installed Chrome; stubs the picker with an origin-private directory).

## HTTP request files

Open a session and choose **HTTP requests** for a compact, read-only HTTP transcript. Each exchange shows the request verb and full URL, captured headers and body, followed by the response status, headers and body. A blank line separates headers from a body, and `###` separates exchanges. Recorded HTTP versions appear on the request and response lines when unambiguous; unavailable versions and transport details are omitted. JSON is indented without changing literal numbers, duplicate keys or string values. Binary bodies are shown as Base64. Missing, partial, redacted or truncated data gets a short marker. Response-only observations retain the response without inventing a request.

Multiple sources open as separate `### Source:` sections. **Request source** can narrow the transcript to one source or return to **All sources**. App and SDK traffic on the same confirmed client share a source; separate backends and devices retain their own sections. Captures without enough identity retain separate recording groups. A single source needs no heading. Each source preserves recording order and each recording's local request order; independent clocks do not establish a global timeline.

Sequence search and filters do not limit the transcript. Unchanged live updates preserve source selection and scroll. Switching views or entering and exiting comparison preserves the request source; another session, import or collector resets selection. **Download .http** and **Download .rest** save the exact displayed UTF-8 transcript. These are recorded conversations, including responses, rather than executable request scripts. Exceptional content that resembles client directives is escaped or commented without losing its captured value. The viewer never executes requests. Full capture metadata remains available in the exchange inspector and original NDJSON; it is omitted from this transcript.

Run `npm run check:http-export` with installed Chrome for source selection, filter independence, matching downloads, live polling and narrow-screen keyboard verification.

## Base64 request previews

The **Request** inspector adds a compact **Base64 · Decode** control only for detected query parameter or non-redacted header values, including Basic authorization values. Request bodies use one toggle for the whole encoded payload, nested JSON string values, or URL-encoded form values; repeated parameter names and their order are retained. Paired comparison **Request** panels offer the same preview for each side. **Encoded** returns to the recorded presentation. Decoded content is inert text, and body Copy always copies recorded content.

Detection accepts canonical standard Base64 and Base64URL with optional padding, then requires readable UTF-8. It is deliberately conservative: ambiguous short unpadded strings, ordinary words/IDs, invalid encodings and binary data stay unchanged. Explicit capture `content.encoding: base64` can preview readable text without inference. Redacted, truncated or partial bodies are not decoded. Large inputs and deeply nested structures are bounded. Each toggle decodes one layer.

Previews never modify captured events, URLs, matching rules, findings or downloads. **Raw events**, comparison **Evidence**, **Save capture**, and the literal **HTTP requests** file retain recorded values. Verify with `npm run check:base64` using installed Chrome.

## Related server logs

**Refresh related logs** starts a bounded collector job across its configured source adapters for the selected session's trace IDs. The same control becomes **Cancel refresh** while running. The compact status shows queued/collecting, updated, no new logs, no configured sources, partial logs, cancellation or failure. Hover the status for per-source diagnostics. Partial logs include sampling, truncation or parse errors; completed lookup does not prove every downstream call was recorded. Configure adapters and server logging before executing the request; refreshing retrieves retained observations.

Server services have their own lanes. Remote parent arrows connect matching trace and parent span IDs across recordings and sessions. Recording blocks retain each producer's sequence; the arrows establish causality, not exact timing between independent clocks. Attribution shows the original session and recording, and raw-event pointers preserve provenance. Correlated application messages appear in the inspector's **Logs** tab. Uncorrelated parsed messages remain standalone observations.

Unchanged collector notifications and identical refresh results retain the existing diagram, selection, inspector tab and scroll. Follow newest session follows the selected client entry point, rather than switching to a newly collected server session. Imported multi-source files resolve the same graph locally; they never trigger collector jobs. Run `node scripts/check-viewer-distributed.mjs` with installed Chrome for real collection, cross-service linkage and unchanged-update UI verification.

## Compare two sessions

Open a session and choose **Compare with…**, then select exactly one secondary session or import more canonical schema-1.3 NDJSON files. The picker identifies sessions by namespace and ID and shows recorded producer/source context. Its retained collector catalog includes other devices and sources, even when the primary navigator is source-filtered.

Comparison freezes canonical snapshots and runs the standalone `sequence-diff` engine in a browser worker. File input with invalid/skipped records cannot become a completed comparison. Limits fail explicitly: 20,000 events, 5,000 nodes and 16 MiB per snapshot, with additional engine work/change limits described in [sequence-diff](../sequence-diff/README.md). A collector primary preserves an explicitly selected source scope; an unfiltered primary and retained secondary read all retained sources for their session. Presentation filters do not change this input scope or engine profile.

**Aligned sequences**, **Change outline**, and **Order connections** share the selected pair, inspector tab, filters and expansion state. Aligned lifelines retain local invocation/handler nesting and explicit gaps/move references. Outline counts are unique affected nodes per dimension; content, outcome, capture and order can overlap. Connections preserve each side's order and label confirmed reorder, changed concurrency and observed-order-only differences separately. Crossings do not establish causality across independent recordings.

Inspect **Changes, Request, Response, Context, Evidence** for both recorded values, execution outcomes, uncertainty and original event pointers. Unknown-only findings have a dedicated filter and navigation button. **Resolve match…** previews valid candidates and applies a one-to-one explicit engine profile match within paired ancestry. Pair ancestors/recordings first when names differ between platforms. Names are preserved exactly; there is no hidden method normalization. **Comparison rules** controls JSON projection, durations, exclusions and existing explicit matches.

New collector events offer **Recompute snapshots** while the cited result stays fixed. Failure or cancellation retains the last valid result. A collector reset is reported and old snapshots remain exportable; use Exit comparison to select a new primary if its source/session is no longer retained. **Pause comparison reads** pauses update checks; collection continues. Exit restores the previous single-session navigation and follow setting, then incorporates pending collector data.

**Export JSON** downloads the schema-defined diff. **Export snapshots** separately downloads the exact primary/secondary canonical documents for replay. Follow the [CLI replay recipe](../sequence-diff/README.md#replay-a-viewer-export) to extract both documents and the exported `diff.profile`; passing that profile with `--options` preserves explicit matches and rules. The viewer imports canonical NDJSON captures; extract the combined snapshot export into canonical session JSON for CLI input. **Copy finding** includes engine/profile, scope, matching basis, differences, uncertainty, snapshot boundaries and verified source references.

Keyboard: Up/Down or j/k select visible pairs; Enter opens details; brackets navigate differences; Escape closes details or dialogs. Shortcuts leave text input alone and do not navigate an inert comparison behind an inspector overlay. Layout and inspector tabs support arrow keys. On narrow screens, **Controls and counts** exposes filters/rules/export, diagrams pan intentionally, and paired details use an overlay. Reduced motion uses static strong match outlines.

Run `npm run check:comparison` with installed Chrome for production-viewer and actual collector acceptance. [Verification](../docs/design/SESSION-COMPARISON-VERIFICATION.md) records scenarios and concrete limits.
