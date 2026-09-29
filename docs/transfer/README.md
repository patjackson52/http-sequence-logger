# Get captures from a device into the viewer

Use a **local desktop collector** as the common bridge. The SDK writes sanitized NDJSON locally first, then optionally delivers acknowledged batches over HTTP. The collector saves the capture and notifies the browser over server-sent events (SSE). No account, hosted service, or dashboard is required.

For customer-app integration, use the [agent entry point](../integration/README.md) and [connection, storage, retrieval and troubleshooting map](../integration/TRANSPORT.md). Platform code must supply capture observations; pairing alone does not instrument HTTP clients.

| Path | Recommended use | Integration |
| --- | --- | --- |
| Android USB / emulator | Default development workflow | `adb reverse` + HTTP sink; collector can configure both automatically |
| Android file watch | Existing app already writes capture files | Collector reads debuggable app's `files/captures/*.ndjson` with `adb run-as`; no new transport code |
| iOS Simulator | Development on the same Mac | Paste loopback connection JSON into the demo or configure the Swift sink |
| Physical iOS / Wi-Fi Android | Same trusted local network | Explicitly paired HTTPS with a leaf certificate fingerprint |
| Export/import | Offline work, sharing a reproducible session | Export NDJSON from the app, then drop it into the web viewer |

HTTP batch upload is enough for the current 10–20 request sessions. Device WebSockets would add connection/lifecycle complexity without a need for commands from desktop to device. SSE gives the browser live updates and cursor-based catch-up. Logcat/console parsing loses structure and can truncate payloads, so it is not the capture transport.

## One-command Android connection

Build/install the sample using [Android instructions](../../android/README.md). Then, from the repository root:

```sh
npm ci
npm run build:viewer
npm run collector -- --android dev.networklog.sample --device emulator-5554 \
  --adb "$HOME/Library/Android/sdk/platform-tools/adb"
```

Use your actual serial from `adb devices`. Open the **Viewer** URL printed by the command and run the sample. The command establishes `adb reverse tcp:4319 tcp:4319`, writes the private app pairing file, and watches existing capture files as a fallback. The sample chooses the HTTP sink at the start of its next run; it still offers local file export. Repeated file reads and HTTP deliveries deduplicate by event ID.

The app must be installed and debuggable for `run-as`. Re-run the collector command after reinstalling the app or losing ADB reverse. If pairing setup is unavailable, the collector stays usable; the file watcher reconnects automatically. It watches only the documented `files/captures` directory; custom apps can place exports there or use the sink with their own capture location. Files are limited to 16 MiB each for ADB extraction.

For Kotlin integration see `DebugTransfer.open(context, captureFile)` and `FileHttpEventSink` in the [Android guide](../../android/README.md). Existing HTTP wrappers and customer manual recording APIs stay the same: transfer is an `EventSink` choice. Call recording on a worker thread because durable disk writes are synchronous. The sender's own requests never pass through the recorder.

## iOS Simulator and Wi-Fi

For the Simulator, start `npm run collector` and use the generated `artifacts/collector/connection-loopback.json`. The [Swift package and iOS demo](../../ios/README.md) accept this JSON. An existing iOS producer can append already-sanitized schema events or relay its NDJSON file; it need not change its HTTP client.

For a physical phone, use the desktop's LAN IP or hostname:

```sh
npm run collector -- --lan 192.168.1.25
```

This adds HTTPS on port 4320 and creates `connection-lan.json`. The HTTPS listener accepts uploads only. The browser UI and capture-reading APIs remain bound to desktop loopback. Open the printed viewer URL on the desktop, click **Connect a device**, copy the HTTPS pairing JSON, and paste it in the sample app. Allow the app's local-network permission when prompted. The phone must be able to reach the desktop through its firewall and Wi-Fi network.

For Android apps targeting SDK 37 or higher on Android 17, direct LAN uploads require the app to declare and request `ACCESS_LOCAL_NETWORK`. The current sample targets SDK 35; lower-target apps should not request the new permission. See [Android local-network requirements](https://developer.android.com/privacy-and-security/local-network-permission). iOS requires its local-network usage description and permission where applicable; see [Apple local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

The collector generates a development certificate with OpenSSL, valid for 30 days and for the specified host. Only this explicitly paired certificate becomes a trust anchor; the SDK still checks its validity dates and the endpoint hostname. No system certificate installation, global trust override, or broad cleartext exception is needed. Changing host or renewing an expired certificate requires a new collector directory and re-pairing. An ordinary publicly trusted HTTPS collector can omit the fingerprint.

The iOS deliverable is a transport package plus a manually instrumented URLSession demo, not a full automatic URLSession recorder. The simulator path is verified; physical-device permissions, firewall reachability and device signing remain environment-specific setup.

## Live viewing and recovery

- The viewer opens the collected sessions automatically. New arrivals preserve selection, inspector, filters and collapsed methods. **Save capture** downloads all persisted events across sessions.
- Each app keeps a durable local spool. Upload failure does not change an observed HTTP request's success/error outcome. Validated ACKs advance a collector-specific cursor; reopening retries anything unacknowledged.
- The browser uses a separate read token from its launch URL, removes that token from the address bar, and keeps it in memory. After refreshing, reopen the printed launch URL. A reconnect replays missed events using the cursor. A changed collector identity requires its new launch link.
- Missing terminal events remain incomplete observations. A disconnected collector is shown as a connection state, never as an HTTP failure in the diagram.
- The collector persists before acknowledging. Identical events are safe to replay; conflicting IDs or recording sequences reject the whole batch. Event schema errors are rejected; incomplete live lifecycles are accepted and become viewer diagnostics until completion arrives.
- Storage is bounded: collector 64 MiB / 100,000 events; each HTTP batch 1 MiB / 500 events. Native spool defaults are documented per platform. On exhaustion, retain/export the existing capture and start a fresh one; unacknowledged events are never evicted. The Swift transport may reclaim already-acknowledged spool records, so keep the canonical capture file for full-history export. Large session diagrams are not virtualized.

Collector data defaults to ignored `artifacts/collector/`. Use `--dir /private/path` to separate runs. One collector owns each directory. The private state and pairing files contain tokens; do not commit or share those files. Share the already-redacted `capture.ndjson` only. A new directory creates new tokens and collector identity. Local file import requires no pairing.

[Protocol](PROTOCOL.md) defines endpoints, ACKs and recovery. [Verification](VERIFICATION.md) records the implemented checks and native evidence.
