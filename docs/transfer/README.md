# Get captures from a device into the viewer

Use a **local desktop collector** as the common bridge. The SDK writes sanitized NDJSON locally first, then optionally delivers acknowledged batches over HTTP. The collector saves the capture and notifies the browser over server-sent events (SSE). No account, hosted service, or dashboard is required.

For customer-app integration, use the [agent entry point](../integration/README.md) and [connection, storage, retrieval and troubleshooting map](../integration/TRANSPORT.md). Platform code must supply capture observations; pairing alone does not instrument HTTP clients.

| Path | Recommended use | Integration |
| --- | --- | --- |
| Android USB / emulator | Default development workflow | `adb reverse` + HTTP sink; collector can configure both automatically |
| Android file watch | Existing app already writes capture files | Collector reads debuggable app's `files/captures/*.ndjson` with `adb run-as`; no new transport code |
| iOS Simulator | Development on the same Mac | Paste loopback connection JSON into the demo or configure the Swift sink |
| Physical iOS / Wi-Fi Android | Same trusted local network | Explicitly paired HTTPS with a leaf certificate fingerprint |
| Browser frontend | Existing local development server | Same-origin Node relay and explicit journal upload; [browser setup](../integration/WEB.md#export-and-connect-the-viewer) |
| Export/import | Offline work, sharing a reproducible session | Export NDJSON from the app, then drop it into the web viewer |

HTTP batch upload is enough for the current 10–20 request sessions. Device WebSockets would add connection/lifecycle complexity without a need for commands from desktop to device. SSE gives the browser live updates and cursor-based catch-up. Logcat/console parsing loses structure and can truncate payloads, so it is not the capture transport.

## One-command Android connection

From the repository root, with Node 22.12+, JDK 17, Android SDK Platform 35/platform-tools and an authorized USB device or running API 26+ emulator:

```sh
npm ci
npm run android:live
```

This builds/installs the sample and viewer, chooses the single phone in preference to emulators, starts the collector, configures private pairing and USB reverse, opens **http://127.0.0.1:4319/** and runs the sample. No serial or connection JSON is required in the common case. Multiple phones or emulators need `-- --device SERIAL`; `-- --recovery` selects the retry flow. Keep the command running.

For an already installed sample, **`npm start`** builds/starts the viewer and collector and automatically connects it; run the flow in the app. For an instrumented customer debug app, build/install it with its own tools and use `npm run collector -- --android YOUR_APPLICATION_ID --open`; device selection and ADB discovery are automatic unless overridden with `--device`/`--adb`. Use `npm start -- --no-android` for iOS/browser-only work. Choose one collector startup command; `android:live` can reuse a matching directory/port, while `npm start` requires the port to be free.

The collector checks pairing and reinstalls `adb reverse` while watching. It recovers after USB reconnect, app reinstall or removal of the route; a private pairing file is replaced atomically only if its contents differ. It watches `files/captures/*.ndjson` as a fallback, and HTTP plus file deliveries deduplicate by event ID. The live panel shows the selected phone and connection state. An app must be installed and debuggable for `run-as`; if absent, the collector waits and shows the next step. Each extracted file is limited to 16 MiB.

While automatic USB watching is running, it owns this app's collector pairing. Stop that collector or restart it with `--no-android` before disconnecting pairing in the app. **Pause live** pauses browser updates; the collector continues retaining incoming events.

For Kotlin integration see `DebugTransfer.open(context, captureFile)` and `FileHttpEventSink` in the [Android guide](../../android/README.md). Existing HTTP wrappers and customer manual recording APIs stay the same: transfer is an `EventSink` choice. Call recording on a worker thread because durable disk writes are synchronous. The sender's own requests never pass through the recorder.

## iOS Simulator and Wi-Fi

For the Simulator, start **`npm start -- --no-android`** and use the generated `artifacts/collector/connection-loopback.json`, also available under **Other devices** in the viewer. The [Swift package and iOS demo](../../ios/README.md) accept this JSON. An existing iOS producer can append already-sanitized schema events or relay its NDJSON file; it need not change its HTTP client. The desktop viewer auto-connects at **http://127.0.0.1:4319/**; the iOS app still needs explicit pairing.

For a physical phone, use the desktop's LAN IP or hostname:

```sh
npm start -- --no-android --lan 192.168.1.25
```

This adds HTTPS on port 4320 and creates `connection-lan.json`. The HTTPS listener accepts uploads only. The browser UI and capture-reading APIs remain bound to desktop loopback. Open the printed viewer URL on the desktop, click **Other devices**, copy the HTTPS pairing JSON, and paste it in the sample app. Allow the app's local-network permission when prompted. The phone must be able to reach the desktop through its firewall and Wi-Fi network.

For Android apps targeting SDK 37 or higher on Android 17, direct LAN uploads require the app to declare and request `ACCESS_LOCAL_NETWORK`. The current sample targets SDK 35; lower-target apps should not request the new permission. See [Android local-network requirements](https://developer.android.com/privacy-and-security/local-network-permission). iOS requires its local-network usage description and permission where applicable; see [Apple local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

The collector generates a development certificate with OpenSSL, valid for 30 days and for the specified host. Only this explicitly paired certificate becomes a trust anchor; the SDK still checks its validity dates and the endpoint hostname. No system certificate installation, global trust override, or broad cleartext exception is needed. Changing host or renewing an expired certificate requires a new collector directory and re-pairing. An ordinary publicly trusted HTTPS collector can omit the fingerprint.

The iOS deliverable is a transport package plus a manually instrumented URLSession demo, not a full automatic URLSession recorder. The simulator path is verified; physical-device permissions, firewall reachability and device signing remain environment-specific setup.

## Live viewing and recovery

- The viewer opens the collected sessions automatically. **Follow newest session** initially selects each arriving session; choosing a session/request, filtering or collapsing a method disables following. New arrivals then preserve inspection state until following is enabled again. **Save capture** downloads all persisted events across sessions; **Download SVG** exports the current diagram.
- **Live** and the event count describe the collector → browser connection. Android readiness appears separately; for iOS/browser producers, verify delivery by running a flow and checking arrivals. A connected empty collector is waiting for a producer, not evidence of successful capture.
- Each app keeps a durable local spool. Upload failure does not change an observed HTTP request's success/error outcome. Validated ACKs advance a collector-specific cursor; reopening retries anything unacknowledged.
- The ordinary loopback viewer URL obtains its separate read credential automatically using a same-origin request. Refresh needs no special link. A reconnect replays missed events; a new collector identity clears old rows before loading the new capture. File import or Pause live suspends updates until Resume live.
- Missing terminal events remain incomplete observations. A disconnected collector is shown as a connection state, never as an HTTP failure in the diagram.
- The collector persists before acknowledging. Identical events are safe to replay; conflicting IDs or recording sequences reject the whole batch. Event schema errors are rejected; incomplete live lifecycles are accepted and become viewer diagnostics until completion arrives.
- Storage is bounded: collector 64 MiB / 100,000 events; each HTTP batch 1 MiB / 500 events. Native spool defaults are documented per platform. On exhaustion, retain/export the existing capture and start a fresh one; unacknowledged events are never evicted. The Swift transport may reclaim already-acknowledged spool records, so keep the canonical capture file for full-history export. Large session diagrams are not virtualized.

Collector data defaults to ignored `artifacts/collector/`. Use `--dir /private/path` to separate runs. One collector owns each directory. The private state and pairing files contain tokens; do not commit or share those files. Share the already-redacted `capture.ndjson` only. A new directory creates new tokens and collector identity. Local file import requires no pairing.

[Protocol](PROTOCOL.md) defines endpoints, ACKs and recovery. [Verification](VERIFICATION.md) records the implemented checks and native evidence.
