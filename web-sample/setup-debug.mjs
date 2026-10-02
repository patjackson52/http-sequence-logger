import { createLogger, createFetchClient, MemoryJournal, IndexedDBJournal, uploadJournal, startJournalDelivery } from '#logger';
import { validateCapture } from '../shared/validate.mjs';
let journalId = crypto.randomUUID();
try { journalId = sessionStorage?.getItem('network-log-journal-v2') || journalId; } catch { /* Storage denial keeps a fresh page journal. */ }
function rememberJournal(id) { try { sessionStorage?.setItem('network-log-journal-v2', id); } catch { /* Reload recovery is unavailable; capture still works. */ } }
rememberJournal(journalId);
const options = { databaseName: 'http-sequence-logger-demo-v2', journalId };
const app = { owner: 'integrator', component: 'BrowserChecks', method: 'run' };
export async function setup(root) {
  root.innerHTML = `<section><h2>Development capture</h2><p>Sanitized events persist in this origin’s IndexedDB. Export a local NDJSON file, or deliver through the same-origin relay to your desktop viewer.</p><button id="download">Export NDJSON</button><button id="upload">Flush and upload</button><button id="checks">Run browser checks</button><button id="reopen">Reopen journal</button><pre id="capture-status" role="status"></pre><pre id="check-status" role="status"></pre></section>`;
  const status = root.querySelector('#capture-status'), checks = root.querySelector('#check-status');
  let journal, persistence = 'IndexedDB', diagnostics = [];
  try { journal = await IndexedDBJournal.open(options); }
  catch (error) {
    if (/Another writer/.test(error.message)) { options.journalId=crypto.randomUUID();rememberJournal(options.journalId);journal=await IndexedDBJournal.open(options); }
    else {journal = new MemoryJournal(); persistence = 'Memory fallback — IndexedDB unavailable';}
  }
  const buildLogger = () => createLogger({ namespace: 'sample.browser.auth', appId: 'browser-auth-sample', sink: journal, onDiagnostic: code => diagnostics.push(code) });
  let logger = buildLogger();
  const update = message => { status.textContent = `${message || 'Ready'}\n${persistence}\nOrigin: ${location.origin}\nDatabase: ${options.databaseName}\nJournal: ${options.journalId}\n${JSON.stringify(journal.stats)}\n${diagnostics.slice(-3).join('\n')}`; };
  let delivery;
  const startDelivery = () => { delivery?.stop(); delivery = startJournalDelivery(journal, {appId:'browser-auth-sample', onStatus:value=>update(value.error || (value.state==='ready'?'Ready and waiting for events':'Delivering'))}); };
  startDelivery();
  addEventListener('pagehide',()=>{delivery?.stop();journal.close?.().catch(()=>{});});
  const afterRun = async () => { try { await journal.flush(); update('Capture flushed. Export or upload when ready.'); } catch { update('Persistence failed. Memory export remains available.'); } };
  let busy = false;
  async function exclusive(fn) {
    if (busy) return; busy = true;
    const buttons = [...document.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
    try { await fn(); } catch (error) { update(`Action failed: ${error.message}`); }
    finally { busy = false; buttons.forEach(button => button.disabled = false); }
  }
  const action = (id, fn) => { root.querySelector(id).onclick = () => exclusive(fn); };
  action('#download', async () => {
    const text = await journal.exportNDJSON(); const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    const link = document.createElement('a'); link.href = url; link.download = 'browser-capture.ndjson'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); update('Export requested.');
  });
  action('#upload', async () => { const result = await uploadJournal(journal, {appId:"browser-auth-sample"}); update(`Delivered ${result.events} events in ${result.batches} batches. Repeating upload is safe.`); });
  async function reopen() {
    const before = await journal.exportNDJSON();
    if (!(journal instanceof IndexedDBJournal)) throw new Error('IndexedDB is unavailable');
    delivery?.stop(); await journal.close(); journal = await IndexedDBJournal.open(options); logger = buildLogger();
    if (await journal.exportNDJSON() !== before) throw new Error('Reopened journal differs');
    startDelivery(); update('Reopened journal with identical event IDs and bytes.');
  }
  action('#reopen', reopen);
  action('#checks', async () => {
    const evidence = [], session = logger.startSession({ name: 'Browser boundary checks', sessionId: 'web-boundary-checks' });
    const client = createFetchClient(session, { origin: { initiator: app, executor: app } });
    const ensure = (condition, message) => { if (!condition) throw new Error(message); evidence.push(`PASS ${message}`); };
    try {
      const badJson = await client.fetch('http://127.0.0.1:4181/invalid-json');
      let invalid = false; try { await client.readJson(badJson); } catch (e) { invalid = e instanceof SyntaxError; } ensure(invalid, 'JSON parsing failure preserves HTTP completion');
      const controller = new AbortController(); controller.abort(); let aborted = false;
      try { await client.fetch('http://127.0.0.1:4181/slow', { signal: controller.signal }); } catch (e) { aborted = e.name === 'AbortError'; } ensure(aborted, 'Abort preserves native error');
      const opaque = await client.fetch('http://127.0.0.1:4182/opaque', { mode: 'no-cors' }); ensure(opaque.type === 'opaque' && opaque.status === 0, 'Opaque response remains opaque');
      const unread = await client.fetch('http://127.0.0.1:4181/unread'); ensure(!unread.bodyUsed, 'Adapter leaves unread response untouched');
      await unread.body.cancel(); client.exchangeFor(unread).stopObservation('component_disposed');
      const promise = Promise.resolve('identity'); ensure(session.invokeHandler({ name: 'Immediate Promise return', origin: app, caller: app }, () => promise) === promise, 'Synchronous handler preserves Promise identity');
      const exchange = session.startRequest(() => ({ method: 'GET', url: 'http://127.0.0.1:4182/manual?token=PRIVATE_BROWSER_SENTINEL', origin: { initiator: app, executor: app } }));
      try {
        const response = await fetch('http://127.0.0.1:4182/manual?token=PRIVATE_BROWSER_SENTINEL');
        exchange.requestBody(() => ({ notApplicable: true })); exchange.responseHeaders(() => ({ status: response.status, url: response.url, headers: response.headers }));
        const data = await response.text(); exchange.responseBody(() => ({ data, mediaType: response.headers.get('content-type') })); exchange.complete(); ensure(response.ok, 'Custom client manual recording works');
      } catch (error) { exchange.fail(error); throw error; }
      session.end(); await journal.flush();
      const capture = validateCapture(await journal.exportNDJSON()); ensure(capture.valid, `Capture validates (${capture.summary.events} events)`);
      ensure(!(await journal.exportNDJSON()).includes('PRIVATE_BROWSER_SENTINEL'), 'Query secrets are removed before persistence');
      await reopen(); evidence.push('PASS IndexedDB reload preserves capture');
      checks.textContent = evidence.join('\n');
    } catch (error) { checks.textContent = evidence.join('\n') + `\nFAIL ${error.message}`; throw error; }
    finally { session.end(); await afterRun(); }
  });
  update(); return { get logger() { return logger; }, afterRun, exclusive };
}
