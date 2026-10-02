# Production comparison implementation

## Integration plan

1. Freeze canonical file/retained collector snapshots and invoke the standalone engine in an owned browser worker. Fence cancellation, replacement, resets and late responses.
2. Integrate comparison entry, two-session identity picker, shared selection/filter/expansion state, swap/exit and genuine live-update recomputation.
3. Render aligned sequences, hierarchy outline and independent-order connections from the same engine result, preserving source order and uncertainties.
4. Integrate paired evidence inspection, explicit profile matching, rules, accessible keyboard/dialog behavior and schema-valid export.
5. Verify engine/CLI/worker/export parity, real browser and collector flows, responsive rendering, regressions and independent review. Resolve findings before committing and pushing.

## Acceptance matrix

| Requirement | Observable verification |
| --- | --- |
| Authoritative engine, immutable evidence | Module/CLI/worker equality; pointers resolve to exact event IDs; input immutability |
| File and retained live sessions | Select two identities; secondary reads do not switch active session; fixed high-water pages |
| Three shared layouts | Same finding/selection/tab across layouts; ordered lifelines, hierarchy counts and typed order relations |
| Filters and navigation | Ancestors retained; hidden counts; unknown-only; unchanged collapse; overview and difference navigation |
| Inspector and matching | Five tabs; absent/null distinction; evidence copy; one-to-one same-kind paired-ancestry profile recomputation |
| Live updates and failure | Append keeps cited result stable; explicit recompute; failure keeps last valid diff; reset/reconnect fenced |
| Async lifecycle | Cancellation/replacement/late responses cannot publish obsolete diffs; worker cleanup |
| Responsive and accessible | Inspect 1440/1024/390px; keyboard text-input isolation, focus restoration, reduced motion |
| Export and regression | Diff schema + reference integrity; npm test/build; viewer/live/SVG browser regressions |
| Review and delivery | Separate author/reviewer; actionable fixes reviewed; verified remote main commit |

Implementation and independent review are complete. The [verification record](SESSION-COMPARISON-VERIFICATION.md) maps this matrix to reproducible checks and distinguishes canonical platform fixture coverage from actual native device execution. The [viewer guide](../../viewer/README.md#compare-two-sessions) documents the delivered controls and limits.
