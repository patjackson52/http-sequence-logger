import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importFiles } from '../viewer/src/model.mjs';
import { exportHTTP, requestSources } from '../viewer/src/export-http.mjs';

const fixture = name => readFileSync(new URL(`../examples/${name}.ndjson`, import.meta.url), 'utf8');
const load = (name = 'success') => importFiles([{ name: `${name}.ndjson`, text: fixture(name) }]).sessions[0];
const exportOne = session => exportHTTP(session, requestSources(session)[0].id);
const record = (id, producer, count = 1) => {
  const base = structuredClone(load().recordings[0]);
  base.id = id; base.producer = producer; base.start.data.producer = producer;
  base.exchanges = Array.from({ length: count }, (_, index) => ({ ...structuredClone(base.exchanges[0]), recordingId: id, start: { ...base.exchanges[0].start, sequence: index + 1 } }));
  return base;
};
const sessionWith = recordings => ({ ...load(), recordings });
const client = { platform: 'android', app_id: 'example.app' };
const backend = { platform: 'server', app_id: 'backend.app', service_name: 'Orders', environment: 'dev', runtime: 'node' };

test('common request syntax keeps method, literal URL, repeated headers and exact UTF-8 body', () => {
  const session = load(), exchange = session.exchanges[0];
  exchange.request.headers.entries.push({ name: 'X-Repeat', value: 'one', redacted: false }, { name: 'X-Repeat', value: 'two', redacted: false });
  exchange.requestBody.content.data = '  {"array":[1,2]}\r\n  \r\n';
  const exported = exportOne(session);
  assert.equal(exported.requestCount, 1);
  assert.equal(exported.observationCount, 1);
  assert.match(exported.filename, /\.http$/);
  assert.ok(exported.text.endsWith('POST https://api.example/verify?tag=mobile&tag=checkout\nContent-Type: application/json\nAuthorization: [REDACTED]\nX-Repeat: one\nX-Repeat: two\n\n  {"array":[1,2]}\r\n  \r\n\n'));
  assert.match(exported.text, /"availability":"partial"/);
  assert.match(exported.text, /"redacted":true/);
  assert.match(exported.text, /success.ndjson/);
  assert.match(exported.text, /"event_type":"http.response.headers"/);
  assert.match(exported.text, /Set-Cookie/);
  assert.equal(exported.text.indexOf('Set-Cookie') < exported.text.indexOf('\nPOST https://'), true);
});

test('app and SDK requests group by confirmed client identity, not executor or origin', () => {
  const app = record('app', client), sdk = record('sdk', client), otherDevice = record('device-2', client);
  app.exchanges[0].owner = 'integrator'; sdk.exchanges[0].owner = 'sdk';
  const sources = [
    { source_id: 'app-source', platform: 'android', environment_id: 'phone', app_id: 'example.app', installation_id: 'install' },
    { source_id: 'sdk-source', platform: 'android', environment_id: 'phone', app_id: 'example.app', installation_id: 'install' },
    { source_id: 'other-source', platform: 'android', environment_id: 'phone-2', app_id: 'example.app', installation_id: 'install' },
  ];
  const options = { sources, recordingSources: { app: 'app-source', sdk: 'sdk-source', 'device-2': 'other-source' } };
  const session = sessionWith([app, sdk, otherDevice]), groups = requestSources(session, options);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].requestCount, 2);
  assert.deepEqual(groups[0].recordings.map(r => r.id), ['app', 'sdk']);
  assert.match(groups[0].label, /App \+ SDK/);
  const exported = exportHTTP(session, groups[0].id, options);
  assert.equal(exported.requestCount, 2);
  assert.equal(exported.text.includes('"device-2"'), false);
  assert.equal(requestSources(session, options)[0].id, groups[0].id);
});

test('unknown imported device identity remains a separate recording even for equal producers', () => {
  const groups = requestSources(sessionWith([record('first', client), record('second', client)]));
  assert.equal(groups.length, 2);
  assert.match(groups[0].label, /source identity unavailable/);
  assert.notEqual(groups[0].id, groups[1].id);
});

test('imported backend invocation recordings group by explicit service, environment and runtime', () => {
  const groups = requestSources(sessionWith([record('first', backend), record('second', backend), record('prod', { ...backend, environment: 'prod' }), record('cloud', { ...backend, runtime: 'cloudflare' }), record('billing', { ...backend, service_name: 'Billing' })]));
  assert.equal(groups.length, 4);
  assert.equal(groups[0].requestCount, 2);
  assert.match(groups[0].label, /Backend · Orders · dev · node/);
});

