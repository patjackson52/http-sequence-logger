# Local collector and live viewer

From this checkout, use Node **24.13.x**, run `npm ci`, then `npm start`. This builds the production viewer, starts the collector and opens **http://127.0.0.1:4319/**. Keep the terminal running; Ctrl+C stops it. The ordinary URL bootstraps its reader credential automatically. The collector runs on the developer's machine; apps need their own capture hooks and debug bootstrap before discovery can find them.

| Task | Command from repository root |
| --- | --- |
| Start and open viewer | `npm start` |
| Start without opening browser | `npm run collector` |
| Collect an existing Android debug app | `npm run collector -- --android YOUR_DEBUG_APPLICATION_ID --device SERIAL --open` |
| Collect an installed app on a booted iOS simulator | `npm run collector -- --ios YOUR_BUNDLE_ID --simulator UDID --open` |
| Use only browser relay or explicitly paired uploads | `npm start -- --no-android --no-ios` |
| Diagnose the active collector | `npm run collector -- status` or `npm run collector -- doctor` |
| Inspect all options without starting services | `npm run collector -- --help` |
| Build/install/run the Android sample | `npm run android:live -- --device SERIAL` |
| Import files without collection | `npm run viewer` at `http://127.0.0.1:4173/` |

Default discovery covers authorized Android devices and installed participating apps on booted iOS simulators. The flags above narrow that discovery; use the actual debug application/bundle ID, including suffixes. Discovery does not install apps, instrument their HTTP clients, or boot simulators. Missing tools and permissions appear as adapter diagnostics. Browser SDK pages use an always-mounted same-origin Node relay; start the frontend and collector in either order. Read the relevant [app integration guide](../docs/integration/README.md) for setup.

## Storage, ownership and diagnostics

