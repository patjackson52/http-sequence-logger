# Realtime collection across Android, iOS and web

Start one collector with `npm start`. It discovers participating debug apps on all authorized Android devices and booted iOS simulators, accepts paired native uploads and browser relay traffic, and shows **Devices and environments → Apps → Sessions**. Device and package arguments are optional filters. Apps must initialize the debug bootstrap and publish the current private descriptor; arbitrary applications are not instrumented automatically.

The supported contracts are event schema **1.2** and transfer/configuration **2**. Use Node **24.13.x** and a new collector directory, defaulting to `artifacts/collector-v2`. Existing state is not migrated or adopted. Unsupported directories are rejected and left untouched.

| Platform | Setup | Collection and recovery |
| --- | --- | --- |
| Android USB / emulator | Initialize `DebugTransfer` in the debug app; authorize ADB. | The collector discovers packages, pairs privately and configures ADB reverse. Native HTTP upload and bounded canonical-file reads share one source credential and deduplicate retries. |
| iOS Simulator | Initialize `DebugCapture`; install and launch on a booted simulator. | The collector resolves app containers, discovers opt-in descriptors and writes private loopback pairing. Incremental upload and canonical-file recovery preserve event identities. |
| Physical iOS / Android Wi-Fi | Start with `--lan HOST`; use **Pair another device** in the viewer and paste HTTPS pairing JSON into the development app. | Foreground upload with scoped credentials and explicit certificate trust. Resume from the durable journal after reconnect or foregrounding. Bonjour supplies candidates, never authorization. |
| Browser app | Configure the SDK and same-origin development relay. | The page registers before its first event and continuously sends bounded IndexedDB batches. Each tab owns its journal; the Node relay holds collector credentials. |
| Browser on another machine or phone | Use an explicitly reachable HTTPS frontend with authenticated, session-bound relay access. | The browser contacts its own frontend origin. Validate real browser permissions and network reachability for the target environment. |

Debug logging keeps one canonical native journal. Appends enter a bounded asynchronous queue; `flush` is a persistence barrier, and delivery is a separate operation. Acknowledgment advances a collector/source/generation-bound cursor and does not delete capture history. Browser recovery depends on IndexedDB availability and the page running again; tab closure is not a guaranteed final flush.

The collector stores records and metadata in SQLite through one database worker, with WAL and full synchronization. An accepted upload atomically commits event attribution, deduplication, watermarks and file checkpoints before its ACK. Disk or quota failures reject new work visibly and retain existing history. Durability still depends on the host filesystem and storage device honoring synchronization.

The viewer queries source and session summaries independently of selected-session event pages. Live notifications trigger bounded catch-up. **Pause live** stops viewer updates while collection continues; **Save capture** exports the committed collector history. Source status describes recent presence, with expired sources shown as unknown rather than assumed connected. Missing tools and device authorization appear as adapter diagnostics even with no events.

Use the private active manifest for the default collector. A second collector needs an explicit directory/port and selection; it cannot silently replace the active owner. Pairing and state files contain credentials and belong outside public frontend roots and source control. Share sanitized NDJSON, rather than private state.

Follow the [integration entry point](../integration/README.md), [transport map](../integration/TRANSPORT.md), [protocol](PROTOCOL.md), and platform guides for API examples. The [implementation plan](../design/REALTIME-MULTIPLATFORM-PLAN.md) records execution boundaries and acceptance gates. Historical evidence in the older verification document does not establish current-contract or physical-device coverage.
