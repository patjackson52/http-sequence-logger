# Connect an app, locate logs, and open the viewer

The app owns capture/instrumentation. Transfer sends existing sanitized events. The local collector persists them, and the desktop viewer reconstructs the sequence. Pairing alone does not add logging to an HTTP client.

```text
app HTTP / SDK / handler observations
  → app-owned canonical NDJSON
  → native file+HTTP sink (or Android ADB file watcher)
  → desktop collector capture.ndjson
  → same-origin browser HTTP reads + SSE notifications
  → interactive sequence + details

offline alternative: export canonical NDJSON → drop into local web viewer

browser frontend observations → origin-scoped IndexedDB journal
  → explicit same-origin POST → Node development relay → desktop collector
```

## Start desktop tools

In the pinned logger checkout, with Node **22.12+**:

```sh
npm ci
npm run build:viewer
npm run collector
```

Open the **Viewer** link printed by the collector. Default browser/API origin is `http://127.0.0.1:4319`; the link also carries a private browser token in its fragment. The page removes that fragment and retains the token in memory. On refresh, reopen the printed link. Plain `http://127.0.0.1:4319` can show file import without pairing but does not grant live read access.

For offline file import only, use `npm run viewer` or `npm run preview:viewer` (after a build), at `http://127.0.0.1:4173`. That Vite origin is **not** a collector endpoint. Live reads use the collector's own origin; adding permissive CORS or using a `file://` viewer is unnecessary and unsupported. Rebuild the viewer after changing source; the collector serves `viewer/dist/`.

## Select the device route

| Device | Pairing origin | Setup |
| --- | --- | --- |
| Android emulator or USB device | Loopback HTTP on the device, forwarded to desktop | Installed debuggable app, authorized ADB, explicit serial, `adb reverse` |
| iOS Simulator on this Mac | Desktop loopback HTTP | Development target permits local networking; pass generated loopback pairing JSON |
| Physical iPhone or Android over LAN | Desktop LAN HTTPS origin with paired certificate | Reachable host/firewall, generated LAN pairing JSON, applicable local-network permission |
| Browser frontend on developer computer | Same-origin development relay; relay forwards to desktop loopback | Debug package, origin-scoped journal, loopback-bound Node dev server; pairing stays server-side |
| Any device, offline | No endpoint | Export a sanitized canonical file and import it in the viewer |

Android low-friction connection, with the **actual application ID** (including any debug suffix), selected `adb devices` serial, and ADB executable:

```sh
npm run collector -- --android com.example.customer.debug --device emulator-5554 --adb /absolute/path/to/adb
```

This configures port reversal, writes `files/network-log/connection.json` through `run-as`, and polls **only** `files/captures/*.ndjson` as a fallback. It does not modify app source or install an interceptor. `DebugTransfer.open` reads pairing when a new sink opens; an already-open sink does not retarget. Re-pair after reinstalling or removing port reversal. The watcher retries reads after disconnect; the CLI does not continuously reinstall pairing/reverse. File-only logging can use the watcher without a native uploader; double delivery deduplicates by event ID.

For manual port reversal, using the selected serial:

```sh
adb -s "$DEVICE_SERIAL" reverse tcp:4319 tcp:4319
```

