# Viewer design history

[Session comparison plan](SESSION-COMPARISON.md) retains all three accepted layouts: aligned sequences, change outline and order connections. The standalone module, CLI and JSON contracts are implemented first; viewer integration follows the shared diff contract.

[Claude Design comparison prompt](CLAUDE-COMPARISON-DESIGN-PROMPT.md) is the copy-ready brief for completing high-fidelity mockups from the current viewer, with an attachment checklist, all three layouts, shared inspector behavior and the implemented diff contract.

The files in `claude-export/` are the unmodified Project HTML archive exported through the owner's Chrome session on **2026-10-02** from [Network Log Lab deliverables review](https://claude.ai/design/p/09dc9ea8-677e-4967-b421-c9b890af09c0?file=Mockups.dc.html). This refresh replaces the 2026-09-28 export and includes all three comparison layouts, a paired inspector, match-resolution highlighting and example diffs. The archive's thumbnail is omitted. These are source design references, not application runtime dependencies. [The import record](CLAUDE-IMPORT-2026-10-02.md) documents provenance and compatibility limits; [the manifest](CLAUDE-EXPORT-MANIFEST.json) records the exact file hashes.

[Session comparison UI specification](SESSION-COMPARISON-UI.md) incorporates the current mockups and interactions into the repository plan. Start there for comparison implementation. The exported `Spec.dc.html` is unchanged from the earlier archive and still contains historical version/support claims; it is not the current comparison specification. The exported `nll-diff.js` is a prototype implementation and must not replace the standalone module.

The implemented viewer is `viewer/`. The repository contract wins where the design conflicts:

- Accept current `schema_version` 1.2 records; the design prototype's synthetic `v:1` format is not an interchange format.
- Use each recording's `sequence` for ordering, including equal timestamps. Never compare independent monotonic clocks.
- The successful live fixture has **8** HTTP exchanges, not the 9 quoted by Spec H-15. The recovery capture has 9.
- HTTP arrows follow the recorded **executor**. Attribution separately preserves the initiator. This correctly distinguishes an app-initiated request executed inside an SDK.
- Observation-stopped handlers have no return arrow and no confirmed execution duration. Their recorded observation interval remains available in Timing.
- Missing values and parser errors are not network failures. The viewer's importer uses the contract validator; invalid schema events (including HTTP status 0) are diagnosed and skipped rather than coerced into synthetic events.

Fonts are bundled locally in the implementation; imported logs never trigger a request to a recorded URL. The source archive can reference external design fonts, so use the production viewer for local capture analysis.

[Realtime discovery and durable collection implementation plan](REALTIME-MULTIPLATFORM-PLAN.md) proposes shared Android, iOS and browser source discovery, delivery, storage and viewer navigation with fresh state and one current contract. It incorporates independent network, mobile, security, concurrency/threading, disk access, developer experience and simplicity reviews; current evidence and remaining acceptance gates are tracked in [implementation verification](REALTIME-VERIFICATION.md).
