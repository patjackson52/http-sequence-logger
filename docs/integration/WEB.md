# Integrate a browser frontend

Use the shared sequence viewer and schema with an opt-in browser SDK. Fetch, XHR and customer-managed clients are supported; SDK → app handler → SDK tracing supports synchronous returns and explicitly awaited promise settlement. There is no global monkeypatch, service worker interceptor, automatic trace-header injection, or hosted service.

## Install and separate production

Pin the [source checkout](README.md#start-from-the-url), then install its local package from the host frontend:

```sh
npm install ./third_party/http-sequence-logger/web-sdk
```

`@http-sequence-logger/web` is private/unpublished. Do not substitute an unverified registry package. It has no runtime dependencies and defaults to the no-op API. `@http-sequence-logger/web/debug` adds capture; `@http-sequence-logger/web/dev-relay` is Node-only middleware. TypeScript development-server configuration also needs the host toolchain’s Node type declarations (`@types/node` as a development dependency).

Establish the build boundary before adding call sites. Business code should import an app alias such as `#logger`. Resolve that alias to the debug entry for development, and to the default entry for shipping. Resolve a second setup alias to separate development/production factory files, so the production graph never imports journals, uploader, pairing/export controls, or debug setup. Keep TypeScript's alias resolution consistent with the bundler. Adapt the concrete [Vite configuration](../../web-sample/vite.config.mjs), [debug setup](../../web-sample/setup-debug.mjs), and [production setup](../../web-sample/setup-production.mjs) to the host framework.

A runtime `enabled` flag does not remove code. Audit chunks, maps, copied assets, public directories and service-worker precaches, as well as the dependency graph. The package's `sideEffects: false` supports optimization but is not the production boundary. The repository's `npm run check:web-release` demonstrates an audit with positive debug controls; repeat it against the customer's shipping output. [Typed external consumer](../../integration/web-consumer/check.mts).

## Own sessions and storage

Create the recorder only in development setup:

```js
import { createLogger, IndexedDBJournal } from '@http-sequence-logger/web/debug';

const journal = await IndexedDBJournal.open({
  databaseName: 'my-app-network-log',
  journalId: 'capture-2026-09-28', // App-owned; one live writer per journal.
});
const logger = createLogger({
  namespace: 'my-app.development', appId: 'my-app', sink: journal,
  policy: { redactBodyKeys: ['customerIdentifier'] },
  onDiagnostic: code => showCaptureDiagnostic(code), // An app-owned debug UI.
});
const session = logger.startSession({ name: 'Sign in', sessionId: existingSessionId });
// Omit sessionId to generate one. End only when the observed flow is finished.
```

Production setup returns `noOpLogger` from the default entry. Shared operations and handlers still execute normally. Suppliers passed to no-op recording methods are not evaluated; bodies and sensitive metadata should remain inside suppliers.

Logs live in **IndexedDB for the frontend origin**, not a device filesystem path. The database defaults to `http-sequence-logger`; `journalId` is required. One journal can retain multiple sessions and recordings. Closing/reopening the same database/journal preserves stored lines and event IDs; another port, browser profile or origin has different storage. Use DevTools → Application/Storage → IndexedDB to inspect the chosen database. Do not copy browser-internal database files as NDJSON.

The sample uses origin `http://127.0.0.1:4180`, database `http-sequence-logger-demo`, journal `browser-demo-v1`, and downloads `browser-capture.ndjson`. Customer apps choose and document their own names.

`MemoryJournal` and `IndexedDBJournal` default to **8 MiB / 10,000 events**. They retain existing records at capacity and report dropped writes through `stats`; choose a new journal/export policy rather than silently discarding history. IndexedDB keeps a bounded memory mirror. `append()` queues persistence; `await journal.flush()` is the persistence barrier. Inspect `stats.error` and handle rejected flushes. If IndexedDB opening fails, the app may explicitly select `MemoryJournal` and show that persistence is unavailable. A write failure retains memory export but is not a durable-write guarantee. Browser storage eviction, private browsing restrictions and abrupt page termination remain possible; no unload/background delivery is promised.

Before switching journals or tearing down app-owned observers, end the session, dispose observers and await `journal.close()` for IndexedDB. Export remains available from the memory mirror when persistence fails. Use explicit development controls to download `journal.exportNDJSON()` as a Blob; prefer `await journal.flush()` first, but allow an identified memory-only recovery export after failure. Never include pairing data in the exported capture.

## Fetch and explicit body completion

Business code can use the build alias:

```js
import { createFetchClient } from '#logger';

const app = { owner: 'integrator', component: 'Checkout', method: 'load' };
const client = createFetchClient(session, { origin: { initiator: app, executor: app } });
const response = await client.fetch('/api/profile');
const profile = await client.readJson(response);
```

The returned object is the original `Response`; original fetch arguments, credentials, signals and redirect policy are forwarded. `fetchImpl` can supply the app's existing Fetch implementation. Per-call metadata may override `name`, `origin` and `parent` without sending those values to the server.

Use `readText`, `readJson` or `readArrayBuffer` where the app already consumes the response. The adapter does not clone/tee/drain it. EOF completes HTTP; JSON parsing occurs afterward, so a syntax error does not turn a successfully transferred HTTP response into a network failure. HTTP 4xx/5xx remains a returned response and is recorded as an HTTP error after completion. Read failure preserves a previously observed status.

For streaming or other consumption, call `client.exchangeFor(response)` and record the app's actual body/completion observation manually. Do not call `complete()` at header arrival. An unread body remains unknown when the session ends; opaque responses have no fabricated status or successful completion. Body limits bound retained capture, not the memory used by an application choosing to read an entire response.

String/Uint8Array/ArrayBuffer `init.body` values can be observed. Existing `Request` bodies, streams, FormData and unsupported forms are not consumed to obtain a log. Their body state is unavailable unless the application supplies its own observation. Headers are browser-filtered or application-configured subsets, never raw-wire headers. Hidden redirects/retries stay one logical exchange. Text byte counts describe UTF-8 application text, not compressed bytes or Content-Length.

## XHR and custom clients

Observe an XHR after `open()` and request-header setup, immediately before `send()`:

```js
import { observeXHR } from '#logger';

const xhr = new XMLHttpRequest();
xhr.open('GET', '/api/proof');
const observation = observeXHR(session, xhr, () => ({
  method: 'GET', url: new URL('/api/proof', location.href).href,
  body: null, origin: { initiator: app, executor: app }, parent: handlerContext,
}));
try { xhr.send(); }
catch (error) { observation.dispose(); throw error; }
// Keep the app's existing load/error/abort/timeout handling.
// Dispose on component teardown and before reusing this XHR for another send.
```

The observer adds XHR listeners without replacing application callbacks or changing `open`/`send`. It adds no upload listeners. `load`, `error`, `abort`, and `timeout` remain distinct. Supply the configured method/URL/headers/body; the browser does not expose all request configuration afterward. Omit `body` when unknown; `body: null` explicitly establishes absence. Text and ArrayBuffer responses can be captured; parsed JSON, Blob and Document response bodies are unavailable in this adapter. Parsed objects are not reconstructed into supposedly original response bytes.

Any custom HTTP client can use the manual API without adopting Fetch/XHR. For example, in its existing callbacks, with `app` and `session` from above:

```js
const exchange = session.startRequest(() => ({
  method: configuredMethod, url: configuredURL, headers: configuredHeaders,
  origin: { initiator: app, executor: app }, parent: methodContext,
}));
// Feed observations at the client's actual boundaries, preserving its callbacks.
exchange.requestBody(() => ({ data: sentBytes, mediaType: requestMediaType }));
exchange.responseHeaders(() => ({ status: observedStatus, url: effectiveURL, headers: visibleHeaders }));
exchange.responseBody(() => ({ data: deliveredBytes, mediaType: responseMediaType }));
exchange.complete(); // Only after known body EOF.
// Alternatives: fail(error, 'read'), timeout(error), cancel(), or
// stopObservation('component_disposed') when completion cannot be observed.
```

Values above are placeholders for the custom client's observations, not required networking methods. Suppliers are lazy and capture failures do not replace application results. The first terminal call wins. Pass unavailable/not-applicable body state instead of inventing data. This release's manual API does not expose every optional schema feature such as native metrics, trailers or retry linkage. [Public types](../../web-sdk/src/api.d.mts) define the callable API.

## SDK → app handler → SDK

```js
const sdk = { owner: 'sdk', component: 'AuthSDK', method: 'signIn' };
const handler = { owner: 'integrator', component: 'CustomerApp', method: 'provideProof' };
const operation = session.startOperation({ name: 'AuthSDK.signIn', origin: sdk });
try {
  const proof = await session.invokeAsyncHandler({
    name: 'CustomerApp.provideProof', origin: handler, caller: sdk,
    parent: operation.context,
  }, context => suppliedHandler(context));
  // Pass context explicitly to HTTP performed inside suppliedHandler.
  acceptProof(proof); // SDK execution resumes after the awaited settlement.
  operation.end();
} catch (error) { operation.end('error', error); throw error; }
```

`invokeAsyncHandler` calls once and preserves the fulfilled value or rejection object; its returned Promise is a wrapper. The viewer displays awaiting/resolved/rejected boundaries, not a blocked browser thread. `invokeHandler` instead observes the immediate synchronous return and preserves the returned object's identity, including a Promise. Later asynchronous work can outlive that synchronous span. Neither API installs ambient async context or records arguments/results. Manually managed `startHandler()` exposes `returned()`, `threw(error)`, `cancel()` and `stopObservation(reason)`; pass `dispatch: 'awaited'` only when the caller actually awaits the observed settlement. End ordinary operations with `end()`/`end('error', error)`.

## Export and connect the viewer

In the pinned logger checkout, run `npm ci` and **`npm start -- --no-android`**. It builds/opens the collector viewer at **http://127.0.0.1:4319/**; the ordinary URL auto-connects and survives refresh. Keep that terminal running. Automatic viewer connection does not configure the frontend's upload relay. For direct file use, export NDJSON and import it into `npm run viewer` at `http://127.0.0.1:4173`. No pairing is needed for file import.

For delivery, mount the Node-only relay in a **loopback-bound development server**. Its configured `origin` must exactly match the frontend's scheme, host and port. Use the collector's `connection-loopback.json`; the relay accepts only an HTTP `127.0.0.1` collector endpoint. It reads credentials server-side at startup. Do not use `VITE_*`/public environment variables, bundle the JSON, expose it through a public directory, or relax collector CORS.

```js
// Development server configuration only; adapt middleware registration to the framework.
import { createNetworkLogRelay } from '@http-sequence-logger/web/dev-relay';
server.middlewares.use(createNetworkLogRelay({
  connectionFile: process.env.NETWORK_LOG_CONNECTION,
  origin: 'http://127.0.0.1:4180',
}));
```

From debug browser wiring, `await uploadJournal(journal)` uses the same-origin `/__network_log` relay. It flushes, snapshots, replays retained records in bounded batches and verifies acknowledgments. Failed delivery leaves the journal available for export/retry. Repeated calls deliberately replay the retained journal; deduplication occurs at the collector. There is **no browser ACK cursor, compaction, timer retry, continuous streaming, WebSocket, or background sender**. Trigger another upload when desired. Collector → viewer live updates use SSE after the upload arrives.

Run the host flow, upload, and confirm the viewer's event count/session. **Save capture** exports the desktop journal at `artifacts/collector/capture.ndjson`; the frontend's IndexedDB remains its canonical source. Viewer pause or file import suspends browser reads while the collector continues retaining uploads. **Resume live** returns to the collector, and **Follow newest session** displays new sessions until inspection/filtering disables it. [The transport recipe](TRANSPORT.md#browser-frontend-delivery) has a copyable two-terminal setup for the repository sample.

The relay permits only config reads and event uploads, validates Host/Origin, and keeps the device token away from browser code. Restart the dev server after changing pairing files. Same-origin script can use this development capability; it is not a production upload API. Remote mobile browsers, arbitrary LAN relay exposure, direct browser-to-collector cross-origin uploads and hosted collector access are outside this recipe.

## Verify the integration

Run the chosen app/SDK/handler flow, export and `node validate.mjs capture.ndjson`, then inspect ownership, server lanes, outcomes and capture limitations. Test unread/error/abort cases, IndexedDB close/reopen, collector-offline export, explicit retry and replay deduplication. Confirm custom-client observations survive with correct parents. Check application behavior with the no-op build and audit the host's shipping graph/assets/maps. Repository commands are `npm test`, `npm run check:web-types`, `npm run check:web-release`, and `npm run check:web-browser` (installed Google Chrome; isolated profile); record actual browsers and commands exercised rather than treating Node tests as browser evidence.

Browser wall time uses UTC; relative timing uses `performance.now()` converted to decimal nanoseconds. Browser precision and sleep behavior vary. Defaults redact common credential headers/query keys and JSON body keys; non-JSON, malformed/oversized JSON and unsupported payloads are withheld. Add app-specific selectors and inspect an exported capture before sharing. Raw logs are sensitive development artifacts even after default redaction.