Use the generated loopback JSON, not `10.0.2.2` HTTP: the transfer library only permits cleartext loopback destinations. Merge the [Android guide's](ANDROID.md) debug-only loopback network configuration into the customer's existing policy. Native HTTPS business requests keep their normal security behavior.

For a physical phone, with a desktop IP/hostname reachable from that phone:

```sh
npm run collector -- --lan 192.168.1.25 --dir artifacts/customer-collector
```

The optional HTTPS listener defaults to `4320` and binds for LAN ingestion. Its certificate is generated with OpenSSL for the specified host and is valid for 30 days. Use **connection-lan.json** on the device. The browser still opens the loopback Viewer link on the desktop. LAN `/`, health, download and browser reads return 404; that is intentional. The LAN listener accepts authenticated uploads only. A changed LAN host or expired certificate requires a fresh collector directory and re-pairing; do not disable hostname/date/pin verification or install a global trust override.

Merge permissions into the development target according to its OS/target SDK; use [platform setup](../transfer/README.md#ios-simulator-and-wi-fi) and its official platform references. Physical-device signing, firewall and permissions must be verified on the chosen device; simulator success does not prove them.

## Where every file lives

These are **sample/tooling conventions**, not automatic capture discovery outside the listed directories. Resolve platform containers through APIs/tools; do not hardcode sandbox UUIDs or Android user paths.

| Owner | Location | Purpose / lifetime |
| --- | --- | --- |
| Android customer convention | `<context.filesDir>/captures/<unique>.ndjson` | Canonical capture and, with `FileHttpEventSink`, retained upload spool. Caller supplies the file. One sink can contain multiple sessions. |
| Android upload sink | `<capture>.transfer.json`, `<capture>.transfer.lock` | ACK cursor/identity and exclusive writer lock; private sidecars, not imports |
| Android debug pairing | `<context.filesDir>/network-log/connection.json` | Native upload credentials/configuration; created by ADB setup or `DebugTransfer.saveConnection` |
| iOS demo | `<Documents>/demo-<UUID>/<session_id>.ndjson` | Canonical manual-demo capture |
| iOS demo spool | Same demo directory, under `spool/` | `events.ndjson`, `cursor.json`, `writer.lock` |
| iOS existing app | Caller-selected Application Support capture and spool paths | No SDK default; adopt and record the paths in [the iOS guide](IOS.md). Keep canonical capture distinct from spool. |
| Browser customer app | IndexedDB under its exact frontend origin; default database `http-sequence-logger`, required app-owned `journalId` | Canonical sanitized journal; no filesystem path until explicit NDJSON download. One writer per journal. |
| Browser sample | Origin `http://127.0.0.1:4180`, database `http-sequence-logger-demo`, journal `browser-demo-v1` | Development panel exports `browser-capture.ndjson`; a different origin/profile has separate storage. |
| Desktop default collector | `<checkout>/artifacts/collector/capture.ndjson` | Canonical collected events, across devices/sessions; override directory with `--dir` |
| Desktop private pairing | Same directory: `connection-loopback.json`, optional `connection-lan.json` | Device upload configuration; do not import into viewer or commit |
| Desktop private state | Same directory: `connection-state.json`, `collector.lock` | Read/write tokens, collector identity, process ownership |
| Desktop TLS, when enabled | Same directory: `collector-key.pem`, `collector-cert.pem`, `certificate-host.txt` | Development key/certificate/hostname; not capture evidence |
| Built viewer | `<checkout>/viewer/dist/` | Static desktop web assets; not mobile app resources |

Only one collector process owns a directory. Stop it cleanly before restarting. To start a separate run use a new directory (and re-pair for its new identity/tokens); retain old captures. Do not truncate or replace an active journal or edit ACK/cursor files to force completion.

## Retrieve a canonical file without live delivery

Android, after selecting values from the actual app/device:

```sh
adb -s "$DEVICE_SERIAL" exec-out run-as "$APPLICATION_ID" ls files/captures
adb -s "$DEVICE_SERIAL" exec-out run-as "$APPLICATION_ID" cat "files/captures/$CAPTURE_NAME" > customer-capture.ndjson
node validate.mjs customer-capture.ndjson
```

`CAPTURE_NAME` is a selected basename from that directory. `run-as` requires a debuggable installed application; this is not a production extraction mechanism. `adb pull` cannot normally read private app storage. The sample also supports Android's document picker; a customer should expose an equivalent development-only export if needed.

iOS Simulator: discover a simulator with `xcrun simctl list devices available`, then resolve its container:

```sh
SIM_DATA=$(xcrun simctl get_app_container "$SIMULATOR_UDID" "$BUNDLE_ID" data)
# Use the app's chosen relative canonical path, not the spool's events.ndjson.
cp "$SIM_DATA/$CAPTURE_RELATIVE_PATH" customer-capture.ndjson
node validate.mjs customer-capture.ndjson
```

Physical iOS: use the app's development share sheet/Files/AirDrop export, or development container tools available for the signed app. The iOS sample's **Share last capture** exports its canonical file. No ADB-style arbitrary app sandbox reader is supplied for physical iOS.

Browser: use the development export control to download `journal.exportNDJSON()` as a Blob. Await `journal.flush()` for a persisted snapshot when possible; if persistence failed, identify and retain the memory-only recovery export. Inspect the actual database in DevTools → Application/Storage → IndexedDB. Browser-internal database files are not NDJSON and are not a stable transfer path.

Import the resulting file at `4173`, or use **Save capture** in the paired collector viewer to export the desktop journal. Review redaction before sharing. Never export pairing JSON as a capture, parse Logcat/console as this format, or contact URLs found inside a log.

## Browser frontend delivery

For the repository sample, run the collector above, then start the frontend in another terminal:

```sh
NETWORK_LOG_CONNECTION=/absolute/path/to/connection-loopback.json npm run web:sample
```

Open `http://127.0.0.1:4180`, run a flow, and click **Flush and upload**. Open the collector's printed viewer link at `4319`. The sample's fixture servers use `4181`/`4182`; these are business-request destinations, not collector endpoints. [Existing frontend setup](WEB.md#export-and-connect-the-viewer) shows `createNetworkLogRelay` middleware and production separation.

`uploadJournal(journal)` uses the frontend's own `/__network_log/config` and `/__network_log/events` routes. The Node development relay reads the private connection file at startup and forwards only sanitized NDJSON to the loopback collector. Host/Origin must match its configured frontend origin; do not add permissive CORS or expose the relay on the LAN. The current relay supports only an HTTP `127.0.0.1` collector endpoint, not the native certificate-pinned LAN route. Restart it after changing pairing.

Delivery is explicit foreground replay of retained events. The uploader checks collector identity and every submitted event ID; it does not delete acknowledged lines or maintain a cursor. Failed upload retains the capture; export it or invoke upload again. Collector deduplication makes replay safe. SSE belongs to collector → viewer notifications, not to SDK capture delivery. There is no browser timer retry, continuous stream, WebSocket or background sender.

## Pairing and delivery contract

Pairing JSON contains `version: 1`, an endpoint **origin**, upload `token`, `collector_id`, and optional `certificate_sha256`. Pass it to the platform parser; do not append `/api/v1/events` to `endpoint`. Device and browser tokens have different roles. Native sinks use Authorization headers and the protocol's endpoint paths themselves. [Full protocol](../transfer/PROTOCOL.md).

| Route | Listener / credential |
| --- | --- |
| `POST /api/v1/events` | Loopback or LAN; device token; NDJSON batch |
| `GET /api/v1/health` | Loopback only; no token; connectivity/identity check |
| `GET /api/v1/events?after=<cursor>`, `/api/v1/stream`, `/api/v1/download`, `/api/v1/pairing` | Loopback only; browser token; same-origin viewer |

Native batches are at most **1 MiB / 500 events**. The collector fsyncs new events before ACK; both native implementations cap ACKs at **2 MiB** and check collector identity and submitted IDs. Retries keep IDs and timestamps intact. Identical events deduplicate and conflicts reject the batch. Pairing a new collector causes native sinks to replay bytes still retained in their files/spools without synthesizing new requests. After Swift spool compaction, recovering full history requires an explicit `relaySanitizedFile(canonicalURL)`; the sink does not discover or reread the app's canonical files automatically. Device transport is HTTP; browser live notification is SSE, not WebSocket.

Browser replay uses the same 1 MiB / 500-event upload and 2 MiB ACK bounds through the relay, with no browser credential or cursor. The retained browser journal is canonical history; explicit repeated upload sends that history again.

## Retention and sender lifetime

- Android file-only `NdjsonFileSink` flushes synchronously and **truncates on open**. It has no automatic rotation/size limit. Allocate a new path for a new sink, or retain one sink across sessions. Do not use it to reopen an old capture for resume.
- Android `FileHttpEventSink` appends/fsyncs synchronously, sends on its own worker, retains acknowledged history, and defaults to 16 MiB per file. Run recording off the UI thread. Keep returned pending senders alive; close them before re-pairing. Reopen with `FileHttpEventSink` or `DebugTransfer.resumePending` to resume retained data, not by reopening an unpaired file-only sink. `resumePending` defaults to the latest 16 files; older files need explicit handling/export.
- Swift defaults to an 8 MiB spool and may compact acknowledged bytes. Canonical export files therefore need their own bounded retention. Use one actor sink per spool directory, `resume()` after reopen/foreground, and `close()` when finished. This is foreground development delivery, not OS-scheduled background transfer.
- Browser journals default to 8 MiB / 10,000 events and do not evict older records at capacity. Inspect `stats`, export and rotate to a new journal ID; do not silently clear an unexported journal. IndexedDB flush failures leave memory export available. The app owns journal/observer lifetime and handles browser storage unavailability or eviction; no unload persistence guarantee is made.
- Collector defaults to 64 MiB / 100,000 events. At capacity, keep/export the capture and start a new directory rather than discard unacknowledged data. File import allows 16 MiB per file, 64 MiB combined, 100,000 events; a large collector export may require splitting **between complete lines**. Preserve IDs and import all parts. The viewer is intended for roughly 10–20 requests per session and does not virtualize enormous diagrams.
- Permanent rejection retains pending data. Correct pairing/schema/storage first, then `retryNow()` (Android) or `resume()` (Swift). Transient failures retry with bounded backoff. `close()` retains unacknowledged data; it is not a successful-upload guarantee.

## Troubleshooting by symptom

| Symptom | Check next |
| --- | --- |
| Gradle recorder not found in Release | Expected guard: shared code must use API/no-op; never add a production fallback to recorder Debug |
| `run-as` denied / wrong app | Installed variant's real application ID, debug flag, selected/authorized device |
| Paired but no events | Capture hooks actually installed; session/sink active; correct canonical directory; `DebugTransfer.open` happened after pairing; validate a local file first |
| HTTP upload fails on Android loopback | ADB reverse, debug network-security merge, INTERNET permission, correct port and loopback pairing |
| Browser 401 after refresh | Reopen printed Viewer link, not device JSON/token or a bare URL |
| Browser sample upload 404 | Restart sample with `NETWORK_LOG_CONNECTION` pointing to private loopback pairing; relay middleware is optional |
| Browser relay 403 | Frontend origin/Host must exactly match configured scheme, host and port; use `127.0.0.1`, not a mismatched `localhost` alias |
| Browser journal missing after reload | Same origin/profile/database/journal ID; previous flush succeeded; inspect memory fallback and IndexedDB errors |
| LAN health/UI 404 | Intentional upload-only listener; use desktop loopback for health/viewer |
| TLS/connection failure on phone | Reachable LAN hostname/IP, firewall, permissions, fresh matching pin/certificate and dates; preserve checks |
| Collector 400 / 409 / 413 / 507 | Respectively schema/batch format, ID/sequence conflict, batch limit, storage limit; retain data and fix the cause |
| Spool busy / capture already open | One sender owns each Android file or Swift directory; close old owner before reopen/re-pair |
| File exists but viewer is incomplete | Missing lifecycle events, ended session too early, interrupted process, dropped observations; inspect diagnostics and do not fabricate ends |
| Viewer blank / failed worker load | Built `viewer/dist`, HTTP serving instead of `file://`, supported Node/build version; use correct viewer origin |

After diagnosis, rerun the affected customer-app acceptance checks in [the integration guide](README.md), not just a synthetic fixture.
