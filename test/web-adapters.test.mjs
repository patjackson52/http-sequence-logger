import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchClient, observeXHR } from '../web-sdk/src/adapters.mjs';
import { createLogger } from '../web-sdk/src/recorder.mjs';
import { MemoryJournal } from '../web-sdk/src/storage.mjs';
import { validateCapture } from '../shared/validate.mjs';

// A synchronous fail-open recorder double keeps adapter tests independent of
// storage/schema machinery; recorder integration is verified separately.
function recording({ enabled = true } = {}) {
  const events = [];
  const exchanges = [];
  const session = {
    enabled,
    startRequest(supplier) {
      let terminal = false;
      const exchange = { context: { span_id: String(exchanges.length) } };
      const remember = (kind, value) => {
        if (terminal) return;
        try { events.push({ kind, value: typeof value === 'function' ? value() : value }); } catch { /* capture failures are isolated */ }
      };
      for (const kind of ['responseHeaders', 'requestBody', 'responseBody']) exchange[kind] = (value) => remember(kind, value);
      for (const kind of ['complete', 'fail', 'timeout', 'cancel', 'stopObservation']) exchange[kind] = (value, stage) => {
        remember(kind, { error: value, stage });
        terminal = true;
      };
      remember('start', supplier);
      exchanges.push(exchange);
      return exchange;
    },
  };
  return { session, events, exchanges, of: (kind) => events.filter((event) => event.kind === kind) };
}

const origin = { initiator: { owner: 'integrator', component: 'App' }, executor: { owner: 'sdk', component: 'AuthSDK' } };

test('Fetch preserves original input/init and Response without cloning or reading until asked', async () => {
  const log = recording();
  const input = new Request('https://example.test/start');
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  const response = new Response('{"accepted":true}', { status: 201, headers: { 'content-type': 'application/json' } });
  response.clone = () => { throw new Error('must not clone'); };
  const calls = [];
  const client = createFetchClient(log.session, { origin, fetchImpl: (...args) => { calls.push(args); return Promise.resolve(response); } });
  assert.equal(await client.fetch(input, init), response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], input);
  assert.equal(calls[0][1], init);
  assert.equal(response.bodyUsed, false);
  assert.equal(log.of('complete').length, 0);
  assert.equal(log.of('start')[0].value.adapter, 'browser.fetch');
  assert.equal(log.of('start')[0].value.origin, origin);
  assert.equal(log.of('requestBody')[0].value.data, init.body);
  assert.equal(log.of('responseHeaders')[0].value.reason, 'browser_filtered_headers');
  assert.deepEqual(await client.readJson(response), { accepted: true });
  assert.equal(log.of('responseBody')[0].value.data, '{"accepted":true}');
  assert.equal(log.of('complete').length, 1);
  assert.equal(client.exchangeFor(response), log.exchanges[0]);
});

test('Fetch marks Request bodies and unsupported init bodies unavailable without consuming them', async () => {
  for (const source of ['request', 'form', 'stream']) {
    const log = recording();
    const request = new Request('https://example.test/', { method: 'POST', body: '{"secret":"value"}' });
    request.clone = () => { throw new Error('must not clone'); };
    const init = source === 'request' ? undefined : { method: 'POST', body: source === 'form' ? new FormData() : new ReadableStream() };
    const client = createFetchClient(log.session, { fetchImpl: async () => new Response('ok') });
    await client.fetch(source === 'request' ? request : 'https://example.test/', init);
    assert.equal(request.bodyUsed, false);
    assert.equal(log.of('requestBody')[0].value.reason, 'request_body_not_observed');
    assert.equal(log.of('requestBody')[0].value.notApplicable, undefined);
  }
});

test('Fetch safe empty request inference and ArrayBuffer body values preserve bytes', async () => {
  const log = recording();
  const response = new Response(new Uint8Array([0, 1, 255]));
  const client = createFetchClient(log.session, { fetchImpl: async () => response });
  await client.fetch('https://example.test/');
  assert.equal(log.of('requestBody')[0].value.notApplicable, true);
  const result = await client.readArrayBuffer(response);
  assert.deepEqual([...new Uint8Array(result)], [0, 1, 255]);
  assert.equal(log.of('responseBody')[0].value.data, result);
});

