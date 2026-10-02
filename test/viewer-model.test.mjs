import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { importFiles, filterSessionItems, formatDuration } from '../viewer/src/model.mjs';

const root = new URL('../', import.meta.url);
const read = (name = 'success') => readFileSync(new URL(`examples/${name}.ndjson`, root), 'utf8');
const parse = (name = 'success') => read(name).trim().split('\n').map(JSON.parse);
const serialize = (events) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const load = (name = 'success') => importFiles([{ name: `${name}.ndjson`, text: read(name) }]);
const fixtureManifest = JSON.parse(readFileSync(new URL('examples/manifest.json', root), 'utf8'));

for (const fixture of fixtureManifest.captures) {
  test(`browser model preserves contract summary: ${fixture.file}`, () => {
    const result = load(fixture.file.replace('.ndjson', ''));
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    for (const [key, expected] of Object.entries(fixture.expected)) assert.equal(result.summary[key], expected, key);
    assert.equal(result.sessions.flatMap(s => s.exchanges).length, fixture.expected.requests);
    assert.equal(result.sessions.flatMap(s => s.recordings).length, fixture.expected.recordings);
  });
}

test('current three-origin fixture preserves causal SDK / customer handler / server graph with original sources', () => {
  const path = 'examples/viewer-three-origin.ndjson';
  const text = readFileSync(new URL(path, root), 'utf8');
  const result = importFiles([{ name: path, text }]);
  const session = result.sessions[0], handler = session.handlers[0];
  assert.equal(result.valid, true);
  assert.equal(session.exchanges.length, 8);
  assert.equal(session.origins.length, 3);
  assert.equal(handler.completion, 'returned');
  assert.equal(handler.owner, 'integrator');
  assert.equal(handler.invocation.caller.owner, 'sdk');
  const child = session.exchanges.find(e => e.parentId === handler.id);
  assert.equal(child.owner, 'integrator');
  assert.equal(child.component, 'CustomerTaskClient');
  assert.equal(handler.childRequestIds.includes(child.id), true);
  assert.equal(child.ancestorIds.includes(handler.parentId), true);
  assert.equal(handler.rawSources.length, handler.rawEvents.length);
  for (let i = 0; i < handler.rawEvents.length; i++) {
    assert.equal(JSON.parse(handler.rawSources[i].text).event_id, handler.rawEvents[i].event_id);
    assert.equal(handler.rawSources[i].text, text.split('\n')[handler.rawSources[i].line - 1]);
  }
});

test('files retain independent EOF recovery while overlapping records deduplicate', () => {
  const text = read('success');
  const result = importFiles([{ name: 'partial.ndjson', text: text + '{"incomplete":' }, { name: 'full.ndjson', text }]);
  assert.equal(result.valid, true);
  assert.equal(result.summary.requests, 1);
  assert.equal(result.summary.duplicate_events, parse().length);
  assert.equal(result.diagnostics.some(d => d.fileName === 'partial.ndjson' && d.message.includes('incomplete final JSON')), true);
  assert.equal(result.sourceLines[result.events[0].event_id].length, 2);
});

test('merging complementary exports resolves missing parent and lifecycle warnings', () => {
  const events = parse();
  const result = importFiles([{ name: 'later', text: serialize(events.slice(4)) }, { name: 'earlier', text: serialize(events.slice(0, 4)) }]);
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.sessions[0].recordings[0].events.map(e => e.sequence), events.map(e => e.sequence));
});

test('opaque event IDs cannot mutate source-map prototypes', () => {
  for (const id of ['__proto__', 'constructor', 'toString']) {
    const events = parse(); events[0].event_id = id;
    const result = importFiles([{ name: id, text: serialize(events) }]);
    assert.equal(result.valid, true);
    assert.equal(result.sourceLines[id][0].line, 1);
    assert.equal(result.sourceLines[id][0].fileName, id);
  }
});

test('conflicting replay events retain actionable file diagnostics instead of silently merging', () => {
  const events = parse(), duplicate = structuredClone(events[0]);
  duplicate.data.name = 'A different name';
  const result = importFiles([{ name: 'first', text: serialize(events) }, { name: 'conflict', text: serialize([duplicate]) }]);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.some(d => d.message.includes('conflicting duplicate event_id')), true);
  assert.equal(result.summary.events, events.length);
});

test('orphan HTTP observations remain inspectable without invented request metadata', () => {
  const events = parse().filter(e => e.event_type !== 'http.request.started');
  const result = importFiles([{ name: 'orphan', text: serialize(events) }]);
  assert.equal(result.valid, true);
  const exchange = result.sessions[0].exchanges[0];
  assert.equal(exchange.orphan, true);
  assert.equal(exchange.request, null);
  assert.equal(exchange.start, null);
  assert.equal(exchange.method, 'Not recorded');
  assert.equal(exchange.status, 200);
  assert.equal(exchange.classification, 'incomplete');
  assert.equal(result.diagnostics.some(d => d.message.includes('missing span start')), true);
});

