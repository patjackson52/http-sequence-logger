repo: patjackson52/http-sequence-logger
branch: main

## Last sync
date: 2026-10-02T03:48:17Z

### Updated in this project
- Comparison mode (Compare with…, three layouts, paired inspector) added to Network Log Lab.dc.html per docs/design/SESSION-COMPARISON.md and docs/design/CLAUDE-COMPARISON-DESIGN-PROMPT.md
- nll-diff.js ports the conservative-tree-v1 matching rules and emits http-sequence-diff 1.0 shaped JSON (sequence-diff/README.md, schema/diff.schema.json)
- samples/comparison*.diff.json exported from the prototype engine
- Mockups.dc.html turn 2: comparison frames 2a–2f

## Sync history
- 2026-09-29T03:13:44Z — Spec §7–15 grounded in HANDLER-TRACING.md and CONTRACT.md; fixtures copied into samples/ and examples/

## Screen map
| Screen | Repo files |
| --- | --- |
| Network Log Lab.dc.html comparison mode | docs/design/SESSION-COMPARISON.md, sequence-diff/README.md, sequence-diff/schema/diff.schema.json |
| nll-diff.js | sequence-diff/README.md (matching and order rules), sequence-diff/schema/diff.schema.json |
| Spec.dc.html §7 information model | CONTRACT.md, HANDLER-TRACING.md |
| Spec.dc.html §10 (a) | samples/live/successful-sign-in.ndjson, android/demo-auth/src/main/kotlin/dev/networklog/demoauth/DemoAuthSdk.kt |
| Spec.dc.html §10 (b) | examples/handler-no-http.ndjson |
| Spec.dc.html §10 (c) | examples/handler-throw.ndjson |
| Spec.dc.html §10 (d) | examples/handler-stopped.ndjson, examples/handler-interrupted.ndjson, examples/handler-cancelled.ndjson |
| Spec.dc.html §15 acceptance criteria | examples/handler-*.ndjson |
