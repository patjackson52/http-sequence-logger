# Session comparison plan

Accepted direction, 1 October 2026: retain all three visual representations and implement one standalone diff module and CLI before integrating viewer controls. The module compares canonical sequence data and emits one versioned JSON diff; layouts and AI summaries must not independently invent matching rules.

## Architecture and current implementation

```text
Canonical schema-1.2 NDJSON / events
  → single-session sequence JSON document (schema 1.0)
  → standalone diffSequences(primary, secondary, profile)
  → sequence diff JSON (schema 1.0)
      ├─ CLI JSON/text for people, agents and CI
      ├─ aligned sequences
      ├─ change outline
      └─ order connections
```

The persisted event contract remains unchanged. The session-document wrapper and pure reconstruction live in [sequence-diff](../../sequence-diff/README.md), which is packaged separately from the viewer/collector. JSON Schemas describe both document and diff. The CLI can normalize captures, select sessions, compare documents or captures, and produce JSON or human text.

Implemented first slice: strict input/semantic validation; recording and parent-scoped matching; distinct matched/one-sided/unresolved nodes; explicit manual correspondences; structural, content, outcome, capture and optional timing differences; conservative JSON field projections; source evidence; declared unknowns/exclusions; sibling reordering/concurrency; deterministic output and CLI exit codes.

The UI representations below are planned, not yet integrated into the viewer.

## Aligned sequences

Default detailed view. Primary left, secondary right. Corresponding calls share vertical positions; blank spaces account for one-sided calls. Components occupy consistent horizontal lanes across both sides. Preserve nested methods and handler ancestry.

A narrow center column identifies content changes, one-sided calls, moves and unknown comparisons. Preserve original order and use linked moved-from/to placeholders rather than sorting away a reorder. Align row heights using the larger of the paired content heights. Scroll and expand/collapse together by paired node identity, not by independent pixel offsets.

A compact flow/recording overview locates shared regions, divergence and reconvergence. Collapse unchanged stretches with counts and context; next/previous difference traverses structural, field and order changes. A paired inspector compares corresponding field paths and raw evidence. Vertical position denotes sequence alignment, not elapsed time.

## Change outline

Compact triage view. Represent corresponding recordings, operations, handlers and calls once in a shared tree. Parent nodes aggregate child changes without double-counting a node with multiple changed dimensions.

Selecting a node opens the same paired inspector. Display presence, content, outcome, order and uncertainty independently. This layout is particularly useful for long captures dominated by unchanged behavior and for navigating an agent's evidence-linked findings.

## Order connections

Preserve both sessions' original order in separate columns and connect matched nodes. Crossings expose reordering; lines without a counterpart terminate with an explicit one-sided/unknown state. Hover/focus or selection emphasizes the selected pair and dims unrelated connections.

Offer flow-level grouping and expansion to avoid dense line crossings. Retain original positions and labels when filters hide calls. Overlapping independent calls must not be described as changed causal dependencies merely because their observed starts swap.

## Shared interaction and AI contract

- Select exactly two sessions, including namespace and source/build metadata. Primary/secondary are neutral directional roles; allow swap.
- Freeze comparison inputs as snapshots. New live events should offer recomputation, not silently invalidate the active diff or an agent's citations.
- Keep pair selection, collapsed state, filters and inspector selection when changing layouts. Filter the same comparison output on both sides; show hidden counts.
- Separate correspondence from equality. Display unique-key/manual matching basis and unresolved candidates. A future pairing control writes an explicit profile and recomputes the same engine.
- Show unknown capture states distinctly from equal, changed and absent. Unobserved handler arguments/returns cannot be compared.
- Keep normalization/exclusion rules visible and reproducible. Raw evidence remains available.
- Expose the schema-defined diff to agents with session identities, engine/profile, source references, changes, matching basis and limitations. AI explanations cite concrete pairs/events and identify causal claims as hypotheses.
- Design keyboard navigation and narrow-screen paired detail views alongside desktop layouts.

## Delivery sequence

1. **Standalone foundation (implemented):** package, input/output schemas, pure engine, CLI, automated tests and usage documentation.
2. **Viewer data integration:** import or compute a diff in a worker, session selection, snapshot identities, comparison profile and shared selection/inspector state.
3. **All three representations:** aligned sequences, change outline and order connections share the exact same diff. No layout-specific matching.
4. **Refinement:** matching override controls, overview navigation, explicit endpoint/component aliases, safe noise profiles, semantic body comparison modes, exports and performance tuning driven by real captures.
5. **Acceptance:** validate the same underlying differences and uncertainties across every layout and the CLI/agent output.

V1 intentionally leaves repeated indistinguishable calls unresolved unless source identity or explicit pairing establishes correspondence. Changed component/endpoint signatures can appear as one-sided subtrees; automatic fuzzy/reparent matching is deferred. Native transaction metrics and uncaptured local-call values are excluded explicitly.

## Foundation verification

On 1 October 2026: all 321 repository tests passed, including 19 focused diff tests; the viewer production build passed. Schema generation reproduced identical files. An npm-packed module installed offline in an isolated temporary consumer; its ESM API and CLI both passed checks using current canonical fixtures. Comparing success and retry fixtures produced a valid diff with one additional HTTP attempt. Historical live fixtures using schema 1.1 remain unsupported, consistent with the current 1.2 contract. No comparison UI implementation or new native-device execution is claimed by these checks.

## Prior art

- [Beyond Compare](https://www.scootersoftware.com/v5help/viewtext.html): synchronized panes, difference overview, importance rules and paired details.
- [Jaeger trace comparison](https://medium.com/jaegertracing/trace-comparisons-arrive-in-jaeger-1-7-a97ad5e2d05d): grouped service/operation paths and presence/frequency differences.
- [jsondiffpatch array matching](https://github.com/benjamine/jsondiffpatch/blob/master/docs/arrays.md): identity-aware sequence comparison, move detection and nested changes.

These inform the visual/semantic design; the current engine does not depend on those implementations.