test('Fetch invalid JSON is a parsing error after successful HTTP EOF', async () => {
  const log = recording();
  const response = new Response('not JSON');
  const client = createFetchClient(log.session, { fetchImpl: async () => response });
  await client.fetch('https://example.test/');
  await assert.rejects(client.readJson(response), SyntaxError);
  assert.equal(log.of('complete').length, 1);
  assert.equal(log.of('fail').length, 0);
  assert.equal(log.of('responseBody')[0].value.data, 'not JSON');
});

test('Fetch rejection and late body failure preserve the identical exception', async () => {
  for (const atBody of [false, true]) {
    const log = recording();
    const failure = new TypeError('sentinel');
    const response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    const client = createFetchClient(log.session, { fetchImpl: () => atBody ? Promise.resolve(response) : Promise.reject(failure) });
    if (atBody) await client.fetch('https://example.test/');
    await assert.rejects(atBody ? client.readText(response) : client.fetch('https://example.test/'), (error) => error === failure);
    assert.equal(log.of('complete').length, 0);
    assert.equal(log.of('fail')[0].value.error, failure);
    assert.equal(log.of('fail')[0].value.stage, atBody ? 'read' : 'unknown');
  }
});

test('Fetch abort and deadline signals classify arbitrary abort reasons without changing them', async () => {
  for (const timedOut of [false, true]) {
    const log = recording();
    const reason = timedOut ? new DOMException('deadline', 'TimeoutError') : { custom: 'caller reason' };
    const controller = new AbortController();
    controller.abort(reason);
    const client = createFetchClient(log.session, { fetchImpl: () => Promise.reject(reason) });
    await assert.rejects(client.fetch('https://example.test/', { signal: controller.signal }), (error) => error === reason);
    assert.equal(log.of(timedOut ? 'timeout' : 'cancel').length, 1);
    assert.equal(log.of('fail').length, 0);
  }
});

test('Fetch opaque status zero stays unknown; exposed null body completes without inventing a payload', async () => {
  for (const opaque of [false, true]) {
    const log = recording();
    const response = opaque ? { status: 0, type: 'opaque', body: null } : new Response(null, { status: 204 });
    const client = createFetchClient(log.session, { fetchImpl: async () => response });
    assert.equal(await client.fetch('https://example.test/'), response);
    assert.equal(log.of('complete').length, opaque ? 0 : 1);
    assert.equal(log.of('responseHeaders').length, opaque ? 0 : 1);
    assert.equal(log.of('stopObservation').length, opaque ? 1 : 0);
  }
});

test('Fetch reading an already consumed body is unknown rather than a fabricated network failure', async () => {
  const log = recording();
  const response = new Response('already consumed');
  const client = createFetchClient(log.session, { fetchImpl: async () => response });
  await client.fetch('https://example.test/');
  await response.text();
  await assert.rejects(client.readText(response), TypeError);
  assert.equal(log.of('fail').length, 0);
  assert.equal(log.of('stopObservation').length, 1);
});

test('Fetch metadata failure never replaces business requests or results; disabled mode does no metadata work', async () => {
  for (const enabled of [false, true]) {
    const log = recording({ enabled });
    let metadataReads = 0;
    let calls = 0;
    const metadata = { get name() { metadataReads++; throw new Error('capture getter'); } };
    const response = new Response('result');
    const client = createFetchClient(log.session, { fetchImpl: async () => { calls++; return response; } });
    assert.equal(await client.fetch('https://example.test/', undefined, metadata), response);
    assert.equal(await client.readText(response), 'result');
    assert.equal(calls, 1);
    assert.equal(metadataReads, enabled ? 1 : 0);
    if (!enabled) assert.equal(log.events.length, 0);
  }
});

