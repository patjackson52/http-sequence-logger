# Session comparison verification

Verified 2 October 2026 with Node 24.13.0 and installed Google Chrome 154.0.8037.95. This record covers the production React viewer and the actual SQLite collector. The imported Claude design files are visual references; their prototype engine and simulated notifications are not production dependencies.

## Reproduce

Run from the repository root after `npm ci`, using the Node version prescribed in `AGENTS.md` and installed Chrome:

```sh
npm test
node --test test/comparison-*.test.mjs
npm run build:viewer
npm run check:comparison
npm run check:live-setup
npm run check:viewer-realtime
npm run check:svg-export
npm run check:web-browser
git diff --check
```

| Check | Observed result |
| --- | --- |
| Repository tests | 359 passed, no failures or skips |
| Focused comparison tests | 29 passed |
| Production viewer build | Passed; Vite reports the existing 500 kB chunk-warning threshold for the viewer and comparison worker |
| Production comparison browser acceptance | Passed, no page errors; 18 screenshots and source-validated exports |
| Automatic live setup | 17 Chrome checks passed |
| Viewer realtime | Passed; measured scenarios below the 1000 ms target |
| SVG export | 12 downloads passed, including standalone SVG and offline image embedding |
| Web browser capture | Passed; exercised browser capture, persistence, transfer, viewer and production no-op behavior |
| Patch whitespace | Passed |

The browser checks create local ignored artifacts. `artifacts/comparison/evidence.json` records scenario results, Chrome version and screenshot filenames. Exported `.diff.json` and `.snapshots.json` files accompany the screenshots. The comparison command builds and serves the production viewer, starts isolated non-activated collectors, and removes their private temporary databases afterward. It does not use a mock SSE notification.

The SVG regression now imports current schema-1.2 examples for its multi-session scenario; the historical schema-1.1 live sample was not a valid current input. The old capture remains unchanged.

## Acceptance evidence

| Area | Verified behavior |
| --- | --- |
| Canonical foundation | Deep-frozen detached snapshots; strict malformed-final-line rejection; module, CLI and worker equality; schema-valid output with exact event/recording references. Invalid input, limits and invalid profiles never return a partial diff. |
| Three layouts | Shared selected pair and Request inspector tab across aligned sequences, change outline and order connections. Layout tests verify source positions, reorder gaps, original per-side order, hierarchy, independent dimension counts and unique affected-node aggregates. |
| Findings and values | Five inspector tabs, independent outcome/status, evidence, unknowns and exclusions. Tests preserve absent, null, empty, zero, redacted, truncated and unavailable observations. Real browser Copy finding clipboard payloads resolve to the selected pair's original events. |
| Presentation state | Unknown-only, filtered-empty, unchanged collapse, difference/overview navigation, shared expansion and swap. Keyboard input remains ordinary text in search/reader controls. Dialog cancellation and exit restore focus; inspector selection survives layout changes. |
| Explicit matching and rules | Ambiguous repeated calls remain unresolved. One-to-one same-kind paired ancestry is enforced; cross-platform explicit pairs preserve original method names. Browser candidate previews show amber source/selected candidate and dashed alternatives, with pulsing in normal motion and static treatment under reduced motion. Apply recomputes the canonical engine profile; timing-rule changes retain explicit matches and reproduce exports. |
| Responsive rendering | Rendered and inspected at 1440, 1024 and 390 px in all three layouts. Deliberate inner panning keeps labels readable, fixed controls remain available, and paired details use overlays when the remaining layout width is too small. Screenshots include inspector-open and inspector-closed narrow states. |
| Async lifecycle | Unit tests fence replacement, abort, stale callback, reset and disposal. Browser acceptance delays the actual worker asset, cancels computation, releases the obsolete startup and verifies the last valid export remains unchanged. |
| Real retained collector | Source-limited primary and a secondary on another source, absent from the currently displayed capture. Independent unscoped catalog and snapshot reads preserve the active selection and pin page high-water boundaries. Tests also cover pagination, competing reads and reset cancellation. |
| Later events and failures | Append after snapshot produces a real relevant-events notice while export stays byte-equivalent as JSON. Failed event reads retain the valid comparison. Explicit recomputation acquires fresh snapshots and changes the result. Selection is restored by source identity when present. |
| Pause, follow and reset | Pause/resume comparison reads leaves collection active. Previous follow-newest setting survives exit. An actual collector shutdown/replacement/reconnect reports the changed collector identity, disables recomputation against that old boundary and keeps the frozen result exportable. |
| Interaction states | Equal within scope, different with uncertainty, inconclusive, unresolved, filtered-empty, computing/cancel, malformed input, oversized input and failed recomputation. A valid capture over 20000 events is rejected in Chrome without replacing the last comparison or publishing a partial snapshot. |

Existing standalone tests supply independent expected results for request queries/headers/JSON, outcomes, retries, one-sided subtrees, ordering/concurrency, independent recording clocks, incomplete and redacted capture, multiple namespaces/recordings, and profile projections. New comparison fixtures extend that coverage into the worker and UI; prototype exports are not expected-result baselines.

## Independent review

A reviewer who authored none of the implementation reviewed the snapshot/controller architecture early, then the integrated code, tests, rendered evidence and documentation. Actionable findings were fixed and reviewed again: retaining the source-limited live-primary scope; acquiring a secondary from the unscoped catalog; preserving imported-file identity; fencing collector reset/late reads; dialog and exit focus restoration; avoiding shortcut collisions and unintended root scrolling; correcting original sequence positions and ambiguous aggregate counts; and keeping paired metadata/evidence labels clear. The final review reported no remaining actionable findings.

All 22 archived design asset hashes were verified against `CLAUDE-EXPORT-MANIFEST.json`. The persisted event schema, standalone sequence/diff schemas and authoritative diff engine were unchanged; schema regeneration was not required.

## Coverage limits

Canonical committed captures from `samples/realtime/android-adb-emulator-5556-user-0.ndjson`, `samples/realtime/ios-simulator-8638be44-26c3-44a3-9815-901395ca8d84.ndjson` and `samples/web/browser-multi-session.ndjson` were compared through the module, worker and CLI with source-reference checks. This is fixture coverage of previous native execution. No new Android or iOS device run was performed, and no native SDK or transfer integration was changed. Web capture was exercised in actual installed Chrome.

Snapshots are bounded at 20000 events and 16 MiB per session; the engine also enforces its documented complexity limits. These are explicit failures, not truncated comparisons. Repeated indistinguishable calls require explicit pairs; no automatic Swift punctuation normalization, fuzzy matching or reparent matching is enabled. Unknown capture remains unknown, and observed-order crossings do not assert causality. Collector replacement requires exiting and selecting a current session for a new comparison; the old snapshots remain inspectable and exportable.
