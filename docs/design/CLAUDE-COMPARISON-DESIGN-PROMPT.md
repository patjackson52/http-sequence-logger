# Claude Design prompt: session comparison

Use the prompt below in the existing Network Log Lab Claude Design project. Attach current viewer screenshots or a recording, the source files below, and the comparison plan/contracts. A filesystem path or repository link alone does not give Claude access to uncommitted changes.

## Reference package

- Current UI: viewer/src/App.jsx, viewer/src/Sequence.jsx, viewer/src/Inspector.jsx, viewer/src/LiveConnection.jsx, viewer/src/style.css, viewer/src/sequence.css.
- Accepted plan: [SESSION-COMPARISON.md](SESSION-COMPARISON.md).
- Implemented behavior: [sequence-diff/README.md](../../sequence-diff/README.md).
- Interchange contracts: [sequence.schema.json](../../sequence-diff/schema/sequence.schema.json) and [diff.schema.json](../../sequence-diff/schema/diff.schema.json).
- Screenshot references: [desktop-retry.png](../screenshots/desktop-retry.png), [desktop-awaited-handler.png](../screenshots/desktop-awaited-handler.png), [desktop-multi-server.png](../screenshots/desktop-multi-server.png), [desktop-body-timeout.png](../screenshots/desktop-body-timeout.png). These show the visual language; some labels and capture versions are historical. Current source and contracts take precedence.
- Optional earlier comparison concept: session-comparison.html from the previous design exploration. It is an exploratory sketch, not the implemented viewer. All three layouts were accepted.

Copy the following brief into Claude Design:

---

Continue the existing **Network Log Lab** design project and complete polished, high-fidelity mockups and an interactive prototype for **comparing two captured sessions**. Build from the currently implemented UI in the supplied source and screenshots. Deliver a coherent extension of that product, ready for engineering handoff.

The user needs to understand what stayed the same and what changed between a **primary** session and a **secondary** session. Sessions contain sequences of operations, component calls, local handlers and HTTP exchanges, potentially across several recording periods and sources. The feature supports regression investigation by developers and AI agents, including captures from Android, iOS and web tests.

The three accepted layouts are **Aligned sequences**, **Change outline**, and **Order connections**. Complete all three as complementary views of one comparison. Aligned sequences is the default. This is a design/prototype deliverable; the standalone diff engine, CLI and JSON contracts already exist.

## 1. Start from the actual product

Inspect the provided UI before designing. Use the current source as authority for behavior and styling, the diff schema/README for comparison semantics, and the accepted plan for feature direction. Earlier design archives and screenshots may contain outdated details. Where references disagree, resolve against current implementation and state the assumption in handoff notes.

Preserve the recognizable shell and interaction patterns:

- Network Log Lab wordmark, compact top bar, Import and diagnostics controls, and local-processing identity.
- Left navigator. Live navigation is Devices and environments → Apps → Sessions; file imports have a session list.
- Session context, search, ownership/outcome/kind filters and server-origin chips.
- Sequence lifelines, expandable component lanes, nested operations and local handler calls, and existing request/outcome notation.
- Resizable detail inspector on wide screens; overlay/fullscreen detail behavior on narrower screens.
- Existing single-session Sequence and List views. Comparison is a mode users can enter and leave while preserving their original session state.

Use the existing light visual language: Source Sans 3 for UI and Source Code Pro for technical data; white panels, pale gray workspace, thin borders, restrained teal selection, compact controls and readable density. Source tokens include text #1b2430, muted #5b6673, border #e1e6eb, accent #1b6f8f and selection #e3f1f6. The current top bar is about 46px tall, navigator 236px wide and inspector initially 420px wide. Adapt these thoughtfully to fit two sequences; make panel sizing and collapse behavior explicit.

Finish the visual details: spacing, alignment, typography, truncation, tooltips, focus, selected/hover/disabled states, scrolling and inspector transitions. Retain the product's character instead of introducing a separate dashboard aesthetic.

## 2. Complete the comparison workflow

Design entry from an existing session using **Compare with…**, followed by a searchable secondary-session picker. Show enough recorded metadata to distinguish sessions: name, namespace/session ID, source/platform, recording context, and build information when available. Use realistic missing-metadata states.

Show primary and secondary identities throughout comparison, with **Swap** and **Exit comparison**. Primary/secondary are directional roles; neither automatically means correct, passing or defective. Session identity includes namespace and session ID. A logical session can span multiple sources.

Compare fixed snapshots. Display the capture scope and snapshot context. Distinguish whole-session scope from a source-limited snapshot and from presentation filters. If live events arrive, show **New events available → Recompute comparison**. Keep the current result stable until explicitly recomputed; explain how selection behaves after recomputation because pair IDs are specific to a comparison.

