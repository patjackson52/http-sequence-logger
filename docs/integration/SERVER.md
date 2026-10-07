# Server capture and distributed traces

Use the pinned `server-sdk/` source package for development Node servers and Cloudflare Workers. Its runtime-independent API keeps request context explicit, so concurrent requests do not share a current span. Browser/mobile clients remain the entry point; collector lookup finds server records by trace identity across independent sessions and recordings.

## Instrument an existing server

Create a logger with the service name, environment, application namespace/version and an application-owned `emit` callback. The callback receives a canonical JSON event and can send it through the existing structured application logger. A separate HTTP Sequence Logger file is optional; local development can tee existing structured logs into a bounded NDJSON journal.

Wrap the actual incoming request with `logger.handleRequest(request, async context => response)`. Call `await logger.flush()` when the application emitter returns persistence promises; handler settlement itself does not establish durable emission. On Workers, attach that flush or the app-owned request buffer flush to `executionContext.waitUntil`. Pass `context` to the application work that needs tracing. Use `context.fetch(url, init)` for outgoing calls and `context.operation(name, callback)` for internal work. `context.log(message, level)` associates a message with the current operation. See the exact options and signatures in [server SDK source](../../server-sdk/index.mjs) and its tests; preserve existing response handling and error behavior.

An incoming valid W3C `traceparent` seeds the trace and remote parent. The server creates its own span. Every outgoing call creates another span and propagates its identity only to configured `propagationOrigins`. Downstream servers create their own incoming spans. URLs and timestamps alone do not prove parentage. Malformed/untrusted context must not silently overwrite an active operation.

```text
Browser client span -> A incoming server span
                      -> A outgoing client span -> B incoming server span
                      -> A outgoing client span -> C incoming server span
```

Browser debug capture must explicitly enable allowlisted propagation and the server's CORS policy must allow `traceparent`. Check [browser integration](WEB.md) for the callable option. Mobile/custom clients can propagate the same standard header from their outgoing span. Do not propagate collector upload requests.

## Delivery and collection

Emit structured records into the application's ordinary logging pipeline. Retrieval adapters and parsers are separate: a local adapter reads retained records, while a Cloudflare adapter queries an application-provided authenticated retained-log endpoint. Canonical parsers extract event JSON from provider envelopes; mappings/custom parsers can normalize existing logs. See [adapter integration](ADAPTERS.md).

For Cloudflare, ordinary console output is useful alongside an opt-in development log store. The adapter here uses a retained application endpoint; it does not promise access to arbitrary Workers console history. The host owns retention, sampling, storage permissions and a dedicated collection credential. Await persistence or attach it to `executionContext.waitUntil` as appropriate for the actual handler lifetime. Bound records, queries and retention; do not expose retained logs through normal customer endpoints.

Configure sources on the local collector, then select a client capture and use **Refresh related logs**. Server recordings retain their own session namespace/ID and source metadata. Related events appear by trace ID; repeated collection deduplicates original event IDs. Collection status describes the query, not proof that every service emitted every record. A later refresh can retrieve retained records, but cannot recover work never recorded.

## Verification and fidelity

Exercise actual browser -> server -> downstream requests in both local and deployed environments. Validate exported canonical events and inspect remote links in the viewer. Run concurrent requests and verify separate trace contexts; refresh repeatedly to verify replay identity and stable UI. Cancel a bounded query and inspect unavailable/truncated/parser failure outcomes.

Log only facts observed by the server. Preserve missing ends and unavailable bodies/timing. Independent recordings have independent monotonic clocks; compare local durations and causal links, not one artificial shared stopwatch. Application log messages attach to spans and do not become invented HTTP transactions. Configure redaction and retention at the producer before logs leave the application.

Propagation allowlists authorize the initial destination. Automatic redirects can forward ordinary custom headers outside instrumentation visibility; the host owns redirect/header-forwarding policy for allowed endpoints. The logger preserves existing HTTP behavior and does not fabricate per-hop observations.