class FakeXHR extends EventTarget {
  readyState = 1;
  status = 0;
  statusText = '';
  responseType = '';
  responseText = '';
  responseURL = '';
  response = null;
  listeners = new Map();
  get upload() { throw new Error('upload must never be accessed'); }
  getAllResponseHeaders() { return 'content-type: application/json\r\nx-debug: yes\r\n'; }
  getResponseHeader() { return 'application/json'; }
  addEventListener(type, fn, options) { super.addEventListener(type, fn, options); this.listeners.set(fn, type); }
  removeEventListener(type, fn, options) { super.removeEventListener(type, fn, options); this.listeners.delete(fn); }
  headers(status = 200) { this.readyState = 2; this.status = status; this.statusText = 'Observed'; this.responseURL = 'https://example.test/final'; this.dispatchEvent(new Event('readystatechange')); }
  terminal(type = 'load') { this.readyState = 4; this.dispatchEvent(new Event(type)); }
}

const xhrMetadata = () => ({ method: 'POST', url: 'https://example.test/', headers: { 'content-type': 'application/json' }, body: '{}', origin });

test('XHR observers preserve app listeners, use filtered headers, and finish both HTTP 200 and 500 at load', () => {
  for (const status of [200, 500]) {
    const log = recording();
    const xhr = new FakeXHR();
    let appCalls = 0;
    const appListener = () => { appCalls++; };
    xhr.addEventListener('load', appListener);
    const onload = () => {};
    xhr.onload = onload;
    const observation = observeXHR(log.session, xhr, xhrMetadata);
    xhr.headers(status);
    xhr.responseText = '{"value":1}';
    xhr.terminal();
    assert.equal(appCalls, 1);
    assert.equal(xhr.onload, onload);
    assert.deepEqual([...xhr.listeners.keys()], [appListener]);
    assert.equal(log.of('responseHeaders')[0].value.status, status);
    assert.deepEqual(log.of('responseHeaders')[0].value.headers, [['content-type', 'application/json'], ['x-debug', 'yes']]);
    assert.equal(log.of('responseBody')[0].value.data, xhr.responseText);
    assert.equal(log.of('complete').length, 1);
    assert.equal(log.of('fail').length, 0);
    assert.equal(observation.exchange, log.exchanges[0]);
    observation.dispose();
    assert.equal(log.of('stopObservation').length, 0);
  }
});

test('XHR distinct error/abort/timeout terminals detach observers and preserve known headers', () => {
  for (const [event, terminal] of [['error', 'fail'], ['abort', 'cancel'], ['timeout', 'timeout']]) {
    const log = recording();
    const xhr = new FakeXHR();
    observeXHR(log.session, xhr, xhrMetadata);
    xhr.headers();
    xhr.status = 0;
    xhr.terminal(event);
    assert.equal(log.of('responseHeaders').length, 1);
    assert.equal(log.of(terminal).length, 1);
    assert.equal(log.of('complete').length, 0);
    assert.equal(xhr.listeners.size, 0);
  }
});

test('XHR unsupported parsed/document/blob bodies are unavailable; ArrayBuffer is retained', () => {
  for (const type of ['json', 'document', 'blob', 'arraybuffer']) {
    const log = recording();
    const xhr = new FakeXHR();
    observeXHR(log.session, xhr, xhrMetadata);
    xhr.responseType = type;
    xhr.response = type === 'arraybuffer' ? new Uint8Array([1, 2]).buffer : { secret: 'not canonical bytes' };
    xhr.headers();
    xhr.terminal();
    const body = log.of('responseBody')[0].value;
    if (type === 'arraybuffer') assert.equal(body.data, xhr.response);
    else { assert.equal(body.data, undefined); assert.equal(body.reason, 'xhr_response_type_not_captured'); }
    assert.equal(log.of('complete').length, 1);
  }
});

test('XHR explicit disposal is unknown, omitted request body is unknown, disabled observer is inert', () => {
  for (const enabled of [false, true]) {
    const log = recording({ enabled });
    const xhr = new FakeXHR();
    let reads = 0;
    const observation = observeXHR(log.session, xhr, () => { reads++; return { method: 'GET', url: 'https://example.test/', origin }; });
    observation.dispose();
    observation.dispose();
    xhr.headers();
    xhr.terminal();
    assert.equal(reads, enabled ? 1 : 0);
    assert.equal(xhr.listeners.size, 0);
    assert.equal(log.of('complete').length, 0);
    assert.equal(log.of('stopObservation').length, enabled ? 1 : 0);
    if (enabled) assert.equal(log.of('requestBody')[0].value.reason, 'request_body_not_observed');
  }
});

