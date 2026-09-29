# Browser SDK design and implementation plan

Status: reviewed by independent capture/network and delivery reviewers, implemented and verified. See [review and evidence](REVIEW.md). This document preserves the design decisions agreed before implementation.

## Options and decisions

- Browser extension/CDP interception can see more wire metadata, but requires installation and is not an embeddable frontend SDK. Service workers alter scope/lifecycle and cannot observe every existing request. Global Fetch/XHR monkeypatches compete with customer instrumentation. Use explicit adapters and a manual API instead.
- Use the existing NDJSON contract and viewer. Add draft 1.2 for a web producer and explicitly awaited handlers; retain strict 1.0/1.1 readers. A Promise settlement is distinct from synchronous function return. No implicit async context, thread blocking, or suspension/resumption inference.
- Fetch headers are a completion milestone, not body EOF. Avoid clone/tee and background drains. The app chooses body reader helpers or reports manual observations; unobserved completion stays unknown. XHR listeners observe existing configured requests without replacing application callbacks.
- Use a bounded, sanitized canonical journal. Memory-only export works without browser storage permission; optional IndexedDB persists committed events across reloads. No claim that unload writes finish or browser storage cannot be evicted. Keep whole events; overflow/failure is visible.
- Export NDJSON for offline use. A same-origin development relay holds collector credentials on the desktop and forwards bounded uploads. Do not weaken collector CORS, expose pairing credentials in a frontend bundle, or bypass TLS. Full stable-ID replay on explicit delivery is acceptable for the small development sessions; no durable cursor is needed when canonical records are retained and the collector deduplicates.
- Build-time production alias selects a separate no-op entry. No runtime flag as the removal mechanism. Verify a positive debug build and scan shipping chunks/maps/dependency graph for recorder, persistence, relay and export code.

## Capture scope

Methods, sanitized URL/query/headers/payload snapshots, start/end wall and monotonic observations, origins, call sites, session identity, explicit operations and SDK/app handler boundaries. All browser-restricted facts are marked partial/unavailable. No status 0 recorded as an HTTP status; no fabricated DNS/TLS/redirect/retry/wire-header detail. Native business requests preserve headers, credentials, retries and abort semantics; trace propagation remains disabled.

Manual APIs cover arbitrary customer transports. Bodies default to bounded complete JSON redaction, otherwise withheld with a reason. Error messages and stacks are withheld by default. Metadata labels are developer supplied and must not contain secrets. Browser `performance.now()` durations have privacy-reduced precision and may pause during system sleep on some engines; nanosecond strings express units, not precision.

## Implementation and evidence

1. Review this design with capture/network and storage/transport reviewers; record decisions in REVIEW.md.
2. Implement core/manual/no-op APIs, types, adapters, storage, relay and export.
3. Extend schema/viewer without changing existing native recordings.
4. Add a runnable frontend with a small auth-shaped SDK, asynchronous app handler, Fetch and XHR/manual requests across independently served origins. Include expected HTTP failure/recovery and a no-service-account path.
5. Test contract conformance, redaction, failure isolation, no-op laziness, body/handler/cancellation boundaries, storage reload, relay guards and ACK verification. Exercise in a real browser and retain sanitized captures.
6. Document source installation, local browser storage, export/connection, JSON authority, limitations and release checks in agent entry points.
7. Independent code review, fix findings, run checks, commit and push main.

## References

[Fetch Standard](https://fetch.spec.whatwg.org/) defines filtered/opaque responses, forbidden headers and body streams. [IndexedDB](https://www.w3.org/TR/IndexedDB/) defines transactional persistence and durability hints. [Chrome durability behavior](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed) explains why a transaction completion is not a universal filesystem guarantee. Browser clock limitations are tracked by [WebKit](https://bugs.webkit.org/show_bug.cgi?id=225610) and [Firefox](https://bugzilla.mozilla.org/show_bug.cgi?id=1709767).
