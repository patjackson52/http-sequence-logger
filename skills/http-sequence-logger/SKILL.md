---
name: http-sequence-logger
description: Integrate HTTP Sequence Logger client and server capture, collect related logs through local or Cloudflare adapters, and inspect distributed traces in the local viewer. Use for this logger's source integration, custom parsing, or collector diagnosis.
---

# HTTP Sequence Logger integration

Read the pinned checkout's `AGENTS.md` and choose its task route. Actual public APIs and tests are authoritative; design archives can contain unimplemented sketches. Pin source revisions and preserve host-specific patches when updating vendored copies.

For servers, read `docs/integration/SERVER.md`. For existing raw logs and custom collection, read `docs/integration/ADAPTERS.md` and `collector/README.md`. For client entry points, use the Android, iOS or web integration guide. Invoke desktop commands from the logger checkout, using its supported Node version.

Use W3C trace IDs to find related records and distinct span IDs to connect operations. Propagate only to configured first-party origins. Keep request contexts explicit across concurrent work; a global current span corrupts traces. Preserve original source/session/recording/event identities across collection and replay. Cross-recording monotonic timestamps do not share an origin.

Collection and parsing are separate. A retrieval adapter owns access, bounds, source identity and availability; a parser owns envelope extraction and normalized records. Plain messages with trace context attach as messages, never invented HTTP transactions. Keep original record references, stable event identities and parsing failures. Cloudflare's retained application endpoint is an application integration, not a claim of arbitrary native console-history access.

Keep credentials, raw captures and local source configuration private. The viewer requests configured collector jobs; it does not supply provider tokens or arbitrary file paths. Cancellation, limits, sampling and missing records must be visible.

Prove an integration using actual host requests, collector refresh and rendered remote links, plus concurrent requests and repeated collection. Validate the resulting capture and inspect its source provenance. Preserve selection and layout on unchanged polling. Test shipping build boundaries when enabling development browser capture. Follow host instructions for deployment and publication; this skill does not authorize either.