test('known backend source identity disambiguates identical producer metadata; missing registry uses source ID', () => {
  const session = sessionWith([record('first', backend), record('second', backend)]);
  const options = { sources: [{ source_id: 'one', platform: 'server', environment_id: 'dev', app_id: 'backend.app', installation_id: 'shared' }, { source_id: 'two', platform: 'server', environment_id: 'dev', app_id: 'backend.app', installation_id: 'shared' }], recordingSources: { first: 'one', second: 'two' } };
  assert.equal(requestSources(session, options).length, 2);
  assert.equal(requestSources(session, { recordingSources: options.recordingSources }).length, 2);
});

test('one live collection adapter keeps distinct backend service/environment/runtime identities separate', () => {
  const session = sessionWith([record('orders', backend), record('billing', { ...backend, service_name: 'Billing' }), record('prod', { ...backend, environment: 'prod' }), record('cloudflare', { ...backend, runtime: 'cloudflare' })]);
  const options = { sources: [{ source_id: 'adapter', platform: 'server', environment_id: 'dev', app_id: 'backend.app', installation_id: 'shared' }], recordingSources: Object.fromEntries(session.recordings.map(r => [r.id, 'adapter'])) };
  const groups = requestSources(session, options);
  assert.equal(groups.length, 4);
  assert.equal(new Set(groups.map(group => group.label)).size, 4);
});

test('optional request target, configured method and subsequent body observations survive export', () => {
  const session = load(), exchange = session.exchanges[0];
  exchange.request.configured_method = 'HEAD'; exchange.request.request_target = { value: '*', source: 'observed', redacted: false };
  const bodyEvent = structuredClone(exchange.rawEvents.find(e => e.event_type === 'http.body.captured' && e.data.direction === 'request'));
  bodyEvent.event_id = 'another-body'; bodyEvent.data.body.content.data = 'a second observation'; exchange.rawEvents.push(bodyEvent);
  const { text } = exportOne(session);
  assert.match(text, /"configured_method":"HEAD"/);
  assert.match(text, /"request_target":\{"value":"\*","source":"observed","redacted":false\}/);
  assert.match(text, /a second observation/);
});

test('recording first appearance and local sequence win over independent wall-clock timestamps', () => {
  const first = record('first', backend, 2), second = record('second', backend);
  first.exchanges[0].request.url = 'https://example.test/one';
  first.exchanges[1].request.url = 'https://example.test/two';
  second.exchanges[0].request.url = 'https://example.test/three';
  first.exchanges.reverse();
  first.startedAt = '2099-01-01T00:00:00Z'; second.startedAt = '1900-01-01T00:00:00Z';
  const { text } = exportOne(sessionWith([first, second]));
  assert.ok(text.indexOf('\nPOST https://example.test/one') < text.indexOf('\nPOST https://example.test/two'));
  assert.ok(text.indexOf('\nPOST https://example.test/two') < text.indexOf('\nPOST https://example.test/three'));
});

test('orphan observations retain response evidence and never invent method or request URL', () => {
  const events = fixture('success').trim().split('\n').map(JSON.parse).filter(e => e.event_type !== 'http.request.started');
  const session = importFiles([{ name: 'orphan.ndjson', text: events.map(JSON.stringify).join('\n') }]).sessions[0];
  const { text, requestCount, observationCount } = exportOne(session);
  assert.equal(requestCount, 0); assert.equal(observationCount, 1);
  assert.match(text, /Orphan HTTP observation/);
  assert.match(text, /"status_code":200/);
  assert.equal(/^(?:GET|POST) /m.test(text), false);
  assert.match(text, /no request invented/);
});

test('unavailable and base64 bodies explicitly retain limitations without inventing binary bytes', () => {
  const session = load(), exchange = session.exchanges[0];
  exchange.requestBody = { availability: 'captured', representation: 'wire', truncated: true, redacted: true, reason: 'capture_limit', content: { encoding: 'base64', data: 'AAH/Qg==' } };
  const { text } = exportOne(session);
  assert.match(text, /not inline; encoded data retained/);
  assert.match(text, /AAH\/Qg==/);
  assert.match(text, /"truncated":true,"redacted":true/);
  assert.ok(text.endsWith('Authorization: [REDACTED]\n\n\n'));
  exchange.requestBody = null;
  assert.match(exportOne(session).text, /Absence of a body observation does not establish an empty body/);
});