Provide a shared toolbar for layout selection, search/filtering, collapse unchanged regions, previous/next difference, comparison rules, and exporting the comparison JSON. Exported JSON is the existing schema-defined engine result. If snapshot or UI state is also exported, describe it separately in handoff notes rather than silently adding fields to the diff contract.

Persist pair selection, relevant expansion state, filters and inspector context when switching layouts. Filtering must retain understandable ancestry and original position labels, show hidden counts, and never silently rematch calls. Design the result summary so known differences and uncertainty can coexist.

## 3. Finish all three layouts

### A. Aligned sequences

Show primary on the left and secondary on the right. Build on the existing sequence diagrams, preserving actors, HTTP origins, component lanes, nested operations and local calls. Corresponding nodes align vertically; both sides allocate the larger required row height. Use a narrow comparison gutter for change markers and navigation.

Make matching regions easy to scan. Represent one-sided calls with explicit empty counterparts. For reordered calls, preserve original order with linked moved-from/to placeholders or another clearly explained mechanism. The layout must not sort away the very difference being investigated. Synchronize scrolling and paired expansion by correspondence, including when one side has additional content.

Include a compact overview of recordings and top-level flows/operations, with divergence and reconvergence visible. Collapse unchanged runs with counts and contextual neighbors. Vertical spacing represents sequence alignment, not elapsed time. Demonstrate enough width for real lifelines with the inspector both open and closed; allow navigator collapse or an appropriate detail overlay when needed.

### B. Change outline

Show one shared hierarchy of recording → operation → handler/call, preserving the actual parent relationships. Make long, mostly unchanged sessions easy to triage. Show which side is present and separate indicators for field changes, order changes and uncertainty.

Aggregate child changes into parents without implying that overlapping dimensions are mutually exclusive counts. Selecting a row opens the same paired inspector and can locate that pair in either other layout. Include collapsed, expanded, selected and filtered states.

### C. Order connections

Preserve each session's original order in separate columns and connect corresponding nodes across the center. Crossings expose order differences. One-sided and unresolved nodes have distinct labeled treatments.

Make this useful with realistic density: group by flow/operation, support expansion, and emphasize a selected connection while dimming unrelated connections. Pointer hover and keyboard focus must both reveal correspondence. Retain order numbers when filters hide nodes. Distinguish confirmed reorder, changed concurrency and observed start-order differences; crossing lines alone must not imply a changed causal dependency.

## 4. Design one paired inspector

Extend the current inspector's request, response, timing, attribution and raw-evidence patterns. Present the selected pair with clear primary/secondary columns, readable field paths and changed values. Show structural context and matching explanation alongside content, outcome and optional timing details. Adapt local-handler details to the data actually captured.

Support nested JSON field differences, raw bodies, repeated headers and query parameters. Preserve the distinction between an absent field, explicit null, empty string, zero and a field that could not be observed. Show missing, truncated, redacted and unavailable content as **unknown**, with the reason. Identical redaction markers do not establish equal original values.

Make it possible to inspect unchanged context, reveal source events, and copy a finding with the comparison's pair ID and source event pointers. This gives developers and agents traceable evidence. Keep technical IDs out of the main visual hierarchy until needed. A captured HTTP status and terminal outcome are separate: a response can have status 200 and later fail during body consumption. Handler arguments and business return values are not captured.

Design an advanced **Resolve match** interaction for ambiguous correspondence. Show candidates and the effect of an explicit match; require one-to-one pairs of the same kind under paired parents. Pair missing ancestors first. Applying an override recomputes the existing engine using its profile. Distinguish this planned viewer control from already implemented engine support.

## 5. Respect the diff contract

All layouts consume the same standardized, project-defined diff JSON. It is a comparison report, not an executable JSON Patch. Canonical events use schema 1.2; the session wrapper and diff document each use their own schema version 1.0.

Bind the prototype and handoff explanation to these real fields:

| Contract fields | UI responsibility |
| --- | --- |
| inputs, engine, profile, scope | Session identity, comparison provenance, applied rules and exclusions |
| pairs, parent_pair_id, primary/secondary references | Shared hierarchy, correspondence, original positions and source evidence |
| presence, matching | Both sides / primary only / secondary only / unresolved; matching basis and candidates |
| equivalence, changes, uncertainties, ignored_paths | Field equality, changed dimensions, unknown information and excluded fields |
| order_changes | Reorder, concurrency change and observed-order-only relationships |
| result, summary, diagnostics | Overall state, clearly labeled counts and actionable limitations |

