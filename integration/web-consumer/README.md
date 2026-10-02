# Independent browser consumer

Pin a source checkout and install `web-sdk/` as the private local package. No registry release exists. Resolve the host's `#logger` alias to `@http-sequence-logger/web/debug` only for development; production resolves to the default no-op. Keep debug setup and Node relay imports behind separate build aliases. The typed consumer [check.mts](check.mts) exercises the public API without the repository sample.

```js
// Host debug setup only.
import {createLogger, IndexedDBJournal, MemoryJournal, startJournalDelivery} from '#logger';
let journalId=crypto.randomUUID();
try { journalId=sessionStorage.getItem('customer-log-journal-v2')||journalId; } catch { /* Storage denial keeps a fresh page ID. */ }
const remember=()=>{try { sessionStorage.setItem('customer-log-journal-v2',journalId); } catch { /* Reload recovery unavailable. */ }};
remember();
let journal;
try {
  try { journal=await IndexedDBJournal.open({databaseName:'customer-logs-v2',journalId}); }
  catch (error) {
    if (!/Another writer/.test(error.message)) throw error;
    journalId=crypto.randomUUID();remember();
    journal=await IndexedDBJournal.open({databaseName:'customer-logs-v2',journalId});
  }
} catch { journal=new MemoryJournal();showDevelopmentStatus({state:'memory-only',error:'Persistence unavailable; export before closing.'}); }
const logger=createLogger({namespace:'customer.development',appId:'customer-web',sink:journal});
const delivery=startJournalDelivery(journal,{appId:'customer-web',onStatus:showDevelopmentStatus});
// Pass sessions/contexts through existing business Fetch/XHR/manual hooks.
// On teardown: delivery.stop(); await journal.close?.();
```

Mount `createNetworkLogRelay({origin:frontendOrigin})` in the host Node development server unconditionally when debug setup is enabled. It waits for `npm start`, reads the private active manifest automatically, and registers zero-event pages. Start the frontend before the collector, capture a session offline, start/restart the collector, and verify retained IDs arrive once in Devices and environments → Apps → Sessions. Open two tabs using different journal IDs and verify independent capture and source listing. Explicitly override private `connectionFile` to select another collector.

One live writer owns each journal; reload resumes after browser lock release, and transactional owner epochs fence stale ACKs. Duplicated tabs may inherit the same session-storage ID, so the setup above allocates a new journal when another owner already holds it. Storage denial falls back to a visibly memory-only journal. `flush()` is the persistence barrier, and `await journal.exportNDJSON()` reads retained event pages. Fallback memory capture is not durable. Display dropped/pending/storage-error status. Closing the browser stops foreground delivery until the page reopens. Adapt the [full sample lifecycle](../../web-sample/setup-debug.mjs) to the host's existing setup, teardown and diagnostic UI; keep its development setup out of shipping imports.

Reachable frontends require host-owned HTTPS and frontend session authentication: configure `reachable:true` and an `authorize(req)` callback that verifies the existing authenticated session and returns its opaque session ID. Never trust Host/Origin alone, expose collector credentials, or introduce browser-to-collector CORS. Validate actual mobile Safari/Chrome and the host's certificates/permissions separately.

From the contract repository run `npm run check:web-types`, `npm run check:web-release`, and `npm run check:web-browser`. Repeat release exclusion on the host shipping graph/assets/maps and exercise its actual business flows with production no-op logging. Repository browser checks do not establish a customer's integration or physical mobile browser behavior.
