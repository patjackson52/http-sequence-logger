# Distributed sources review and verification

This change uses schema **1.3** and package/SDK **0.2.0**. Independent source journals are retained; client sessions query related trace recordings rather than rewriting server identities. Retained Cloudflare application logs are retrieved through an authenticated host endpoint, distinct from native Workers console history.

## Independent review rounds

Round one reviewed simplicity, correctness, concurrency and browser/Node/Cloudflare behavior. Findings were repaired with regressions: default Follow newest now filters server sessions before latest limits; standalone raw messages own unique selection IDs; trace-only records preserve association without a span; forwarded inbound headers cannot reuse the caller's outbound span. The unified-auth sample aligned its 64-trace query bound and reports retained-record overflow. A historical capture comparison test now explicitly rejects old schema evidence and tests current platform fixtures; old runtime recordings were not relabeled.

Round two is a fresh independent review of the repaired implementation and sample. It identified server capture metadata failures that could prevent actual HTTP or replace a successful response. The SDK repair isolates capture metadata from business fetch/response/error behavior and independently passed oversized request/response URL, hostile metadata coercion and throwing emitter regressions. The reviewer found no remaining blocking correctness issues. Both independent reviewers supplemented their review for Android/Swift wiring. Supplemental reviews checked Android allowlisted propagation, null production no-op, atomic session liveness and sample Swift request headers/schema; stale native contexts were repaired and covered by regression. Parsing failures now include up to five bounded source-reference/reason examples, while ordinary provider banners remain unmatched.

## Repository verification

Independent verification passed the complete Node suite (382 tests at that revision), viewer build, browser types, installed-Chrome live setup, comparison, SVG export, realtime, distributed refresh, browser release isolation and real browser capture flow. Distributed verification keeps default Follow newest enabled and confirms three remote links and exact SVG node/HTML, scroll, selected item and inspector tab across three identical refresh/replays. Realtime verification completed twenty trials, maximum 127 ms against its 1,000 ms gate.

Native schema-version changes passed Swift package tests, Android logger unit tests, iOS shipping isolation and Android debug/devDebug/release/unminified graph/APK/resource audits including the negative accidental-dependency probe. Android sample version metadata was bumped and the final audit rerun successfully.

The final complete Node suite passed **385 tests with zero skipped** after parser/inspector repairs, and installed-Chrome distributed verification was repeated successfully. Android API/logger propagation tests passed; the final shipping audit includes this API change.

Current local evidence is under ignored `artifacts/distributed-verification/`, `artifacts/viewer-distributed/`, `artifacts/distributed-native-release.log`, and the platform audit directories. These paths hold execution evidence, not committed provider credentials or private captures. Viewer changes after the independent suite have targeted inspector/model regressions and a repeated real-browser distributed check. Final changes require affected checks again.

## Host-runtime acceptance

The unified-auth sample's actual Chrome 154 flow passed locally and on deployed Cloudflare with Prove UAT authentication. Each environment captured four matching server HTTP spans (Prove token/unify and B/C calls), four causal links, unchanged SVG node/HTML under repeated refresh with default Follow newest enabled, and no browser errors. Its ignored `artifacts/distributed-logs/evidence.json` and screenshots retain runtime evidence. The sample also passed Android development/release builds and recorder exclusion checks, plus iOS Development/Production build and symbol/plist isolation. Physical native-device requests were not exercised; browser requests establish the local/deployed end-to-end path, while native header wiring has build/unit/isolation evidence.

The host integration note documents actual private source configuration, raw journal, retained-log endpoint, request-owned buffers, overflow status, storage retention and runnable tests. Its vendored source pin is updated to the final logger main commit with app-specific raw-capture patches preserved.
