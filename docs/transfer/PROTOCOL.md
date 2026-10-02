# Source-aware transfer protocol

Transfer version **2** is the sole supported transport. Capture events use schema **1.2**. Start with a new collector directory; earlier state and routes are unsupported and left untouched.

The collector runs an HTTP viewer on loopback and optionally a separate HTTPS upload listener. Producer credentials authorize only upload and own-source presence. Reader authority never enters producer configuration. The HTTPS listener does not serve the viewer or read APIs.

## Enrollment and identities

A trusted local adapter/tool issues a 256-bit enrollment ticket, bound to a principal and optional exact source metadata scope. Manual/physical native grants share the trusted `native-pairing` principal, so a fresh authorized grant for the same installation preserves its source after a lost response/recovery expiry. Local adapters and browser relays use their own scoped principals. Tickets expire after ten minutes, allow at most 128 new registration operations, and retain idempotent recovery for twenty minutes. The collector atomically persists enrollment use, a source, its scoped credential, and the recoverable result. Registration operation IDs must be persisted before requesting enrollment. Identical authenticated retries recover the same result; conflicting metadata and revoked sources fail. A native source identifies an installation; a browser source identifies its journal within the installation.

`POST /api/v2/register`, `Authorization: Bearer ENROLLMENT_TOKEN`, JSON at most 16 KiB:

```json
{"version":2,"registration_id":"persisted-operation-id","platform":"ios","environment_id":"installation-scoped-environment","environment_name":"Developer phone","app_id":"com.example.app.debug","installation_id":"random-private-id","journal_id":"process-journal-id","instance_id":"ephemeral-process-id"}
```

Web registration additionally requires the exact frontend `origin`. Names/IP addresses are labels, never source keys. Direct LAN metadata is asserted by the enrolled principal; ADB/simulator adapters bind a descriptor to the tool-selected device/container. A registration response includes `version`, `collector_id`, `source_id`, `source_token`, and `endpoint`. Native sources may use one installation credential across process journals; delivery cursors still bind to the individual journal. Web credentials remain exclusively in the Node relay.

Pairing JSON is private, development-only state:

```json
{"version":2,"collector_id":"collector-id","endpoint":"https://developer-host.local:4320","source_id":"source-id","source_token":"secret","certificate_sha256":"lowercase-SHA256-of-DER-certificate"}
```

Before registration, the same document may supply `enrollment_token` instead of `source_id`/`source_token`. Pinning a private self-signed certificate requires service-name and certificate-validity checks as well as its exact DER fingerprint. Redirects are forbidden. Discovery supplies candidates; it cannot establish a trusted pin or grant enrollment. Explicit source revocation is immediate; rotation keeps the same source ID and permits a bounded sixty-second old-token overlap.

Development TLS certificates must include a SAN matching the endpoint hostname/IP and `extendedKeyUsage=serverAuth`. The executed RSA test fixture also uses `keyUsage=digitalSignature,keyEncipherment`. A matching pin does not replace hostname, validity or server-purpose checks. Bind the listener to the address used by the client: simulator `localhost` may resolve to IPv6 `::1`. The simulator fixture records its exact certificate extensions and listener configuration with the test evidence.

## Upload and acknowledgment

`POST /api/v2/events`, `Authorization: Bearer SOURCE_TOKEN`, `Content-Type: application/x-ndjson`: complete UTF-8 NDJSON lines, at most 1 MiB and 500 events. A batch is validated atomically. The first accepted event binds a recording to the authenticated source. Stable event IDs deduplicate identical replay, while changed IDs, recording sequences, identities or source ownership fail with 409. Source metadata does not rewrite the original event JSON.

Success is returned only after the database transaction commits with WAL and synchronous FULL in the dedicated SQLite worker. The ACK echoes transfer version 2, collector/source identities, every submitted `acknowledged_event_ids`, accepted/duplicate counts, global `event_cursor` (`cursor` in the ACK), and touched recordings' highest contiguous sequence. Verify identities and all submitted IDs before advancing a journal cursor. A lost response may follow a successful commit: retain and replay the canonical records. An ACK never deletes capture history.

`POST /api/v2/presence` uses the source credential and a bounded JSON process instance/status. Accepted uploads refresh presence. Presence has no capture-event semantics and does not prove a session completed. Restart clears live presence; retained history stays visible.

Producer journaling uses one canonical journal, one serialized disk owner, bounded append admission and asynchronous flush barriers. Queued logging is not yet durable. Senders read only the synced prefix. Local adapters read the published `durable_bytes` boundary from `journals/JOURNAL/journal.json`; they advance the follower checkpoint in the same database commit as its events. The collector does not treat visible complete lines after process death as proof of durability.

## Viewer APIs

A script on the collector's ordinary viewer URL bootstraps using `GET /api/v2/bootstrap`, `X-Network-Log-Viewer: 1`, and same-origin Fetch metadata. It receives `{version:2,collector_id,token}`. Reader requests use that bearer token. Exact Host and Origin checks apply; no browser-to-collector CORS exception exists.