Important design semantics:

- Correspondence and equality are independent. A matched call can have changed content and unknown fields at once. Equal fields can still participate in an order change.
- Overall results are equal, different or inconclusive. Use **Equal within comparison scope** where appropriate. A different result may also contain uncertainties.
- Counts include recording and operation nodes as well as calls. Label units explicitly; do not label all matched nodes “requests” or add overlapping counts into a misleading total.
- Exact matching means source identity or a unique exact key, not a percentage certainty that behavior is equivalent. Repeated indistinguishable calls can remain unresolved. Automatic fuzzy matching, endpoint aliases and reparent matching are not implemented.
- JSON field differences supplement preserved raw content. Ignoring a JSON field does not automatically ignore the raw-body difference. Avoid a misleading one-click “ignore noise” interaction that promises otherwise.
- Timing comparison is opt-in for completed durations. Independent recording clocks cannot be subtracted or used to establish global causal order.
- Existing exclusions include native metrics and uncaptured handler arguments/return values. Explain scope in a compact details surface, without overwhelming the workspace.

Keep diff status visually distinct from execution outcome. For example, a newly added successful call is both secondary-only and successful. Use icons, labels and shape/line treatments as well as color. Reserve strong emphasis for the current selection and actionable differences.

## 6. Use a coherent demonstration scenario

Use the same illustrative dataset across all layouts and inspector states. Label synthetic data in the deliverable notes. Include at least two meaningful top-level operations so this demonstrates session comparison across flows, not just a single request.

Suggested story:

- Both sessions initialize an SDK and fetch configuration and session information.
- Configuration/session calls reverse a confirmed, non-overlapping sibling order.
- The primary verification attempt succeeds. The corresponding secondary attempt fails with an expired-token response, then adds token refresh and a successful retry.
- Both eventually invoke the app's verified handler.
- Telemetry appears only in primary within a complete captured region.
- Both fetch a profile, but secondary's response body is unavailable, making that content comparison unknown.

Also provide a fixture/state with repeated indistinguishable calls that require an explicit match. Keep node counts, hierarchy, attempts, outcomes, details and order indicators internally consistent. Prefer a real generated diff from the supplied module when the environment can run it; otherwise use schema-conforming prototype fixtures and document their provenance. Do not present synthetic causal explanations as engine findings.

## 7. Cover the states needed to implement this

Include comparison selection, ready, computing/cancel, identical-within-scope, differences-plus-uncertainty, inconclusive, unresolved matching, one-sided subtree, filtered-empty, live snapshot out of date, and invalid/oversized input states. These can be interactive states or focused component frames rather than an excessive number of full screens.

Valid incomplete captures may produce uncertainties. Contradictory or over-limit inputs fail comparison explicitly; show the reason and a useful recovery path. Current per-side engine bounds are 20,000 events and 5,000 reconstructed nodes, with additional work/change limits documented in the README. Never display a silently truncated comparison as complete.

Demonstrate the desktop workspace around 1440px, a constrained desktop/tablet width around 1024px, and a narrow mobile layout around 390px. Preserve usable paired detail inspection and access to all three layouts. Use intentional panning, stacked detail cards or overlays where appropriate, with visible primary/secondary context. Do not merely scale the desktop down.

Specify keyboard focus order, layout switching, next/previous difference, expansion, inspector opening/closing and focus restoration. Provide readable contrast, visible focus, accessible control labels and non-color status cues. Address long URLs, large bodies, deep nesting and dense connection diagrams.

## 8. Deliver finished work

Produce:

1. A polished interactive prototype in this existing design project. Session selection, all three layouts, pair inspection, difference navigation, filtering, collapse, swap and a live-recompute state should be demonstrable.
2. A review sheet containing the comparison entry flow, all three desktop layouts, paired content details, ambiguity/unknown states and responsive adaptations. Include the diagram with the inspector open and closed.
3. Reusable component/state specifications for comparison headers, summary indicators, alignment gaps, move links, outline rows, connection lines, unknown/one-sided badges and paired field rows.
4. Concise engineering handoff notes covering layout measurements/tokens, scrolling, alignment, shared state, keyboard behavior, fixture provenance and mappings to the diff fields. Clearly distinguish existing behavior, proposed viewer UI and capabilities that require later engine work.

Complete all three layouts to the same fidelity. Use one consistent visual system and one consistent comparison throughout. Evaluate the final result by whether a developer can quickly locate the first divergence, follow a retry or reorder, inspect changed values, recognize uncertainty, and cite the underlying evidence without losing their place.
