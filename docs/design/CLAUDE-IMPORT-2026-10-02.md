# Claude Design import — 2 October 2026

Source: [Network Log Lab deliverables review](https://claude.ai/design/p/09dc9ea8-677e-4967-b421-c9b890af09c0?file=Mockups.dc.html), downloaded with Share → Project HTML → Project archive through the owner's Chrome session after updating local `main` to remote revision `3004efd`.

The archive contains 22 source/reference files plus `.thumbnail`. All 22 files are retained byte-for-byte under [claude-export](claude-export/); only the thumbnail is omitted, consistent with the earlier import. [CLAUDE-EXPORT-MANIFEST.json](CLAUDE-EXPORT-MANIFEST.json) records each file's length and SHA-256, the source URL and the archive digest. The downloadable ZIP itself is not committed.

Archive SHA-256: `1bbfb9e1555333386b5d7c93d06545441944d1c38f6186a99bb6f15127c9e9f2`.

## What changed

- Updated `Mockups.dc.html` with six comparison frames, 2a–2f, covering selection, aligned sequences, paired details, outline, connections and match resolution.
- Updated `Network Log Lab.dc.html`, `NLL Sequence.dc.html` and `nll-data.js` with interactive comparison and additional synthetic sessions.
- Added `NLL Pair Inspector.dc.html`, `nll-compare-layout.js` and the prototype-only `nll-diff.js`.
- Added the prior `Network Log Lab v1.dc.html` prototype and two JSON comparison examples.
- Updated the export's `github.md` provenance note. This note describes Claude's project state; this repository import record describes the actual Git import.
- `Spec.dc.html`, the original inspector, support runtime, base layout and copied NDJSON fixtures are unchanged from the previous export.

The repository [UI specification](SESSION-COMPARISON-UI.md) and [comparison plan](SESSION-COMPARISON.md) now describe the current comparison designs. No application/runtime source or production diff behavior is changed by this import.

## Contract reconciliation

The prototype is useful design evidence, but it is not an interchangeable implementation of [sequence-diff](../../sequence-diff/README.md). In particular:

| Area | Exported prototype | Repository requirement |
| --- | --- | --- |
| Input and provenance | Reconstructed synthetic viewer sessions; generated namespaces and line-based event IDs; wrapper-like summary omits canonical events | Canonical event schema 1.2, validated session wrapper, true event identity and original pointers |
| Method matching | `normalizeMethod()` removes whitespace and transforms Swift-style colons | Current engine uses exact signatures or explicit pairing; any normalization needs an explicit, versioned policy and collision handling |
| Recording and order | Recording signature uses its trigger; reconstruction/order use prototype timestamps and positions | Parent/source-scoped matching and canonical per-recording ordering; never infer cross-recording causal order from independent clocks |
| Default profile | Ignores Date and X-Request-ID | Default engine profile has no ignored headers; exclusions must be visible and reproducible |
| Content projection | Prototype header grouping, plain JSON parsing and derived field paths | Preserve canonical ordered observations and raw evidence; retain the engine's conservative JSON projection and uncertainty rules |
| Engine identity | Emits the package name/version/algorithm even though implementation differs | Production uses the actual package and its output; schema conformance alone does not prove algorithm or evidence parity |
| Live events | Demonstrates a hard-coded three-event notification | Freeze genuine collector snapshots and recompute explicitly from changed inputs |
| Match highlighting | Amber pulse/static candidates; no reduced-motion rule | Add a static equivalent for reduced-motion preferences before production integration |

The two included comparison JSON files pass the repository's `validateDiff()` structural schema validation. This does **not** verify their source references, canonical input compatibility, regeneration parity or equivalence to the standalone algorithm. They are archived prototype examples, not regression baselines. The Claude discussion notes that these samples were exported before the method-normalization edit; preserve that provenance rather than silently regenerating the original files.

The historical `Spec.dc.html` still describes draft 1.1/legacy import behavior and marks some now-demonstrated capabilities as unimplemented. Current repository contracts and the new UI specification take precedence. Existing corrections in the [design index](README.md) still apply, including executor-based HTTP lanes and no fabricated returns for stopped observations.

## Verification scope

The project archive was checked for ZIP integrity and unsafe paths before extraction. Imported bytes are checked against the manifest, and the two comparison examples are checked against the current diff schema. JavaScript syntax, JSON/NDJSON syntax and local asset references are checked separately from production behavior. Live Claude Design frames were inspected as the retrieval source.

This import is not a claim of completed React viewer integration, production-engine parity, collector recomputation, responsive comparison acceptance or native-device regression execution. Those remain the [UI acceptance gates](SESSION-COMPARISON-UI.md#acceptance-gates-for-viewer-integration).
