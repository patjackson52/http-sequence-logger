# Session comparison UI specification

Design handoff, **2 October 2026**. Source: the refreshed [Claude Design mockup sheet](claude-export/Mockups.dc.html) and [interactive prototype](<claude-export/Network Log Lab.dc.html>). This document governs the production comparison implementation in `viewer/`. The [verification record](SESSION-COMPARISON-VERIFICATION.md) records the implemented acceptance gates and actual execution evidence.

The production data authority remains the [standalone module](../../sequence-diff/README.md) and [diff schema](../../sequence-diff/schema/diff.schema.json). Preserve the archived files as received. Resolve prototype/contract differences using the [import record](CLAUDE-IMPORT-2026-10-02.md), not by copying the prototype engine into production.

## Screen and source map

| Frame | Designed state | Implementation focus |
| --- | --- | --- |
| 2a | Secondary-session picker | Search; namespace/session ID; platform, SDK, build and recording context; explicit missing metadata |
| 2b | Aligned sequences, inspector closed | Paired sequence diagrams, overview, comparison gutter, one-sided gaps and unchanged-region collapse |
| 2c | Aligned sequences, inspector open | Changed request content, redaction uncertainty and paired field values |
| 2d | Change outline | Shared ancestry, original positions, independent change dimensions and parent aggregates |
| 2e | Order connections | Original orders, correspondence links, confirmed reorder and changed concurrency |
| 2f | Resolve match and live-update notice | Ambiguous repeated calls, candidate highlighting, one-sided subtrees, unknown body content and explicit recomputation |

The exported components are [NLL Sequence](<claude-export/NLL Sequence.dc.html>) and [NLL Pair Inspector](<claude-export/NLL Pair Inspector.dc.html>). The main prototype owns comparison state; [nll-compare-layout.js](claude-export/nll-compare-layout.js) supplies layout helpers. `Network Log Lab v1.dc.html` preserves the prior prototype. Existing single-session frames 1a–1o remain in the sheet. The six new comparison frames are desktop examples; they do not establish that the requested responsive and exceptional-state design coverage is complete.

## Entry, identity and shared state

Enter with **Compare with…** on the current session. The selected session becomes primary; the picker chooses secondary. Keep both session identities visible, with **Swap** and **Exit comparison**. Roles are neutral, not pass/fail expectations. Namespace and session ID identify a logical session; platform or source alone does not.

Show the comparison snapshot, included session/source scope, event counts, result and rules. Compute once from immutable inputs. Search, layout and visibility controls project that result without rematching. A genuine collector update offers recomputation without mutating the active result. The prototype's three-new-events notice is simulated; production must use actual snapshot boundaries and collector state.

Layout changes retain selected correspondence, inspector tab, filters and relevant expansion state. Recompute or swap may change pair IDs; reselect by surviving source-node identities, then report when no counterpart survives. Exit restores the single-session navigator and inspection context.

Shared controls include Aligned sequences / Change outline / Order connections; search; All / Changed / One-sided / Unresolved / Order filters; Collapse unchanged; previous/next difference; Comparison rules; and Export JSON. Retain ancestry and explain hidden counts. Add an explicit way to navigate unknown-only pairs: uncertainty must remain reachable even when no known difference exists.

The rules surface shows JSON projection, timing, ignored headers, ignored paths, explicit matches and included/excluded scope. Start with the standalone module's profile; the prototype's ignored Date and X-Request-ID headers are an illustrative profile, not new silent production defaults. Export the schema-defined diff separately from snapshot/UI metadata.

## Layout and visual grammar

Retain Source Sans 3 / Source Code Pro, compact controls, the 46px top bar and 236px navigator. In comparison, the prototype collapses the navigator on entry below 1700px, with manual restoration available. Comparison lanes are 124px wide and the middle gutter is 56px. The inspector starts at 420px; keep it inline only while at least 720px remains for the main comparison, otherwise use an overlay. Preserve resizability and keyboard access.

| Meaning | Design color | Additional cue |
| --- | --- | --- |
| Primary | #2f6db5, tint #e8f0fa | Primary label / P |
| Secondary | #c4651c, tint #fbeee3 | Secondary label / S |
| Changed fields | #a3357f, tint #f9e8f2 | Delta glyph and field count |
| Changed order | #4f4a8a, tint #ecebf6 | Order glyph and relationship text |
| Unknown / unresolved | #8a5a00, tint #fff3d6 | Distinct uncertainty or correspondence label |
| Ordinary selection | #1b6f8f, tint #e3f1f6 | Selected state and focus ring |
| Active match resolution | #c47a00 | Candidate outline and pulse/static treatment |

