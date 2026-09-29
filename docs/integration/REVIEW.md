# Agent integration review and verification

The onboarding plan was reviewed independently for Android and iOS before implementation. The integrating reviewer checked the collector, viewer, JSON contract and cross-platform workflow. The platform reviewers then checked the completed shared agent guides. The result uses a short root `AGENTS.md`, a capability/decision entry point, focused platform and transport guides, and compiled independent consumers.

## Review decisions incorporated

| Integration failure an agent could otherwise cause | Guidance / verification added |
| --- | --- |
| Assume published Maven artifacts or add the repository root as a remote Swift package | Pinned source checkout; tested Android `projectDir` imports and nested local `ios/` package |
| Use proposed Swift capture APIs as if they existed | Prominent implemented/app-owned/design-only table; explicit compatible-producer prerequisite and adapter obligations |
| Copy sample app modules or replace the customer's networking to obtain logging | Independent consumer projects; manual observation around a customer-owned client; sample-only behavior labeled |
| Include recorder/transfer in production through runtime gating | Debug/release injection, separate Swift package graphs, final dependency/binary checks and customer-archive acceptance |
| Lose captures by reopening a truncating sink or exporting a compacted spool | Unique Android capture paths; retained sink ownership; separate Swift canonical file; explicit resume and replay semantics |
| Use a wrong namespace/session, container path, endpoint, port or token | Source-verified identity rules, complete file map, device selection/retrieval commands, browser/device credential separation |
| Alter network/backup policy or expose secrets while making transfer work | Merge scoped development rules, app-specific redaction/backup exclusions, canonical export guidance and credential-free evidence |
| Treat a fixture test as proof that an unrelated app is integrated | Separate repository smoke checks from real customer-app capture, viewer, recovery and shipping-artifact acceptance |

## Executed checks

- `npm ci`, all **161 JavaScript tests**, and the production viewer build passed. The package engine now matches the viewer's minimum supported Node 22.12.
- `scripts/check-android-integration.sh` built a separate source consumer in Debug and minified Release; **seven test executions** passed (five Debug, two Release). Its synthetic handler/request NDJSON validated; Debug includes recorder classes and Release dependency/class checks exclude them. No original app or demo-auth module is imported. The fixture also tests business/no-op behavior and capture-failure isolation.
- `scripts/check-ios-integration.sh` compiled the actual Debug local-package consumer and tested its empty-spool lifecycle. A separate production package built, tested and ran with zero package dependencies and no transfer/adapter symbols. Accidental Release compilation of the development consumer failed as intended.
- Local Markdown file links were checked; `git diff --check` passed. Platform reviewers found no remaining blocking documentation issue after clarifying Swift replay and demo capture wording.

Reports and synthetic captures are under ignored `artifacts/android-integration/` and `artifacts/integration-ios/`. The root desktop verification logs are also in ignored `artifacts/`. These checks establish that the supplied source-consumption recipes compile and that the documented repository components work together at their tested boundaries.

They do **not** establish a customer's native integration: the Android consumer uses a controlled response, the Swift check runs on macOS without HTTP requests, and neither check substitutes for a customer's own iOS archive, real-device permissions, real app capture or viewer inspection. Follow the [customer acceptance checks](README.md#acceptance-evidence) before reporting an app integrated.