The default database is `artifacts/collector-v2/capture.sqlite`. `--dir PATH` resolves relative to this checkout, and `--port PORT` changes the default loopback HTTP port `4319`. The private active manifest defaults to `~/.http-sequence-logger/active.json`; `--manifest PATH` selects a different private manifest. The [transport file map](../docs/integration/TRANSPORT.md#where-every-file-lives) identifies native journals, IndexedDB, pairing and cursor files.

`status` reads the selected manifest and probes loopback health. `doctor` also checks ADB and Xcode availability. Both emit JSON and return `0` even when `live` is `false`; inspect `live`, `reason` and `next_action`. They do not build the viewer, repair pairing, delete captures or print credentials. Use `--manifest PATH` when diagnosing a non-default collector.

After updating this checkout, restart a long-running collector so its server code matches the newly built viewer. Rebuilding assets alone does not reload the server process. A stale process can still serve the page while rejecting current bootstrap/API requests, leaving the viewer reconnecting. Stop it gracefully and restart with the same supported directory/options; keep captures intact. Historical unsupported directories remain separate and are not migrated.

One directory has one collector owner. An existing active manifest cannot be silently taken over. For an isolated collector without device discovery, choose a distinct directory and port:

```sh
npm run collector -- --dir artifacts/collector-isolated --port 4321 --no-activate --no-android --no-ios
```

`--no-activate` leaves default relays attached to their active collector; producers/relays for this isolated instance require explicit configuration. Existing unsupported state is rejected without migration. Capture schema **1.3** and transfer/configuration **2** are separate versions. Keep database, manifests, pairing files, credentials and TLS keys private; share reviewed, sanitized NDJSON exported with **Save capture**.

## Device uploads, inspection and comparison

Android USB uses authorized ADB and automatic reverse/pairing. iOS simulators use private container discovery/pairing. For physical iOS or Wi-Fi upload, `--lan HOST` enables HTTPS for the supplied DNS name/IP on port `4320` (override with `--tls-port PORT`). **Pair another device** provides scoped enrollment JSON for the development app. Explicit trust, permissions and reachable networking are required; `--bonjour` advertises candidates only. Follow the [transport guide](../docs/integration/TRANSPORT.md) and [protocol](../docs/transfer/PROTOCOL.md).

The [viewer guide](../viewer/README.md) covers source/session navigation, pause, file import, SVG export and **Compare with…**. Pause affects viewer reads while ingestion continues. Comparison freezes two snapshots and offers explicit recomputation after relevant later events; source scope and presentation filters have different meanings. **Export JSON** and **Export snapshots** support reproducible [CLI comparison](../sequence-diff/README.md).

For collector/viewer changes, run `npm test`, `npm run build:viewer` and `npm run check:live-setup` with installed Chrome. For comparison changes, also run `npm run check:comparison`. Device transfer changes require the selected platform's actual device checks; fixture coverage alone does not establish delivery from a customer app. [Troubleshooting by symptom](../docs/integration/TRANSPORT.md#troubleshooting-by-symptom).

## Server sources and parsing adapters

Configure server sources before starting the collector:

```sh
npm run collector -- --sources /absolute/private/sources.json --no-android --no-ios
```

The owner-controlled JSON array selects collection adapters and their parsers. Paths and credentials are configured locally; the viewer cannot submit arbitrary log paths, endpoints, modules, or tokens. Relative `--sources` paths resolve from the command's working directory. Keep credential-bearing source configuration private.

```json
[
  {
    "id": "auth-local",
    "kind": "local-file",
    "path": "/absolute/prove/.local/logs/server.log",
    "metadata": {
      "environment_id": "auth-local",
      "environment_name": "Local development",
      "app_id": "prove.unified-auth",
      "installation_id": "auth-local-server"
    }
  },
  {
    "id": "auth-cloudflare",
    "kind": "cloudflare-retained",
    "endpoint": "https://development.example/api/diagnostics/logs",
    "token": "development-collector-token",
    "metadata": {
      "environment_id": "auth-cloudflare",
      "environment_name": "Cloudflare development",
      "app_id": "prove.unified-auth",
      "installation_id": "auth-cloudflare-server"
    }
  }
]
```

A **collection adapter** retrieves records; a **parsing adapter** converts them into canonical events. The default `canonicalParser` accepts canonical JSON, the application's `{ "http_sequence": event }` wrapper, prefixed/ANSI-decorated structured console lines, and Cloudflare-style `logs[].message` envelopes. Ordinary text is unmatched; malformed structured records are counted as parse errors. Neither collector nor parser is a general-purpose redaction engine.

`local-file` paginates a regular UTF-8 file with a byte cursor and inode identity. File replacement, truncation during collection, oversized records, or an incomplete final line are reported rather than silently reset. Each refresh starts a bounded historical scan; accepted events deduplicate on canonical event ID, and raw mapped identities include the stable source reference. Records after the job's limits require narrowing the source/window or an adapter with targeted history lookup.

`cloudflare-retained` queries an **application-provided retained logging endpoint**, such as the unified auth sample's D1-backed development endpoint. This is not Cloudflare's native observability API. It requires HTTPS except for loopback local testing, sends configured bearer authorization, and rejects redirects. The endpoint accepts POST JSON:

```json
{
  "trace_ids": ["0123456789abcdef0123456789abcdef"],
  "time_window": { "start": "2026-10-07T00:00:00.000Z", "end": "2026-10-07T01:00:00.000Z" },
  "cursor": "opaque-next-page",
  "max_records": 500,
  "max_bytes": 1048576
}
```

`time_window` and `cursor` are optional. Return `{records:[objectOrString],cursor,has_more,sampled,truncated}`; cursor is opaque and must advance when `has_more` is true. The **entire serialized response** must fit `max_bytes`. Include matched trace records and the lifecycle metadata of their recordings. The collector preserves sampled/truncated indications, parse errors, unmatched counts, and up to five bounded failure examples with original references and reason codes in job status. Retention must already be enabled when requests execute; refresh cannot recover activity never recorded.

For bespoke JSON logs add a declarative parser to either source configuration:

```json
{
  "parser": {
    "type": "json-mapping",
    "namespace": "example.auth",
    "service": "legacy-service",
    "fields": {
      "message": "message", "timestamp": "time", "level": "severity",
      "trace_id": "trace.id", "span_id": "span.id", "parent_span_id": "span.parent"
    }
  }
}
```

Mapped records become `log.message` observations. Exact trace/span IDs associate them with existing spans; trace-only records retain `data.trace_id` without inventing a span. Missing context does not create HTTP activity. `monotonic_ns: "0"` on an independently mapped recording is accompanied by `source.clock: "monotonic_unavailable"`; do not infer durations from it. Message text remains the application/provider's responsibility to sanitize.

Programmatic integrations import `createLocalFileAdapter`, `createCloudflareAdapter`, `canonicalParser`, or `createJSONMappingParser` from `collector/adapters.mjs`. Pass `sources` to `startCollector`. Custom parsing is a synchronous `(value, sourceReference) => canonicalEvents[]` function; every output is schema-validated. A custom collector adapter supplies `{id,kind,metadata,parser,query}` where `query({trace_ids,time_window,cursor,max_records,max_bytes,signal})` returns `{records:[{value,reference}],cursor,has_more,sampled,truncated}`. Honor cancellation and the supplied limits. AWS/native provider integrations can implement that same interface without changing the viewer.

### Refresh jobs and related records

**Refresh related logs** in the viewer starts a job for the selected capture's traces. The shared authenticated API is:

- `POST /api/v2/collections`: `{session_namespace,session_id,source_id?,trace_ids?,adapter_ids?,time_window?}`; returns the job object and HTTP 202. Explicit `trace_ids` override capture-derived seeds.
- `GET /api/v2/collections`: configured adapter identities and bounded recent jobs.
- `GET /api/v2/collections/JOB_ID`: current job state and per-source diagnostics.
- `DELETE /api/v2/collections/JOB_ID`: cancel queued/running collection.
- `GET /api/v2/events?session_namespace=...&session_id=...&include_related=true`: own capture plus related recordings and their metadata, across source/session boundaries.
- `GET /api/v2/events?trace_id=TRACE_ID`: trace-oriented retrieval with recording metadata.

The viewer reader bearer is required; writes additionally require trusted same-origin viewer headers. Jobs use `queued`, `running`, `completed`, `failed`, or `cancelled` states and return `{job_id,state,event_count,sources:[{adapter_id,state,event_count,parse_errors,unmatched,sampled,truncated,reason?}]}`. Identical active jobs deduplicate. The collector allows four active jobs, retains at most 32 jobs, and limits a job to 64 seed traces, 32 adapters, 20 pages per adapter, 5,000 raw records/8 MiB per adapter, and a 30-second deadline. Time windows are at most 24 hours. Normal viewer snapshots are not limited to 64 traces.

A completed query establishes that its configured retrieval finished; it does not prove trace completeness. Different machine clocks supply approximate wall-clock alignment; span parent relationships establish causality. Related snapshot projection honors its fixed `high_water`, including metadata arriving before its seed request. Stable event identities prevent unchanged polls and replay from creating duplicate diagram nodes.
