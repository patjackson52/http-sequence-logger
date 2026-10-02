# Browser development capture

The default package entry is a production no-op. Import `/debug` only through a debug build alias, and mount `/dev-relay` only in the Node development frontend. Ship neither implementation, credentials nor development UI.

```js
import {createLogger, IndexedDBJournal, startJournalDelivery} from '@http-sequence-logger/web/debug';
const journal = await IndexedDBJournal.open({journalId: crypto.randomUUID()});
const logger = createLogger({namespace:'customer.auth', appId:'customer-web', sink:journal});
const delivery = startJournalDelivery(journal, {appId:'customer-web', onStatus:console.log});
// Wire application-owned Fetch/XHR/manual hooks as described in docs/integration/WEB.md.
// On teardown: delivery.stop(); await journal.close();
```

Retain the journal ID in tab-scoped development storage to resume it on reload. Each concurrently active tab needs its own journal; a live owner cannot be replaced. A suspended owner has a 15-second lease, and transaction epochs reject its writes and ACKs after another owner takes over. Unexpected storage loss/eviction remains a browser limitation. `flush()` waits for committed groups; `append()` only admits capture to a bounded queue. Inspect `stats.error`, `pending`, and `dropped`.

IndexedDB opens metadata only and reads event pages by key. `await journal.exportNDJSON()` explicitly exports history; it is not part of ingestion. Retained lines are never deleted by ACKs. Collector/source-scoped cursors resume delivery after reload. Failed delivery keeps the durable journal. MemoryJournal is a bounded fallback with synchronous export and no restart guarantee.

The foreground sender registers a source before its first event, sends bounded NDJSON batches, checks ACK identity, commits delivery cursors, and wakes on append or an idle heartbeat. It cannot deliver while the tab is closed or the browser suspends it. Reopening the journal resumes retained captures. `uploadJournal(journal,{appId})` performs one incremental drain.

```js
// Node dev-server configuration, never a browser import:
import {createNetworkLogRelay} from '@http-sequence-logger/web/dev-relay';
server.middlewares.use(createNetworkLogRelay({origin:'http://127.0.0.1:4180'}));
```

Always mount the relay for the debug frontend. It waits when the collector is absent, refreshes the private `~/.http-sequence-logger/active.json` manifest, and follows endpoint changes for the same collector. It refuses a different collector; restart with an explicit `connectionFile` to select it. Source credentials stay in Node; pages receive opaque journal handles. No collector CORS exception is required. Start frontend before or after `npm start`.

For a reachable frontend, serve HTTPS and set `{reachable:true, authorize: async req => authenticatedSessionId}`. Authorization must validate the host frontend's actual session for every relay request and return null when unauthenticated; trusting Origin, Host, IP, or user-provided headers alone is insufficient. Cookie-based frontend sessions work through same-origin fetch credentials. Handles are bound to that session, app, origin and journal. Provide no arbitrary collector target in request parameters. TLS/reachable frontend and mobile browser deployment are host-owned and require actual browser validation.

The repository sample uses build aliases, a private Node relay, native business Fetch calls and zero-production dependencies. Run `npm run check:web-types`, `npm run check:web-release`, and `npm run check:web-browser` from the contract repository.

Validation evidence for this update: real Chrome154, Firefox155 and Playwright WebKit26.6 passed capture, persistence/reload, two-tab/two-origin delivery, collector restart, source/session UI and production no-op tests. Actual authenticated HTTPS fixtures reject unauthenticated clients and cross-session handles in all three engines. WebKit engine evidence does not establish installed Safari or physical mobile browser behavior.

The Chrome IndexedDB storage-only capacity gate retained 1,000,000 minimal canonical event_id lines (30.9 MB) in 18.83 seconds using 500-event flush groups on an Apple M4 Pro with 51.5 GB RAM. Metadata-only reopen took 1.9 ms; reading the final 100 events took 47 ms; no historical lines were hydrated and no events were dropped. These results do not establish full-schema capture/collector throughput or mobile/power-loss durability. Reproduce with `node scripts/check-web-capacity.mjs`; exact evidence is in ignored artifacts.