test('captured truncated/redacted UTF-8 stays literal with capture limitation comments', () => {
  const session = load(), exchange = session.exchanges[0];
  exchange.requestBody.truncated = true; exchange.requestBody.redacted = true;
  exchange.requestBody.content.data = '{"secret":"[REDACTED]","unfinished":';
  const { text } = exportOne(session);
  assert.match(text, /"truncated":true,"redacted":true/);
  assert.ok(text.endsWith('\n\n{"secret":"[REDACTED]","unfinished":\n'));
});

for (const attack of ['hello\n###\nDELETE https://attacker.test', '{{secret}}', '< /etc/passwd', '> {% evil() %}', '# @name injected', '@var = value', '\u0000binary']) {
  test(`body client syntax stays commented with exact recoverable data: ${JSON.stringify(attack)}`, () => {
    const session = load(); session.exchanges[0].requestBody.content.data = attack;
    const { text } = exportOne(session);
    assert.match(text, /Request disabled/);
    assert.equal(/^(?:POST|DELETE) /m.test(text), false);
    const captured = text.split('\n').find(line => line.startsWith('# Captured request body (commented): '));
    assert.equal(JSON.parse(captured.slice('# Captured request body (commented): '.length)).content.data, attack);
  });
}

test('multiline headers and templated URLs disable the entire request without dropping values', () => {
  const session = load(), exchange = session.exchanges[0];
  exchange.request.headers.entries.push({ name: 'X-Fake', value: 'a\n\n###\nDELETE https://attacker.test', redacted: false });
  let exported = exportOne(session);
  assert.match(exported.text, /Request disabled/);
  assert.equal(/^POST /m.test(exported.text), false);
  let captured = exported.text.split('\n').find(line => line.startsWith('# Captured request (commented): '));
  assert.deepEqual(JSON.parse(captured.slice('# Captured request (commented): '.length)), exchange.request);
  exchange.request.headers.entries.pop(); exchange.request.url += '?secret={{token}}';
  exported = exportOne(session);
  assert.match(exported.text, /HTTP-client variable syntax/);
  assert.equal(/^POST /m.test(exported.text), false);
});

test('metadata cannot introduce directives, filename paths, or additional executable requests', () => {
  const session = load(); session.name = '../../test\n###\nGET https://attacker.test';
  session.recordings[0].producer.app_id = 'app\n# @name fake\nGET https://attacker.test';
  const exported = exportOne(session);
  assert.equal(exported.filename.includes('/'), false);
  assert.equal(exported.filename.includes('\n'), false);
  assert.equal(/^GET /m.test(exported.text), false);
  assert.equal(/^# @name/m.test(exported.text), false);
  assert.equal(JSON.parse(exported.text.split('\n').find(line => line.startsWith('# Session: ')).slice('# Session: '.length)).name, session.name);
});

test('RFC token method/header names that clients parse as comments stay recoverable', () => {
  const session = load(), exchange = session.exchanges[0];
  exchange.request.method = '#GET';
  assert.match(exportOne(session).text, /Request disabled/);
  exchange.request.method = 'POST'; exchange.request.headers.entries.push({ name: '#Header', value: 'literal', redacted: false });
  const { text } = exportOne(session);
  assert.match(text, /Request disabled/);
  assert.equal(/^POST /m.test(text), false);
  assert.match(text, /"name":"#Header","value":"literal"/);
});

test('empty sources remain inspectable, selection is explicit, and rest uses identical syntax', () => {
  const session = sessionWith([record('empty', client, 0), record('other', client)]);
  const groups = requestSources(session);
  assert.equal(groups[0].requestCount, 0);
  assert.match(exportHTTP(session, groups[0].id).text, /No HTTP observations/);
  assert.throws(() => exportHTTP(session, null), /Select an available/);
  assert.throws(() => exportHTTP(session, 'unknown'), /Select an available/);
  const http = exportHTTP(session, groups[1].id), rest = exportHTTP(session, groups[1].id, { extension: 'rest' });
  assert.equal(http.text, rest.text);
  assert.match(rest.filename, /\.rest$/);
  assert.deepEqual(requestSources(null), []);
});
