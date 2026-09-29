repo: patjackson52/http-sequence-logger
branch: main

## Last sync
date: 2026-09-29T03:13:44Z

### Updated in this project
- Spec §7–15 grounded in HANDLER-TRACING.md and CONTRACT.md (format 1.1)
- Sequence examples (a)–(d) now quote the repo fixtures and the live sign-in capture
- Fixture NDJSON files copied unchanged into samples/ and examples/

## Screen map
| Screen | Repo files |
| --- | --- |
| Spec.dc.html §7 information model | CONTRACT.md, HANDLER-TRACING.md |
| Spec.dc.html §10 (a) | samples/live/successful-sign-in.ndjson, android/demo-auth/src/main/kotlin/dev/networklog/demoauth/DemoAuthSdk.kt |
| Spec.dc.html §10 (b) | examples/handler-no-http.ndjson |
| Spec.dc.html §10 (c) | examples/handler-throw.ndjson |
| Spec.dc.html §10 (d) | examples/handler-stopped.ndjson, examples/handler-interrupted.ndjson, examples/handler-cancelled.ndjson |
| Spec.dc.html §15 acceptance criteria | examples/handler-*.ndjson |