- `/api/v2/health`: public loopback service/runtime identity.
- `/api/v2/sources`: registered source metadata and environment/app projections.
- `/api/v2/sessions`: bounded logical-session summaries, optionally filtered by source.
- `/api/v2/events`: bounded lines, with `after`, `high_water`, `source_id`, `session_namespace`, `session_id` filters.
- `/api/v2/stream`: authenticated Fetch SSE; ready/changed hints carry `collector_id`, `event_cursor`, `registry_revision`.
- `/api/v2/download`: bounded keyset export pinned to immutable event high-water; each page releases its database read before socket backpressure.
- `/api/v2/status` and `/api/v2/pairing`: local diagnostics and explicit pairing candidates.

Subscribe before fetching a snapshot and reconcile buffered hints. Event pages return `next_after` even when filters produce no lines; `high_water` pins a finite catch-up. UI selection/pause/collector changes fence stale responses. Viewer pause leaves collection running.

## Discovery and relay boundaries

Default active manifest: `~/.http-sequence-logger/active.json`, owner-only directory and regular 0600 file, atomically published with collector/instance identity, endpoint, PID and bounded enrollment grant. It is server-side private configuration, never frontend assets. An explicit manifest override chooses another collector. A live owner cannot be silently displaced. Stale ownership is rechecked under an exclusive reclamation gate before repair; the database directory uses the same rule. Simultaneous restart cannot unlink a newly claimed owner. Interrupted reclamation is diagnosed; select a fresh manifest path or state directory instead of deleting ambiguous ownership files. Shutdown removes only its own publication.

Android opt-in descriptor: `no_backup/HTTPSequenceLogger/source.json`. Simulator opt-in descriptor: `Library/Application Support/HTTPSequenceLogger/source.json`. Both declare current version, actual app ID, installation ID and fixed `journal_directory: "journals"`. Each journal owns `capture.ndjson` and a published `journal.json`. The bounded version 2 `journal-budget.json` reservations identify retained generations. A missing reserved folder or capture pauses collection/reopen with a restore/export diagnostic; inventory is preserved. A descriptor initialized before any journal exists may have no budget file. The app owns explicit `pairing.json` in the descriptor root, including its registered installation credential. The collector exclusively owns automatic `pairing-local.json`; bootstrap uses it only when no explicit app selection exists. Local provisioning reuses a validated source credential and never overwrites app selection. Only authorized default-user Android debuggable apps and booted simulator containers are discovered automatically. Missing tools disable that adapter. Simulators are never booted to scan.

Android caches bounded package enumeration for 10 seconds, but probes descriptor presence on every scan in groups of at most 32 packages. Remote commands use the same numeric user as descriptor reads, create no files and return only candidate names. Every candidate then passes the ordinary bounded descriptor and path validation. There is no negative descriptor cache: an already installed app can initialize its descriptor between scans. Unexpected access errors remain candidates so the detailed read reports them.

The debug Node relay is always mounted even before a collector exists. It registers participating pages with no events and returns opaque relay-local handles. Handle scope binds configured app, exact frontend origin and journal; remote access additionally binds the authenticated frontend session. All registration/presence/upload routes require the same explicit authentication middleware boundary, exact Host/Origin and CSRF checks when reachable. Correct spoofed headers are not authentication. The browser contacts its own frontend origin; the relay adds collector credentials using uninstrumented Fetch. Relay targets are private configured collector endpoints, never arbitrary request parameters.

Optional Bonjour advertises `_nlog._tcp` service version/collector ID/hostname, never secrets. Enable with `--bonjour --lan HOST`. Native debug apps browse foregrounded and explicitly select/trust a candidate. Manual pairing handles blocked multicast or permission denial. iOS debug-only Bonjour/local-network descriptions and Android OS/target-SDK permission behavior require physical-device verification.

## Limits and failure behavior

The initial collector caps uploads at eight globally/two per source, store event jobs at 16 MiB aggregate/2 MiB per source, sources at 1,000, control JSON at 16 KiB and SSE viewers at 32. Fair source rotation and reserved bounded control capacity keep admission independent of SQLite work. Retryable overload returns 429/503 with bounded retry; storage capacity errors, including actual SQLite full/ENOSPC failures, use 507. Uncertain I/O failures remain 503 and never return a success ACK. Existing identical replay remains acknowledgeable at logical event capacity. DB/index/WAL budgets and a free-space reserve constrain physical storage; no automatic retention deletion occurs. Unsupported directories, unsafe files, permission errors and source failures are diagnosed instead of adopting or deleting state.

These limits and durability configuration are implementation constraints, not a claim that every device lifecycle, power-loss, performance or physical-browser acceptance gate has passed. See the implementation evidence record for executed checks and outstanding platform gates.