These indicators are separate from HTTP/local-call execution outcomes. A successful request may be secondary-only; an HTTP 200 may still end in a body-read failure. Use words, glyphs and line treatments in addition to color.

**Aligned sequences:** preserve the current actor/origin lifelines, nested activations and local invocation grammar. Both diagrams share a scroll container and paired row heights. Show empty counterparts explicitly. The overview locates top-level regions and divergence/reconvergence. Original order and move placeholders must remain intelligible; visual alignment is not elapsed time. The requirement to avoid hiding reorder behind alignment remains an acceptance gate against real engine output.

**Change outline:** one expandable hierarchy with primary/secondary positions, field changes, order relations, uncertainty and matching basis. Aggregate unique affected nodes within each dimension; do not add overlapping dimensions into a misleading total. Parent field equality does not imply equality of all descendants.

**Order connections:** preserve each side's order. Group related flows and dim unrelated connections on selection/focus. Confirmed reorder, changed concurrency and observed-order-only differences retain separate labels; crossings do not prove changed causality. One-sided and unresolved nodes are visibly different.

## Paired inspector and match resolution

The comparison inspector has **Changes, Request, Response, Context and Evidence** tabs. Changes shows field paths, both values, uncertainty reasons, sibling-order relations and profile exclusions, plus expandable unchanged context. Request/Response preserve capture state and raw evidence. Context explains ancestry and correspondence and locates the pair in another layout. Evidence exposes source events and **Copy finding**, including pair ID, matching basis, changes, uncertainties and source references.

Keep absent, null, empty string, zero and unobserved distinct. Redacted or truncated data is not evidence of equality. Never invent handler arguments, business return values or successful terminal completion.

While **Resolve match** is open, highlight the unresolved source node and the picked candidate in amber, distinct from teal inspection selection. The prototype uses a 1.1-second pulse; unpicked candidates receive static dashed amber outlines. Apply corresponding treatment in the sequence, outline and connections layouts. Production must honor reduced-motion preferences with a static strong outline and equivalent labels; the export has no reduced-motion override.

Candidate selection is a preview. Applying a match writes a one-to-one explicit profile entry and recomputes the standalone engine. Endpoints must have the same kind and paired ancestors. Explain conflicts and allow cancellation. Cross-platform naming normalization is a follow-up engine requirement, not a substitute for a validated explicit pairing in the current implementation.

## Acceptance gates for viewer integration

1. All three layouts show the same engine pairs, uncertainties and order relations; no layout performs independent matching. Counts distinguish all-node totals from HTTP request counts.
2. Swap, layout changes, filtering and inspector navigation preserve understandable context. Recompute explains any lost selection; late events do not silently alter a cited comparison.
3. Confirmed reorder, concurrency changes and observed-order-only differences are distinguishable without color. Independent recording clocks are never compared as one causal timeline.
4. Resolve match previews highlight the source/candidate in every layout; application uses the existing profile validation. Reduced motion disables pulsing without losing the distinction.
5. Equal-within-scope, differences-plus-uncertainty and inconclusive results have distinct states. Unknown-only pairs remain discoverable. Missing/partial observations are never presented as unchanged complete content.
6. Invalid input and engine limits fail explicitly. Computing/cancel, filtered-empty and failed-recompute states preserve the last valid result where applicable. Do not treat these states as verified merely because the normal prototype works.
7. At 1440px, 1024px and about 390px, both identities, layout access and paired details remain usable. Use deliberate panning/overlays instead of shrinking text. Complete responsive comparison frames before claiming full design coverage.
8. Keyboard behavior is mode-specific and documented: in comparison, Up/Down or j/k navigate pairs, Enter opens details, Escape closes details/rules, and brackets navigate differences. Existing single-session bracket expansion shortcuts must not conflict. Do not intercept these keys while typing in inputs; restore focus after dialogs.
9. JSON exports validate against the repository schema and reference the exact canonical snapshot inputs. Agent findings cite actual event IDs/pointers; synthetic prototype line IDs are not production evidence.

The archive is the visual reference. These gates and the existing standalone contract determine production behavior where the prototype differs or is incomplete.
