// Compile against both source entry points without importing the sample.
import { createLogger, MemoryJournal, createFetchClient, observeXHR, IndexedDBJournal, uploadJournal } from '../../web-sdk/src/index.mjs';
import { noOpLogger, type Logger, type Actor } from '../../web-sdk/src/api.mjs';
const actor: Actor = { owner: 'integrator', component: 'Customer' };
const journal = new MemoryJournal();
const logger: Logger = createLogger({ namespace: 'customer.web', appId: 'customer', sink: journal });
async function useLogger(value: Logger) {
  const session = value.startSession({ sessionId: 'app-session' });
  const operation = session.startOperation({ name: 'Customer operation', origin: actor });
  await session.invokeAsyncHandler({ name: 'Handler', origin: actor, caller: actor, parent: operation.context }, async parent => {
    const client = createFetchClient(session, { origin: { initiator: actor, executor: actor }, parent });
    const response = await client.fetch('https://example.test/');
    const data = await client.readJson<{ ok: boolean }>(response);
    const xhr = new XMLHttpRequest(); xhr.open('GET', 'https://example.test/');
    const observer = observeXHR(session, xhr, () => ({ method: 'GET', url: 'https://example.test/', origin: { initiator: actor, executor: actor }, body: null, parent }));
    xhr.send(); observer.dispose(); return data.ok;
  });
  operation.end(); session.end();
}
void useLogger; void logger; void noOpLogger;
async function persist() { const db = await IndexedDBJournal.open({ journalId: 'customer-dev-capture' }); await db.flush(); await uploadJournal(db); await db.close(); }
void persist;
import { createNetworkLogRelay } from '../../web-sdk/dev-relay.mjs';
const middleware = createNetworkLogRelay({ connectionFile: '/private/connection.json', origin: 'http://127.0.0.1:4180' });
void middleware;