test('HTTP header status does not hide timeout or stopped observation', () => {
  const timed = load('stream-read-timeout').sessions[0].exchanges[0];
  assert.equal(timed.status, 200);
  assert.equal(timed.classification, 'failed');
  assert.equal(timed.outcome, 'timeout');
  assert.equal(timed.returnedEarly, true);
  const stopped = load('manual-observation-stopped').sessions[0].exchanges[0];
  assert.equal(stopped.status, 200);
  assert.equal(stopped.classification, 'incomplete');
  assert.equal(stopped.durationNs, null);
  assert.notEqual(stopped.observedDurationNs, null);
});

test('known HTTP failure overlaps unknown outcome and separate application failure affects filtering', () => {
  const stopped = parse('manual-observation-stopped');
  stopped.find(e => e.event_type === 'http.response.headers').data.response.status_code = 500;
  stopped.find(e => e.event_type === 'http.ended').data.status_code = 500;
  const unknown = importFiles([{ name: 'unknown', text: serialize(stopped) }]);
  assert.equal(unknown.valid, true);
  assert.equal(unknown.sessions[0].summary.failed_requests, 1);
  assert.equal(unknown.sessions[0].summary.unknown_outcomes, 1);
  const events = parse(); events.find(e => e.event_type === 'http.ended').data.application_outcome = 'error';
  const result = importFiles([{ name: 'application', text: serialize(events) }]);
  const exchange = result.sessions[0].exchanges[0];
  assert.equal(exchange.status, 200);
  assert.equal(exchange.outcome, 'success');
  assert.equal(exchange.applicationOutcome, 'error');
  assert.equal(exchange.classification, 'failed');
  assert.equal(filterSessionItems(result.sessions[0], { outcome: 'failed' }).exchanges.length, 1);
});

test('handler observation-stop exposes only observed duration and no completed method duration', () => {
  const handler = load('handler-stopped').sessions[0].handlers[0];
  assert.equal(handler.completion, 'observation_stopped');
  assert.equal(handler.durationNs, null);
  assert.equal(handler.durationMs, null);
  assert.notEqual(handler.observedDurationNs, null);
  assert.equal(formatDuration(handler.durationNs), '—');
});

test('manual and native metadata preserve uncertainty, repeated query/header entries and partial JSON', () => {
  const manual = load('manual-minimal').sessions[0].exchanges[0];
  assert.equal(manual.response.url, null);
  assert.equal(manual.request.headers.availability, 'unavailable');
  const full = load().sessions[0].exchanges[0];
  assert.equal(full.query.filter(p => p.name === 'tag').length, 2);
  assert.equal(full.response.headers.entries.filter(h => h.name.toLowerCase() === 'set-cookie').length, 2);
  const partial = load('redacted-truncated').sessions[0].exchanges[0];
  assert.equal(partial.responseBody.redacted, true);
  assert.equal(partial.responseBody.truncated, true);
  assert.throws(() => JSON.parse(partial.responseBody.content.data));
});

test('native metric transactions add known origins without inventing exchanges', () => {
  const session = load('ios-logical-transactions').sessions[0];
  assert.equal(session.exchanges.length, 1);
  assert.equal(session.exchanges[0].metrics.length, 2);
  assert.equal(session.origins.length, 2);
});

