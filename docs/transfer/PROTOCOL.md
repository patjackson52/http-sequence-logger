# Development capture transfer v1

Capture event schemas `1.0`, `1.1` and `1.2` travel unchanged under transfer version `1`. Browser producers use capture `1.2`; native producers retain their existing versions. Transport frames never become capture events. All records must have passed the producer's capture/redaction policy before entering a transfer sink.

## Connection configuration

A collector produces a pasted JSON connection string (not a URL query token):

```json
{"version":1,"endpoint":"http://127.0.0.1:4319","token":"opaque-random-write-token","collector_id":"opaque-collector-id","certificate_sha256":null}
```

`endpoint` is an origin with no credentials, query, fragment, or path except `/`. HTTP is accepted only for loopback hostnames/IPs. Other destinations require HTTPS. `certificate_sha256`, when supplied, is the lowercase SHA-256 hex digest of the complete DER leaf certificate. Matching the pin establishes the explicitly paired trust anchor, but certificate validity and endpoint hostname still must be verified. Never install a global trust override. Redirects are never followed. The token is supplied only in the Authorization header to this origin. It must not appear in capture events, diagnostic messages, URL parameters, or logs.

Android desktop tooling can save this JSON in the debuggable app's `files/network-log/connection.json` and install `adb reverse tcp:4319 tcp:4319`. The app's development factory reads it. iOS consumers accept the same pasted JSON or a connection file in their own debug configuration. Network setup does not automatically instrument arbitrary HTTP clients.

## Upload

`POST /api/v1/events`, with `Authorization: Bearer <token>` and `Content-Type: application/x-ndjson`. The UTF-8 body contains complete JSON event lines and ends with newline. Max body: 1 MiB; max 500 events. A single event must fit the body limit. Small batches should flush within 250 ms. Producers persist to a bounded local NDJSON spool before asynchronous delivery; they retain unacknowledged data across connection failures and process restarts. The network sender must be excluded from the capture pipeline.

A successful response is HTTP 200 with JSON:

```json
{"version":1,"collector_id":"opaque-collector-id","accepted":2,"duplicates":0,"acknowledged_event_ids":["event-1","event-2"],"cursor":2,"recordings":[{"recording_id":"recording-1","highest_contiguous_sequence":2}]}
```

The collector acknowledges only after appending and fsyncing new records. A client advances its durable spool cursor only if `collector_id` matches its paired configuration and every submitted event ID is acknowledged. Cursor state is scoped to that collector and spool prefix; another collector or a replaced/truncated file must replay from the beginning. Event IDs and timestamps must never be regenerated on retry.

Identical duplicate IDs (ignoring JSON key order) are accepted without duplicate storage. Conflicting event IDs or recording sequence identities fail atomically with HTTP 409. Schema-invalid or malformed batches fail atomically with 400; auth failures use 401; oversized batches use 413; full collector storage uses 507. Failures never acknowledge a prefix. Semantic capture diagnostics remain available to the viewer; incomplete running lifecycles are not rejected. Bounded backoff handles transient failures; permanent 4xx errors remain visible to diagnostics and retain the spool for export.

## Collector and viewer

The collector's loopback HTTP listener serves the built viewer. Its separate browser token allows read access, export, and viewing connection configuration; the device token only permits upload. The CLI prints a viewer link with the browser token in the URL fragment, which the viewer removes and keeps only in session memory. Requests use Authorization headers. An optional HTTPS LAN listener permits authenticated device ingestion only, never unauthenticated capture browsing. Host and Origin checks protect the loopback HTTP listener; no permissive CORS headers are sent.

`GET /api/v1/health` identifies a collector on the loopback listener, without secrets; it is unavailable on the upload-only LAN listener. Browser-authenticated loopback routes:

- `GET /api/v1/events?after=<cursor>` returns `{collector_id,cursor,lines:[string],has_more}` in bounded pages. Cursors are collector-global journal positions, not source timestamps.
- `GET /api/v1/stream` sends SSE `ready`/`changed` notifications with `{collector_id,cursor}` and heartbeat comments. Reconnect and read events after the browser's last cursor. Snapshot/event download closes the subscribe/fetch race.
- `GET /api/v1/download` exports the persisted NDJSON.
- `GET /api/v1/pairing` returns loopback and available LAN connection configurations for explicit pairing.

A browser disconnect is transport state, not a synthetic HTTP failure or method return. Live records with no terminal event display 'completion not yet observed'; imported files retain the existing incomplete-capture wording. The viewer preserves selection, filters and scroll while adding events. HTTP-only and handler behavior remain unchanged.

## Browser SDK delivery through a development relay

The browser SDK is a producer distinct from the desktop viewer. Its canonical journal is bounded, origin-scoped IndexedDB (or explicitly selected memory storage); an NDJSON file is created by export. Browser delivery is an **explicit foreground upload**, not the native sender's timed spool flushing/backoff/cursor behavior.

The opt-in Node middleware `web-sdk/dev-relay.mjs` mounts on the frontend's loopback-bound development server. It reads the collector's private loopback pairing file at startup and accepts only a collector endpoint with `http:` and hostname `127.0.0.1`. No native LAN certificate-pinning route is implemented by this relay. The frontend origin is configured explicitly; Host must match, a supplied Origin must match, and uploads require that matching Origin. No permissive CORS response or arbitrary proxy target is supplied. The upload token stays in Node memory, never browser code, public configuration, capture events or URL parameters.

Default same-origin routes:

- `GET /__network_log/config` returns `{version:1,collector_id}` with no upload token.
- `POST /__network_log/events` accepts uncompressed `application/x-ndjson`, at most 1 MiB / 500 complete lines, and forwards to the fixed collector `/api/v1/events` with the device credential. At most two relay uploads are active at once. Collector redirects are rejected; responses/ACKs are capped at 2 MiB. Rejection or timeout preserves the browser journal.

`uploadJournal(journal)` awaits persistence, snapshots the retained NDJSON, and sends bounded batches using an uninstrumented Fetch call. It validates collector identity and acknowledgment of every submitted ID. It never deletes canonical data, advances a browser ACK cursor, or rewrites event identities. Repeated uploads replay retained records and the collector deduplicates them. Appends after the snapshot require another invocation. There is no automatic timer retry, background upload, WebSocket or continuous SDK stream; SSE remains the collector-to-viewer change notification mechanism.

Restart the development server after changing the pairing file. Host apps retain a manual file export when the collector or IndexedDB is unavailable and exclude the relay, recorder, storage and export controls from shipping frontend artifacts. [Browser integration](../integration/WEB.md) gives package entries, storage names, source installation and build-boundary examples.

## ADB file retrieval

The CLI's optional Android watcher reads NDJSON from the debuggable app's `files/captures/` using `run-as`, tracks file changes, and buffers incomplete UTF-8/NDJSON tails. File replacement or rotation resets the file offset, while collector event-ID deduplication prevents duplicate records. Only validated package/filename arguments reach adb; commands do not parse Logcat. This works with the existing file-only SDK and with the transfer sink, and gives a no-app-change migration path. Device disconnects are retried and are shown as retrieval diagnostics.

ACK bodies are bounded at **2 MiB** by both native senders, including chunked responses. A valid 1 MiB upload with many long or multibyte IDs can exceed 512 KiB in its ACK; do not use a smaller receiver limit. Oversized ACKs retain pending data and are rejected.
