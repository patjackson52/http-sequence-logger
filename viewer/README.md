# Local sequence viewer

Choose the route from the logger checkout after `npm ci` with Node 24.13.x:

| Task | Command / guide |
| --- | --- |
| Collect live app captures and open the viewer | `npm start` → `http://127.0.0.1:4319/`; [collector setup and help](../collector/README.md) |
| Inspect existing local NDJSON without a collector | `npm run viewer` → `http://127.0.0.1:4173/` |
| Compare captures in a terminal, agent or CI | [Standalone diff CLI](../sequence-diff/README.md); `node sequence-diff/cli.mjs compare --help` |
| Add capture/delivery to an existing app | [Platform integration routes](../docs/integration/README.md) |

Run `npm start` from the contract repository. Open the collector's ordinary loopback URL. Reader credentials bootstrap automatically and stay separate from producer credentials.

Devices and environments → Apps → Sessions lists enrolled sources, including apps with no events. Browser environments are origin-scoped local IDs, not verified physical devices. Native labels use actual package/bundle identifiers. Last-seen means recent presence is unknown; it does not complete a session.

Session summaries are paged separately from capture events. Selecting a source or logical session uses its retained trace IDs as entry points and includes related server events at a fixed high-water mark. Selection, pause and collector changes fence old responses. Shared logical sessions preserve their identity across sources; source filtering restricts the seed client recordings; correlated server recordings remain visible. Very large selected sessions exceed the diagram limit and require capture export/smaller file inspection.

Pause live stops viewer updates; collection continues. Importing a file pauses live viewing. Resume live returns to the collector. Save capture exports collector retention, rather than only the selected session. Static `npm run viewer` remains a local file viewer.

Build with `npm run build:viewer`; verify live bootstrap/reconnect/import/pause/resume through `npm run check:live-setup` with installed Google Chrome.

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
