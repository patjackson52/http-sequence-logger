# Browser SDK

Development HTTP and SDK/app handler capture for browser frontends. Zero runtime package dependencies; JavaScript ES modules with TypeScript declarations. Captures use the shared **1.2 NDJSON** format and existing sequence viewer.

| Entry | Use |
| --- | --- |
| `@http-sequence-logger/web` | Small production API/no-op; no recorder, storage, transfer, or imports |
| `@http-sequence-logger/web/debug` | Recorder, Fetch/XHR adapters, manual API, memory/IndexedDB journals, explicit upload |
| `@http-sequence-logger/web/dev-relay` | Node-only development middleware; never import into browser code |

This package is private and **not published to npm**. Install its `web-sdk/` directory from a pinned source checkout. See [existing frontend integration](../docs/integration/WEB.md) for installation, build aliases, public APIs, storage, export, and collector delivery. [Agent entry point](../AGENTS.md) · [JSON/spec index](../docs/integration/SPECS.md).

## Run the sample

From the repository root, using Node 22.12+:

```sh
npm ci
npm run web:sample
```

Open `http://127.0.0.1:4180`. **Run sign-in with token recovery** exercises a small SDK, two local server origins (`4181` and `4182`), Fetch, an awaited app handler using XHR, and an expected 401 followed by refresh. The fixture is simulated authentication, not a production OAuth implementation. **Try two public APIs** calls JSONPlaceholder and DummyJSON; availability and browser CORS policy can affect that optional flow.

The development panel exports NDJSON, reopens its IndexedDB journal, runs browser boundary checks, and explicitly uploads through an optional relay. For live viewing, start the collector from the logger checkout in one terminal:

```sh
npm start -- --no-android
```

It builds/opens the viewer automatically at **http://127.0.0.1:4319/**. Keep it running, then start or restart the sample from the same checkout in a second terminal:

```sh
NETWORK_LOG_CONNECTION="$PWD/artifacts/collector/connection-loopback.json" npm run web:sample
```

Use the actual private connection-file path if you changed the collector's `--dir`. Run a sample flow and click **Flush and upload**; the viewer displays arriving events automatically and reconnects after refresh without a token URL. The source browser SDK still needs that explicit upload each time; it has no background stream. Upload replay preserves event IDs and the collector deduplicates events. The source browser retains its IndexedDB journal, while **Save capture** downloads the desktop `artifacts/collector/capture.ndjson`. File import works without pairing. Keep the relay's connection file server-side and out of commits.

## Verify

```sh
npm test
npm run check:web-types
npm run check:web-release
npm run check:web-browser # Installed Google Chrome; ports 4180–4182 free
npm run build:web-sample
node validate.mjs /absolute/path/to/browser-capture.ndjson
```

The release audit builds positive debug controls and production, checks the module graph and every emitted asset/source map, and verifies that recorder/storage/transfer and development controls are absent. This verifies the repository sample; audit the host frontend's own shipping output too.

Real browser NDJSON and verification are in [samples/web](../samples/web/README.md).

The SDK observes browser-exposed metadata. It does not capture hidden cookies, wire headers, browser-internal redirects/retries, unconsumed streams, or arbitrary existing clients automatically. [Design and scope](../docs/web/PLAN.md) · [Review and evidence](../docs/web/REVIEW.md).
