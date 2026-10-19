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
  assert.match(groups[0].label, /Recording 1/);
  assert.notEqual(groups[0].id, groups[1].id);
});

test('imported backend invocation recordings group by explicit service, environment and runtime', () => {
  const groups = requestSources(sessionWith([record('first', backend), record('second', backend), record('prod', { ...backend, environment: 'prod' }), record('cloud', { ...backend, runtime: 'cloudflare' }), record('billing', { ...backend, service_name: 'Billing' })]));
  assert.equal(groups.length, 4);
  assert.equal(groups[0].requestCount, 2);
  assert.match(groups[0].label, /Backend · Orders · dev/);
  assert.equal(new Set(groups.map(g => g.label)).size, 4);
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

test('approved transcript contains only request and response lines, headers and readable bodies', () => {
  const session = load(), exchange = session.exchanges[0];
  exchange.request.headers = { availability:'captured', entries:[{name:'Content-Type',value:'application/json'},{name:'X-Repeat',value:'one'},{name:'X-Repeat',value:'two'}] };
  exchange.response.headers = { availability:'captured', entries:[{name:'Content-Type',value:'application/json'},{name:'Set-Cookie',value:'one'},{name:'Set-Cookie',value:'two'}] };
  exchange.requestBody.content.data = '{"phoneNumber":"+12025550123"}';
  exchange.responseBody.content.data = '{"verified":true}';
  exchange.request.configured_method = 'HEAD';
  exchange.start.data.extra = 'capture-only';
  exchange.rawEvents.push({event_type:'http.metrics',data:{protocol_version:'h2',remote_address:'192.0.2.9',remote_port:443,phases:[]}});
  assert.equal(exportOne(session).text, `POST https://api.example/verify?tag=mobile&tag=checkout HTTP/2
Content-Type: application/json
X-Repeat: one
X-Repeat: two

{
  "phoneNumber": "+12025550123"
}

# Response
HTTP/2 200
Content-Type: application/json
Set-Cookie: one
Set-Cookie: two

{
  "verified": true
}
`);
});

test('unknown protocol and transport are omitted; conflicting transaction versions are not guessed', () => {
  const session=load(), exchange=session.exchanges[0];
  assert.match(exportOne(session).text, /^POST [^\n]+\n# Headers partially captured\nContent-Type:/);
  assert.doesNotMatch(exportOne(session).text, /HTTP\/|Transport|TLS|TCP/);
  exchange.rawEvents.push({event_type:'http.metrics',data:{protocol_version:'h2'}},{event_type:'http.metrics',data:{protocol_version:'http/1.1'}});
  assert.doesNotMatch(exportOne(session).text, /HTTP\//);
  exchange.rawEvents.pop();
  assert.match(exportOne(session).text, /HTTP\/2/);
  exchange.rawEvents.at(-1).data.protocol_version=null;
  assert.doesNotMatch(exportOne(session).text, /HTTP\//);
});

test('all sources have separate sections, while one source needs no heading', () => {
  const first=record('first',client,2), second=record('second',backend);
  first.exchanges[0].request.url='https://client.test/one';
  first.exchanges[1].request.url='https://client.test/two';
  second.exchanges[0].request.url='https://server.test/three';
  first.exchanges.reverse();
  first.startedAt='2099-01-01T00:00:00Z';second.startedAt='1900-01-01T00:00:00Z';
  const session=sessionWith([first,second]);
  const all=exportHTTP(session,null);
  assert.equal(all.requestCount,3);
  assert.equal((all.text.match(/^### Source:/gm)||[]).length,2);
  assert.ok(all.text.indexOf('https://client.test/one')<all.text.indexOf('https://client.test/two'));
  assert.ok(all.text.indexOf('https://client.test/two')<all.text.indexOf('https://server.test/three'));
  const selected=exportHTTP(session,requestSources(session)[1].id);
  assert.match(selected.text,/^### Source: Backend/);
  assert.doesNotMatch(selected.text,/client.test/);
  assert.doesNotMatch(exportHTTP(load(),null).text,/^### Source:/m);
  assert.throws(()=>exportHTTP(session,'unknown'),/Select an available/);
  assert.equal(exportHTTP(session,null,{extension:'rest'}).text,all.text);
  assert.match(exportHTTP(session,null,{extension:'rest'}).filename,/\.rest$/);
});

test('JSON formatting preserves large numeric literals, duplicate keys, exponents and original events', () => {
  const session=load(), body=session.exchanges[0].requestBody;
  const original='{"id":9007199254740993123,"id":2,"exponent":1e+42,"nested":{"email":"jane@example.com"}}';
  body.content.data=original;
  const text=exportOne(session).text;
  assert.match(text, /"id": 9007199254740993123,\n  "id": 2,/);
  assert.match(text, /"exponent": 1e\+42/);
  assert.match(text, /"nested": \{\n    "email": "jane@example.com"/);
  assert.equal(body.content.data,original);
});

test('plain, invalid JSON and CRLF request bodies retain their captured text', () => {
  const session=load(), body=session.exchanges[0].requestBody;
  for(const value of ['{"unfinished":','['.repeat(40)+'1'+']'.repeat(40),'line one\r\nline two\r\n']) {
    body.content.data=value;
    assert.ok(exportOne(session).text.includes('\n\n'+value+'\n\n# Response'));
  }
  body.media_type='text/plain';body.content.data='{"compact":true}';
  assert.ok(exportOne(session).text.includes('\n\n{"compact":true}\n\n# Response'));
});

test('missing bodies, truncation, binary and missing responses use short markers', () => {
  const session=load(), exchange=session.exchanges[0];
  exchange.requestBody=null;
  assert.match(exportOne(session).text,/# Body not captured/);
  exchange.requestBody={availability:'captured',truncated:true,redacted:true,content:{encoding:'base64',data:'AAH/Qg=='}};
  let text=exportOne(session).text;
  assert.match(text,/# Body truncated\n# Body redacted\n# Body \(base64\)\nAAH\/Qg==/);
  assert.doesNotMatch(text,/stored_bytes|availability|capture_limit/);
  exchange.requestBody={availability:'not_applicable'};
  exchange.responseBody={availability:'not_applicable'};
  text=exportOne(session).text;
  assert.doesNotMatch(text,/# Body/);
  exchange.response=null;
  exchange.rawEvents=exchange.rawEvents.filter(event=>event.event_type!=='http.response.headers');
  assert.match(exportOne(session).text,/# No response captured/);
});

test('response-only observations preserve response headers and payload without a fabricated request', () => {
  const events=fixture('success').trim().split('\n').map(JSON.parse).filter(e=>e.event_type!=='http.request.started');
  const session=importFiles([{name:'orphan.ndjson',text:events.map(JSON.stringify).join('\n')}]).sessions[0];
  const {text,requestCount,observationCount}=exportOne(session);
  assert.equal(requestCount,0);assert.equal(observationCount,1);
  assert.match(text,/# Request not captured/);assert.match(text,/HTTP 200/);assert.match(text,/verified/);
  assert.equal((text.match(/^Set-Cookie:/gm)||[]).length,2);
  assert.doesNotMatch(text,/^(?:GET|POST) /m);
});

test('informational responses and HTTP trailers retain their standard header form', () => {
  const session=load(),exchange=session.exchanges[0];
  const interim=structuredClone(exchange.rawEvents.find(e=>e.event_type==='http.response.headers'));
  interim.data.phase='informational';interim.data.response.status_code=103;interim.data.response.status_text='Early Hints';
  interim.data.response.headers.entries=[{name:'Link',value:'</next>; rel=preload'}];
  exchange.rawEvents.unshift(interim);
  exchange.rawEvents.push({event_type:'http.trailers',data:{direction:'response',headers:{availability:'captured',entries:[{name:'X-Checksum',value:'abc'}]}}});
  const text=exportOne(session).text;
  assert.match(text,/# Response\nHTTP 103 Early Hints\nLink: <\/next>; rel=preload/);
  assert.match(text,/# Response trailers\nX-Checksum: abc/);
  assert.equal((text.match(/"verified"/g)||[]).length,1);
});

for (const attack of ['hello\n###\nDELETE https://attacker.test', '{{secret}}', '< /etc/passwd', '> {% evil() %}', '# @name injected', '@var = value', '\u0000binary']) {
  test(`exceptional request syntax stays recoverable: ${JSON.stringify(attack)}`, () => {
    const session=load();session.exchanges[0].requestBody.content.data=attack;
    const {text}=exportOne(session);
    assert.match(text,/shown as comments/);
    assert.doesNotMatch(text,/^(?:POST|DELETE) /m);
    const captured=text.split('\n').find(line=>line.startsWith('# Body: '));
    assert.equal(JSON.parse(captured.slice('# Body: '.length)),attack);
  });
}

test('response bodies and headers cannot introduce extra transcript sections', () => {
  const session=load(), exchange=session.exchanges[0];
  const value='line one\r\n###\r\nDELETE https://attacker.test\r\n> {% run() %}';
  exchange.responseBody.media_type='text/plain';exchange.responseBody.content.data=value;
  exchange.response.headers.entries.push({name:'X-Test',value:'a\n\n###\nDELETE https://attacker.test'});
  const text=exportOne(session).text;
  assert.doesNotMatch(text,/^###|^DELETE |^> /m);
  const encoded=text.split('\n').find(line=>line.startsWith('# Body (escaped UTF-8): '));
  assert.equal(JSON.parse(encoded.slice('# Body (escaped UTF-8): '.length)),value);
});

test('source labels and filenames stay on one line without introducing requests', () => {
  const session=sessionWith([record('one',client),record('two',{...backend,service_name:'Orders\n###\nGET https://attacker.test'})]);
  session.name='../../test\nGET https://attacker.test';
  const {text,filename}=exportHTTP(session,null);
  assert.doesNotMatch(filename,/[/\n]/);
  assert.doesNotMatch(text,/^GET https:\/\/attacker.test/m);
  assert.equal((text.match(/^### Source:/gm)||[]).length,2);
});

test('empty sources have no invented traffic and empty sessions remain downloadable as empty text', () => {
  const session=sessionWith([record('empty',client,0)]);
  assert.equal(exportOne(session).text,'');
  assert.equal(exportHTTP(session,null).observationCount,0);
  assert.deepEqual(requestSources(null),[]);
});
