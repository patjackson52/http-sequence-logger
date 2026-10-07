# Distributed sources implementation and acceptance plan

A client capture is the entry point to a distributed trace. Original source journals remain independent; collector snapshots expand trace identities into the selected view. Source, recording, event and session identities remain unchanged. W3C trace context supplies the graph: every operation owns a span, and an incoming server span has the outbound client span as its remote parent.

## Components and ownership

- Server SDK: explicit per-request contexts for Node and Cloudflare Workers, incoming/outgoing/internal spans and associated messages. JSON is emitted through the existing application logging callback; dedicated files are optional.
- Retrieval adapters: bounded local journal reads and authenticated retained Cloudflare application log queries. Collection transports never contain parsing assumptions or credentials supplied by the viewer.
- Parsers: canonical JSON inside provider envelopes, declarative mappings for existing JSON, and injectable custom parsers. Preserve source references and parsing diagnostics; never fabricate HTTP lifecycle or timing from a text message.
- Collector: configured source registry, trace-indexed cross-session queries, bounded deduplicated refresh jobs, terminal status and cancellation. Replay retains event IDs. Missing/sampled/unavailable logs remain explicit.
- Viewer: compact Refresh related logs/status control, incremental related-source rendering, causal links across recordings and unchanged-data stability. Independent monotonic clocks are not aligned as a shared clock.
- Unified auth sample: actual browser -> sample API -> downstream requests locally and on deployed Cloudflare. Local application JSON journal plus authenticated retained Cloudflare logs prove both adapters.

## Implementation gates

1. Agree callable SDK and collection APIs before wiring the host.
2. Exercise parser failures, source provenance, repeated collection, concurrency isolation, cancel/error/limit outcomes and trace ancestry.
3. Verify compact live viewer controls, unchanged refresh retaining selection/scroll/layout, and correct cross-source rendered relationships in Chrome.
4. Run existing applicable logger checks, sample test/build/release checks and real local/cloud app requests. Validate/export real canonical captures; synthetic fixtures alone do not prove host integration.
5. Independent review round one covers simplicity, correctness, concurrency and Cloudflare/browser expertise. Repair findings, rerun affected checks, then independently review round two against final changes.
6. Update maintained integration docs, callable API index, collector/viewer guidance, AGENTS and reusable integration skill. Bump package versions and pin the vendored host source without losing host patches.
7. Commit both repositories, merge logger changes to main and push configured remotes. Do not manufacture a sample remote or discard unrelated user files.

## Completion evidence

Each requirement needs concrete file/test/runtime evidence: remote links displayed; raw structured and custom parsing paths; local and deployed adapter collections; unchanged-poll UI; concurrent request IDs; documented APIs/credentials/storage bounds; two review rounds with repairs; version/pin consistency; committed main SHA and push result. Unknown or unavailable evidence remains unfinished.

Implementation and execution evidence are recorded in [verification](DISTRIBUTED-SOURCES-VERIFICATION.md). Related server collection is explicitly requested through the compact viewer control or shared job API; it does not permanently monitor provider logs.
