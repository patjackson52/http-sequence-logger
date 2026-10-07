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
import { createLogger, IndexedDBJournal, startJournalDelivery } from '@http-sequence-logger/web/debug';

const journal = await IndexedDBJournal.open({
  databaseName: 'my-app-network-log-v2',
  journalId: tabOwnedJournalId, // Persist in tab-scoped development storage; unique per active tab.
});
const logger = createLogger({
  namespace: 'my-app.development', appId: 'my-app', sink: journal,
  policy: { redactBodyKeys: ['customerIdentifier'] },
  onDiagnostic: code => showCaptureDiagnostic(code), // An app-owned debug UI.
});
const delivery = startJournalDelivery(journal, {appId:'my-app', onStatus:showCaptureDiagnostic});
const session = logger.startSession({ name: 'Sign in', sessionId: existingSessionId });
// Omit sessionId to generate one. End only when the observed flow is finished.
```

Production setup returns `noOpLogger` from the default entry. Shared operations and handlers still execute normally. Suppliers passed to no-op recording methods are not evaluated; bodies and sensitive metadata should remain inside suppliers.

Logs live in **IndexedDB for the frontend origin**, not a device filesystem path. The database defaults to `http-sequence-logger-v2`; `journalId` is required. One journal can retain multiple sessions and recordings. Closing/reopening the same database/journal preserves stored lines and event IDs; another port, browser profile or origin has different storage. Use DevTools → Application/Storage → IndexedDB to inspect the chosen database. Do not copy browser-internal database files as NDJSON.

The sample uses origin `http://127.0.0.1:4180`, database `http-sequence-logger-demo-v2`, a random journal ID retained under the development-only `network-log-journal-v2` session-storage key, and downloads `browser-capture.ndjson`. Customer apps choose and document their own names.

`MemoryJournal` and `IndexedDBJournal` default to **8 MiB / 10,000 events**. Capacity retains records and rejects later writes; inspect `stats.dropped`, `pending`, and `error`. IndexedDB opens metadata only, appends short groups, and reads indexed ranges. `append()` admits to a bounded memory queue; `await journal.flush()` waits for committed groups. Persisted history is not hydrated into a memory mirror.

One live writer owns a journal. Web Locks prevent displacement and release on browser teardown; transactional lease/epoch checks fence stale writes and ACKs. Environments without Web Locks recover an expired owner after its lease. Use a distinct journal for every concurrent tab. Close the sender before closing the journal. Store the journal ID in development tab state to resume it on reload. Guard access to session storage: private/storage-denied environments can throw or return no storage. A fresh random page journal preserves capture when reload recovery is unavailable. If a duplicated tab finds a healthy owner, allocate another journal ID; do not displace that owner. The sample implements these cases. Storage eviction and abrupt unflushed-tail loss remain browser limitations.

`await journal.exportNDJSON()` explicitly reads retained capture pages for a download. A failed IndexedDB append retains only its bounded pending-memory records through `exportPendingNDJSON()`; previously committed records remain in IndexedDB and require a healthy reader. A MemoryJournal fallback has no restart durability. Display storage failures instead of implying that enqueue means persistence.

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

## Continuous delivery and viewer

In the pinned checkout run `npm ci`, then `npm start`. The collector discovers available native sources, serves its ordinary loopback viewer URL, and lists participating web pages as soon as they register, even before events arrive. Device tools are optional; collection and the viewer continue when tools are absent. Static `npm run viewer` accepts exported files separately.

Always mount the Node-only relay in the debug frontend, even when the collector is absent:

```js
import {createNetworkLogRelay} from '@http-sequence-logger/web/dev-relay';
server.middlewares.use(createNetworkLogRelay({origin:'http://127.0.0.1:4180'}));
```

The relay refreshes the private `~/.http-sequence-logger/active.json` manifest and waits when no collector is running. Set private `connectionFile` explicitly to select another collector. Restarting the same collector needs no frontend restart; another collector identity requires deliberate selection. Never put credentials in `VITE_*`, public assets, frontend config or capture exports.

`startJournalDelivery(journal,{appId})` runs one foreground drain, wakes on append, registers the page before events, sends bounded batches, checks source/collector ACK identity, and commits collector/source-scoped cursors in the owned journal. Lost responses replay unchanged IDs. `uploadJournal(journal,{appId})` performs one incremental drain. Neither delivery mode deletes canonical captures. Pause in the viewer stops viewing; collection continues. A closed/suspended browser cannot promise delivery until the participating page resumes.

Reachable/mobile frontend delivery is opt-in: serve the host frontend over HTTPS, set `reachable:true`, and provide `authorize(req)` that validates a real frontend session and returns a stable opaque session ID or null. Origin and Host checks are additional defenses, never authentication. Relay handles bind to that authenticated session, app, origin and journal. Use the browser's same-origin session cookies; source credentials remain Node-only. Configure TLS, host access and firewall using the frontend's existing development server; validate actual mobile/browser permission behavior. Collector viewer/read APIs remain loopback. No collector CORS exception, browser-to-collector token, arbitrary relay target or service worker is needed.

See the [sample relay](../../web-sample/vite.config.mjs), [sample lifecycle](../../web-sample/setup-debug.mjs), and [typed consumer](../../integration/web-consumer/check.mts).

## Verify the integration

Run the chosen app/SDK/handler flow, export and `node validate.mjs capture.ndjson`, then inspect ownership, server lanes, outcomes and capture limitations. Test unread/error/abort cases, IndexedDB close/reopen, collector-offline export, explicit retry and replay deduplication. Confirm custom-client observations survive with correct parents. Check application behavior with the no-op build and audit the host's shipping graph/assets/maps. Repository commands are `npm test`, `npm run check:web-types`, `npm run check:web-release`, and `npm run check:web-browser` (installed Google Chrome; isolated profile); record actual browsers and commands exercised rather than treating Node tests as browser evidence.

Browser wall time uses UTC; relative timing uses `performance.now()` converted to decimal nanoseconds. Browser precision and sleep behavior vary. Defaults redact common credential headers/query keys and JSON body keys; non-JSON, malformed/oversized JSON and unsupported payloads are withheld. Add app-specific selectors and inspect an exported capture before sharing. Raw logs are sensitive development artifacts even after default redaction.

Propagation allowlists authorize the initial destination. Automatic redirects can forward ordinary custom headers outside instrumentation visibility; the host owns redirect/header-forwarding policy for allowed endpoints. The logger preserves existing HTTP behavior and does not fabricate per-hop observations.