test('adapters integrate with recorder, async handler parenting, redaction, and the event validator', async () => {
  const sink = new MemoryJournal();
  const session = createLogger({ namespace: 'adapter-tests', appId: 'test.app', sink }).startSession({ sessionId: 'reused-id' });
  const sdk = { owner: 'sdk', component: 'AuthSDK', method: 'authenticate' };
  const app = { owner: 'integrator', component: 'Application', method: 'handler' };
  const operation = session.startOperation({ name: 'authenticate', origin: sdk });
  const value = await session.invokeAsyncHandler({ name: 'handler', origin: app, caller: sdk, parent: operation.context }, async (parent) => {
    const client = createFetchClient(session, { parent, origin: { initiator: sdk, executor: app }, fetchImpl: async () => new Response('{"token":"SECRET","ok":true}', { headers: { 'content-type': 'application/json' } }) });
    const response = await client.fetch('https://auth.example.test/token?code=SECRET');
    const data = await client.readJson(response);
    const xhr = new FakeXHR();
    observeXHR(session, xhr, () => ({ ...xhrMetadata(), parent, origin: { initiator: sdk, executor: app } }));
    xhr.headers(500);
    xhr.responseText = '{"error":"example"}';
    xhr.terminal();
    // Unread bodies remain unknown on session end, rather than success at headers.
    await client.fetch('https://unread.example.test/');
    return data;
  });
  operation.end();
  session.end();
  assert.deepEqual(value, { token: 'SECRET', ok: true });
  const capture = sink.exportNDJSON();
  assert.equal(capture.includes('SECRET'), false);
  const validation = validateCapture(capture);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
  const terminal = validation.events.filter((event) => event.event_type === 'http.ended');
  assert.deepEqual(terminal.map((event) => event.data.outcome), ['success', 'http_error', 'unknown']);
  assert.equal(validation.events.find((event) => event.event_type === 'operation.started' && event.data.invocation).data.invocation.dispatch, 'awaited');
});

test('allowlisted Fetch sends its outbound span context and preserves foreign requests and host trace context', async () => {
  const lines=[];
  const logger=createLogger({namespace:'propagation/test',appId:'test',sink:{append:line=>lines.push(line)},propagationOrigins:['https://first.test']});
  const session=logger.startSession();const calls=[];
  const client=createFetchClient(session,{origin,fetchImpl:async(input,init)=>{calls.push({input,init});return new Response(null,{status:204});}});
  const init={method:'POST',body:'payload',headers:{'X-App':'retained'}};
  await client.fetch('https://first.test/operation',init);
  const request=lines.map(JSON.parse).find(e=>e.event_type==='http.request.started');
  assert.equal(calls[0].init.headers.get('traceparent'),`00-${request.context.trace_id}-${request.context.span_id}-01`);
  assert.equal(calls[0].init.body,'payload');assert.equal(calls[0].init.headers.get('x-app'),'retained');assert.equal(init.headers.traceparent,undefined);
  await client.fetch('https://foreign.test/operation',init);assert.equal(calls[1].init,init);
  await client.fetch('https://first.test/__networklog/ingest',init);assert.equal(calls[2].init,init);
  const traceparent='00-11111111111111111111111111111111-2222222222222222-01';const hostInit={headers:{traceparent}};
  const operation=session.startOperation({name:'Host operation',origin:{owner:'integrator',component:'Host'}});
  await client.fetch(new Request('https://first.test/host',{method:'POST',body:'stream'}),hostInit,{parent:operation.context});operation.end();
  assert.equal(calls[3].init,hostInit);
  const host=lines.map(JSON.parse).filter(e=>e.event_type==='http.request.started').at(-1);assert.equal(host.context.trace_id,'11111111111111111111111111111111');assert.equal(host.context.span_id,'2222222222222222');assert.equal(host.context.parent_span_id,null);assert.equal(host.context.parent_scope,'none');
  session.end();assert.equal(validateCapture(lines.join('')).valid,true);
});