test('recordings retain first appearance with independent clocks and namespaces', () => {
  const events = parse('multi-session');
  const firstIds = [...new Set(events.map(e => e.recording_id))];
  const result = importFiles([{ name: 'interleaved', text: serialize(events) }]);
  for (const session of result.sessions) assert.deepEqual(session.recordings.map(r => r.id), firstIds.filter(id => session.recordings.some(r => r.id === id)));
  const first = parse(), second = structuredClone(first);
  for (const e of second) {
    e.session_namespace = 'another/project'; e.recording_id += '-different'; e.event_id += '-different';
    if (e.context) { e.context.trace_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
  }
  const mixed = importFiles([{ name: 'namespaced', text: serialize([...first, ...second]) }]);
  assert.equal(mixed.valid, true);
  assert.equal(mixed.sessions.length, 2);
  assert.equal(mixed.sessions[0].sessionId, mixed.sessions[1].sessionId);
});

test('nanosecond differences remain exact beyond JavaScript safe integers', () => {
  const events = parse();
  for (const event of events) if (event.event_type !== 'session.started') event.monotonic_ns = (BigInt(event.monotonic_ns) + 9007199254740993000n).toString();
  const result = importFiles([{ name: 'precision', text: serialize(events) }]);
  assert.equal(result.valid, true);
  const exchange = result.sessions[0].exchanges[0];
  assert.equal(exchange.durationNs, events.find(e => e.event_type === 'http.ended').data.duration_ns);
  assert.equal(exchange.timeToHeadersNs, (BigInt(exchange.responseEvent.monotonic_ns) - BigInt(exchange.start.monotonic_ns)).toString());
});

test('filters preserve causal ancestry and local-only/HTTP-only empty-handler visibility', () => {
  const session = load('handler-http').sessions[0], handler = session.handlers[0];
  const app = filterSessionItems(session, { owner: 'app' });
  assert.equal(app.exchanges.length, 1);
  assert.equal(app.visibleIds.has(handler.parentId), true);
  const searched = filterSessionItems(session, { search: handler.spanId });
  assert.equal(searched.handlers.length, 1);
  assert.equal(filterSessionItems(session, { kind: 'local' }).exchanges.length, 0);
  assert.equal(filterSessionItems(session, { kind: 'local' }).operations.length, session.operations.length);
  const empty = load('handler-no-http').sessions[0];
  assert.equal(filterSessionItems(empty, { kind: 'http' }).operations.some(o => o.isHandler), true);
  assert.equal(filterSessionItems(session, { origins: ['https://missing.example'] }).exchanges.length, 0);
});

test('file and event caps reject oversize input with diagnostics without truncating records', () => {
  const tooBig = importFiles([{ name: 'large', text: read() }], { maxFileBytes: 10 });
  assert.equal(tooBig.valid, false);
  assert.equal(tooBig.sessions.length, 0);
  assert.match(tooBig.files[0].diagnostics[0].message, /byte import limit/);
  const tooMany = importFiles([{ name: 'many', text: read() }], { maxEvents: 1 });
  assert.equal(tooMany.events.length, 0);
  assert.equal(tooMany.valid, false);
});

test('generated standalone validator is deterministic and does not compile code at runtime', () => {
  const path = new URL('shared/event-validator.mjs', root);
  const before = readFileSync(path, 'utf8');
  // Keep generated module replacement away from concurrent importers.
  mkdirSync(new URL('.local/', root), { recursive: true });
  const output = mkdtempSync(new URL('.local/validator-repro-', root));
  try {
    for (const directory of ['scripts', 'schema', 'shared']) mkdirSync(join(output, directory));
    copyFileSync(new URL('scripts/build-validator.mjs', root), join(output, 'scripts/build-validator.mjs'));
    copyFileSync(new URL('schema/event.schema.json', root), join(output, 'schema/event.schema.json'));
    execFileSync(process.execPath, ['scripts/build-validator.mjs'], { cwd: output });
    assert.equal(readFileSync(join(output, 'shared/event-validator.mjs'), 'utf8'), before);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
  assert.equal(/new Function|\beval\(/.test(before), false);
  assert.equal(/\brequire\(/.test(before), false);
});

test('outliving-handler fixture preserves actual return, SDK continuation, and later HTTP completion', () => {
  const result = load('handler-http-outlives-return');
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.length, 0);
  const session = result.sessions[0], handler = session.handlers[0], exchange = session.exchanges[0];
  const resume = session.operations.find(o => o.method === 'acceptTask');
  assert.equal(handler.completion, 'returned');
  assert.equal(handler.durationNs, '20000000');
  assert.equal(exchange.parentId, handler.id);
  assert.equal(exchange.owner, 'integrator');
  assert.equal(exchange.returnedEarly, true);
  assert.equal(exchange.completedAfterHandlerReturn, true);
  assert.ok(handler.end.sequence < resume.start.sequence);
  assert.ok(resume.end.sequence < exchange.end.sequence);
  assert.ok(exchange.responseEvent.sequence < handler.end.sequence);
  assert.ok(exchange.rawEvents.find(e => e.event_type === 'http.body.captured' && e.data.direction === 'response').sequence > handler.end.sequence);
});

test('repeated/nested fixture pairs distinct handler spans and attributes callback HTTP to SDK', () => {
  const result = load('handler-repeated-nested');
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.length, 0);
  const session = result.sessions[0];
  const tasks = session.handlers.filter(o => o.method === 'loadTask');
  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0].spanId, tasks[1].spanId);
  assert.deepEqual(tasks.map(o => [o.repeatIndex, o.repeatCount]), [[1, 2], [2, 2]]);
  assert.ok(tasks[0].end.sequence < tasks[1].start.sequence);
  const nested = session.handlers.find(o => o.method === 'currentToken');
  assert.equal(nested.parentId, tasks[1].id);
  assert.equal(nested.depth, 2);
  assert.equal(nested.invocation.caller.owner, 'integrator');
  assert.equal(nested.owner, 'sdk');
  assert.equal(nested.completion, 'returned');
  assert.ok(nested.end.sequence < tasks[1].end.sequence);
  const exchange = session.exchanges.find(e => e.parentId === nested.id);
  assert.equal(exchange.owner, 'sdk');
  assert.equal(exchange.component, 'DemoAuthTokenStore');
  assert.equal(exchange.ancestorIds.includes(tasks[1].id), true);
  assert.equal(tasks[0].childRequestIds.includes(exchange.id), false);
  assert.equal(filterSessionItems(session, { owner: 'sdk' }).exchanges.length, 1);
  assert.equal(filterSessionItems(session, { owner: 'app' }).exchanges.length, 2);
});
