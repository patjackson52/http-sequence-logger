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

One directory has one collector owner. An existing active manifest cannot be silently taken over. For an isolated collector without device discovery, choose a distinct directory and port:

```sh
npm run collector -- --dir artifacts/collector-isolated --port 4321 --no-activate --no-android --no-ios
```

`--no-activate` leaves default relays attached to their active collector; producers/relays for this isolated instance require explicit configuration. Existing unsupported state is rejected without migration. Capture schema **1.2** and transfer/configuration **2** are separate versions. Keep database, manifests, pairing files, credentials and TLS keys private; share reviewed, sanitized NDJSON exported with **Save capture**.

## Device uploads, inspection and comparison

Android USB uses authorized ADB and automatic reverse/pairing. iOS simulators use private container discovery/pairing. For physical iOS or Wi-Fi upload, `--lan HOST` enables HTTPS for the supplied DNS name/IP on port `4320` (override with `--tls-port PORT`). **Pair another device** provides scoped enrollment JSON for the development app. Explicit trust, permissions and reachable networking are required; `--bonjour` advertises candidates only. Follow the [transport guide](../docs/integration/TRANSPORT.md) and [protocol](../docs/transfer/PROTOCOL.md).

The [viewer guide](../viewer/README.md) covers source/session navigation, pause, file import, SVG export and **Compare with…**. Pause affects viewer reads while ingestion continues. Comparison freezes two snapshots and offers explicit recomputation after relevant later events; source scope and presentation filters have different meanings. **Export JSON** and **Export snapshots** support reproducible [CLI comparison](../sequence-diff/README.md).

For collector/viewer changes, run `npm test`, `npm run build:viewer` and `npm run check:live-setup` with installed Chrome. For comparison changes, also run `npm run check:comparison`. Device transfer changes require the selected platform's actual device checks; fixture coverage alone does not establish delivery from a customer app. [Troubleshooting by symptom](../docs/integration/TRANSPORT.md#troubleshooting-by-symptom).
