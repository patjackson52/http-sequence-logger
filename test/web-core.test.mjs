import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../web-sdk/src/recorder.mjs';
import { noOpLogger, createFetchClient } from '../web-sdk/src/api.mjs';
import { validateCapture } from '../shared/validate.mjs';
const app = { owner: 'integrator', component: 'App', method: 'handler' }, sdk = { owner: 'sdk', component: 'Auth', method: 'signIn' };
const origin = { initiator: sdk, executor: app };
function setup(options = {}) {
  const lines = [], diagnostics = [];
  const logger = createLogger({ namespace: 'test.web', appId: 'test', sink: { append: line => lines.push(line) }, onDiagnostic: code => diagnostics.push(code), ...options });
  return { logger, session: logger.startSession({ sessionId: 'existing', name: 'Test' }), lines, diagnostics, events: () => lines.map(JSON.parse), validate: () => { const result = validateCapture(lines.join('')); assert.deepEqual(result.errors, []); return result; } };
}
function request(session, extra = {}) { return session.startRequest(() => ({ method: 'POST', url: 'https://one.example/login', origin, ...extra })); }
test('manual browser capture, supplied sessions, awaited handlers and complete HTTP validate', async () => {
  const s = setup(); const op = s.session.startOperation({ name: 'Sign in', origin: sdk });
  const result = await s.session.invokeAsyncHandler({ name: 'App challenge', origin: app, caller: sdk, parent: op.context }, async parent => {
    const http = request(s.session, { parent });
    http.requestBody(() => ({ data: '{"password":"SENTINEL_PRIVATE_VALUE","name":"demo"}', mediaType: 'application/json' }));
    http.responseHeaders(() => ({ status: 200, url: 'https://two.example/profile', headers: { 'Content-Type': 'application/json' } }));
    http.responseBody(() => ({ data: '{"ok":true}', mediaType: 'application/json' }));
    await Promise.resolve(); http.complete(); return 42;
  });
  assert.equal(result, 42); op.end(); s.session.end(); const resultCapture = s.validate(); assert.equal(resultCapture.summary.handler_calls, 1);
  assert.equal(s.events()[0].schema_version, '1.3'); assert.equal(s.events()[0].data.producer.platform, 'web');
  assert.ok(!s.lines.join('').includes('SENTINEL_PRIVATE_VALUE')); assert.equal(s.events().find(e => e.data.invocation)?.data.invocation.dispatch, 'awaited');
  const second = s.logger.startSession({ sessionId: 'existing' }); second.end(); assert.notEqual(second.recordingId, s.session.recordingId); assert.equal(s.validate().summary.sessions, 1);
});
test('synchronous handlers preserve Promise and throw identity; async preserves rejection identity', async () => {
  const s = setup(); const options = { name: 'Handler', origin: app, caller: sdk }; const promise = Promise.resolve('value'); let calls = 0;
  assert.equal(s.session.invokeHandler(options, () => { calls++; return promise; }), promise); assert.equal(calls, 1);
  const error = { name: 'contains-SENTINEL_PRIVATE_VALUE', message: 'SENTINEL_PRIVATE_VALUE' };
  assert.throws(() => s.session.invokeHandler(options, () => { throw error; }), e => e === error);
  await assert.rejects(s.session.invokeAsyncHandler(options, async () => { throw error; }), e => e === error);
  s.session.end(); s.validate(); assert.ok(!s.lines.join('').includes('contains-SENTINEL_PRIVATE_VALUE'));
});
test('shutdown stops outstanding HTTP and handler without inventing return; terminals are idempotent', () => {
  const s = setup(); const op = s.session.startOperation({ name: 'SDK', origin: sdk }); const handler = s.session.startHandler({ name: 'Handler', origin: app, caller: sdk, parent: op.context, dispatch: 'awaited' });
  const exchange = request(s.session, { parent: handler.context }); exchange.responseHeaders(() => ({ status: 503 }));
  s.session.end('stopped'); exchange.complete(); handler.returned(); s.session.end();
  const result = s.validate(); assert.equal(result.summary.unknown_outcomes, 1); assert.equal(result.summary.unknown_handler_outcomes, 1);
});
test('policy redacts duplicates, URL references, nested JSON, binary limits before storing', () => {
  const s = setup({ policy: { bodyLimitBytes: 12 } }); const h = request(s.session, { url: 'https://user:SENTINEL_PRIVATE_VALUE@one.example/path?token=SENTINEL_PRIVATE_VALUE&token=SENTINEL_PRIVATE_VALUE&a=1&a=2#SENTINEL_PRIVATE_VALUE', headers: [['Authorization', 'SENTINEL_PRIVATE_VALUE'], ['Location', '/next?code=SENTINEL_PRIVATE_VALUE']] });
  h.requestBody(() => ({ data: '{"nested":{"access_token":"SENTINEL_PRIVATE_VALUE"},"a":true}', mediaType: 'application/json' })); h.responseHeaders(() => ({ status: 200 })); h.responseBody(() => ({ data: 'SENTINEL_PRIVATE_VALUE', mediaType: 'text/plain' })); h.complete(); s.session.end(); s.validate();
  const all = s.lines.join(''); assert.ok(!all.includes('SENTINEL_PRIVATE_VALUE')); const body = s.events().find(e => e.data.direction === 'request').data.body; assert.equal(body.redacted, true); assert.equal(body.truncated, true); assert.equal(body.stored_bytes, 12);
  assert.equal(new URL(s.events()[1].data.request.url).searchParams.getAll('a').length, 2);
});
test('unredacted JSON is byte exact; malformed JSON and overly deep values withheld', () => {
  for (const data of [' {"ok":true} ', '{"token":', '['.repeat(70) + '0' + ']'.repeat(70)]) {
    const s = setup(); const h = request(s.session); h.requestBody(() => ({ data, mediaType: 'application/json' })); h.responseHeaders(() => ({ status: 204 })); h.complete(); s.session.end(); s.validate();
    const body = s.events().find(e => e.data.direction === 'request').data.body;
    if (data === ' {"ok":true} ') assert.equal(body.content.data, data); else assert.equal(body.content, null);
  }
});
test('capture failures, storage failures and invalid parent do not escape business code', () => {
  const s = setup(); const h = request(s.session); h.requestBody(() => { throw new Error('SENTINEL_PRIVATE_VALUE'); }); h.responseHeaders(() => ({ status: 200 })); h.fail(new Error('SENTINEL_PRIVATE_VALUE'), 'read');
  const other = s.logger.startSession(); request(other, { parent: h.context }).complete(); other.end(); s.session.end(); s.validate(); assert.ok(s.diagnostics.includes('capture_failed'));
  const broken = setup({ sink: { append() { throw new Error('disk'); } } }); assert.doesNotThrow(() => request(broken.session).complete()); broken.session.end();
});
test('no-op does no metadata work and preserves requests, reads and handler behavior', async () => {
  const session = noOpLogger.startSession(); const hostile = () => { throw new Error('must not evaluate'); };
  session.startRequest(hostile).requestBody(hostile); session.startOperation(hostile); session.startHandler(hostile);
  let count = 0; const value = {}; assert.equal(session.invokeHandler({}, () => { count++; return value; }), value); assert.equal(count, 1);
  const response = new Response('{"ok":true}'); const args = []; const client = createFetchClient(session, { fetchImpl: async (...v) => { args.push(v); return response; } });
  const init = { headers: { A: 'B' } }; assert.equal(await client.fetch('https://one.example', init), response); assert.equal(args[0][1], init); assert.deepEqual(await client.readJson(response), { ok: true });
});
test('web and awaited vocabulary require the sole current schema1.3', () => {
  const s = setup(); s.session.invokeHandler({ name: 'Handler', origin: app, caller: sdk }, () => {}); s.session.end(); s.validate();
  for (const version of ['1.0', '1.1']) assert.equal(validateCapture(s.lines.map(line => JSON.stringify({ ...JSON.parse(line), schema_version: version })).join('\n') + '\n').valid, false);
});
test('BOM bytes and unaffected URL escaping survive capture; relative Location authority retained', () => {
  const s = setup(); const h = request(s.session, { url: 'https://one.example/?keep=a%20b&token=PRIVATE&keep=%7e', headers: { Location: '//auth.example/next?keep=%20&code=PRIVATE' } });
  h.requestBody(() => ({ data: new TextEncoder().encode('\uFEFF{"ok":true}'), mediaType: 'application/json' })); h.responseHeaders(() => ({ status: 204 })); h.complete(); s.session.end(); s.validate();
  const event = s.events()[1]; assert.ok(event.data.request.url.endsWith('?keep=a%20b&token=%5BREDACTED%5D&keep=%7e')); assert.equal(event.data.request.headers.entries[0].value, '//auth.example/next?keep=%20&code=%5BREDACTED%5D');
});
test('invalid session IDs fail open without rewriting identity or evaluating metadata', () => {
  const s = setup(); const invalid = s.logger.startSession({ sessionId: 'x'.repeat(513) }); assert.equal(invalid.enabled, false); invalid.startRequest(() => { throw new Error(); });
  s.session.end(); s.validate(); assert.equal(s.events().filter(e => e.event_type === 'session.started').length, 1);
});
test('aggregate header capture fits transfer bounds and error name getters cannot bypass sanitization', () => {
  const s = setup(); const h = request(s.session, { headers: Array.from({ length: 128 }, (_, i) => [`x-test-${i}`, '界'.repeat(8192)]) });
  let reads = 0; h.fail({ get name() { return ++reads === 1 ? 'TypeError' : 'PRIVATE_ERROR_SENTINEL'; } }); s.session.end(); s.validate();
  assert.ok(s.lines.every(line => Buffer.byteLength(line) < 1024 * 1024)); assert.equal(s.events()[1].data.request.headers.reason, 'header_bytes_limit'); assert.ok(!s.lines.join('').includes('PRIVATE_ERROR_SENTINEL')); assert.equal(reads, 1);
});
