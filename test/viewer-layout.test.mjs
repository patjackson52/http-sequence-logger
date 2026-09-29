import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importFiles, filterSessionItems } from '../viewer/src/model.mjs';
import { layoutSequence } from '../viewer/src/layout.mjs';

const loadText = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const fromText = (text) => importFiles([{ name: 'fixture.ndjson', text }]).sessions[0];
const fixture = (name) => fromText(loadText(`examples/${name}.ndjson`));
const handler = (session) => session.operations.find((o) => o.isHandler);
const projected = (session, filters) => layoutSequence(session, { ...filters, visibleIds: filterSessionItems(session, filters).visibleIds });

test('layout: no-HTTP handler has a call, one block, and return without adding an origin', () => {
  const session = fixture('handler-no-http'), layout = layoutSequence(session), invocation = handler(session);
  assert.equal(layout.localArrows.filter((a) => a.kind === 'call').length, 1);
  assert.equal(layout.localArrows.filter((a) => a.kind === 'return').length, 1);
  assert.equal(layout.bars.filter((b) => b.kind === 'handler').length, 1);
  assert.equal(layout.lanes.filter((l) => l.kind === 'server').length, 0);
  assert.ok(layout.localArrows.every((a) => a.entityId === invocation.id));
  assert.ok(layout.localArrows.find((a) => a.kind === 'call').x1 > layout.localArrows.find((a) => a.kind === 'call').x2);
  assert.equal(layoutSequence(session).height, layout.height);
});

test('layout: real HTTP follows executor and custom handler follows App lane', () => {
  const session = fromText(loadText('samples/live/successful-sign-in.ndjson'));
  const layout = layoutSequence(session), app = layout.lanes.find((l) => l.owner === 'integrator'), sdk = layout.lanes.find((l) => l.owner === 'sdk');
  const manual = session.exchanges.find((x) => x.manual), sdkRequest = session.exchanges.find((x) => x.executor.owner === 'sdk');
  assert.equal(layout.arrows.find((a) => a.entityId === manual.id && a.kind === 'request').x1, app.x);
  assert.equal(layout.arrows.find((a) => a.entityId === sdkRequest.id && a.kind === 'request').x1, sdk.x);
  assert.ok(!projected(session, { owner: 'sdk' }).arrows.some((a) => a.entityId === manual.id));
  assert.ok(projected(session, { owner: 'integrator' }).arrows.some((a) => a.entityId === manual.id));
});

test('layout: stopped or unfinished invocation never invents a return', () => {
  for (const name of ['handler-stopped', 'handler-interrupted']) {
    const session = fixture(name), invocation = handler(session), layout = layoutSequence(session);
    assert.equal(layout.localArrows.filter((a) => a.kind === 'return').length, 0);
    const bar = layout.bars.find((b) => b.entityId === invocation.id);
    assert.equal(bar.tone, 'warning');
    assert.equal(invocation.durationMs, null);
    assert.equal(bar.open, name === 'handler-interrupted');
    assert.equal(bar.stopped, name === 'handler-stopped');
  }
});

test('layout: thrown and cancelled exits retain distinct return semantics', () => {
  const thrown = layoutSequence(fixture('handler-throw')).localArrows.find((a) => a.kind === 'return');
  const cancelled = layoutSequence(fixture('handler-cancelled')).localArrows.find((a) => a.kind === 'return');
  assert.match(thrown.label, /↯ threw · HandlerError/); assert.equal(thrown.tone, 'error');
  assert.match(cancelled.label, /⊘ cancelled/); assert.equal(cancelled.tone, 'neutral');
  assert.equal(layoutSequence(fixture('success')).localArrows.length, 0);
});

test('layout: only the explicit local caller bar is hatched; remote or missing caller gets a hollow dot', () => {
  const session = fixture('handler-no-http'), invocation = handler(session), caller = session.operations.find((o) => o.id === invocation.parentId);
  const independent = structuredClone(caller); independent.id += '-telemetry'; independent.component = 'Telemetry'; independent.method = 'flush'; independent.parentId = null; independent.parentScope = 'none';
  session.operations.push(independent);
  const layout = layoutSequence(session), wait = layout.waitSegments[0];
  assert.equal(layout.waitSegments.length, 1); assert.equal(wait.callerId, caller.id);
  assert.equal(wait.x, layout.bars.find((b) => b.entityId === caller.id).x);
  assert.notEqual(wait.x, layout.bars.find((b) => b.entityId === independent.id).x);
  invocation.parentScope = 'remote';
  const remote = layoutSequence(session);
  assert.equal(remote.waitSegments.length, 0); assert.equal(remote.localArrows.find((a) => a.kind === 'call').fromDot, true);
  invocation.parentId = null; invocation.parentScope = 'none';
  assert.match(layoutSequence(session).localArrows.find((a) => a.kind === 'call').sub, /caller not instrumented/);
});

test('layout: sequence ordering wins over timestamps, and clocks never create cross-recording gaps', () => {
  const session = fixture('multi-session');
  const layout = layoutSequence(session);
  for (const recording of session.recordings) {
    const sequences = layout.rows.filter((r) => r.event?.recording_id === recording.id).map((r) => r.event.sequence);
    assert.deepEqual(sequences, sequences.toSorted((a, b) => a - b));
  }
  for (let i = 0; i < layout.rows.length - 1; i++) if (layout.rows[i].kind === 'recording') assert.notEqual(layout.rows[i + 1].kind, 'gap');
  const normal = fixture('handler-http'), original = layoutSequence(normal).rows.filter((r) => r.entityId).map((r) => `${r.entityId}:${r.kind}`);
  for (const operation of normal.operations) if (operation.start) operation.start.timestamp = '1900-01-01T00:00:00.000Z';
  assert.deepEqual(layoutSequence(normal).rows.filter((r) => r.entityId).map((r) => `${r.entityId}:${r.kind}`), original);
});

test('layout: headers remain separate from 200 response followed by body timeout', () => {
  const session = fixture('stream-read-timeout'), exchange = session.exchanges.find((x) => x.outcome === 'timeout'), layout = layoutSequence(session);
  const response = layout.arrows.find((a) => a.entityId === exchange.id && a.kind === 'response');
  const terminal = layout.arrows.find((a) => a.entityId === exchange.id && a.kind === 'terminal');
  assert.match(response.label, /200/); assert.match(response.sub, /headers only/); assert.equal(response.dashed, true);
  assert.match(terminal.label, /timed out/); assert.equal(terminal.tone, 'error'); assert.ok(response.y < terminal.y);
});

test('layout: HTTP-only preserves a no-HTTP handler pill, local-only preserves origin lanes', () => {
  const empty = fixture('handler-no-http'), onlyHttp = projected(empty, { kind: 'http' });
  assert.equal(onlyHttp.ancestryPills.length, 1); assert.equal(onlyHttp.localArrows.length, 0);
  const withHttp = fixture('handler-http'), local = projected(withHttp, { kind: 'local' });
  assert.equal(local.arrows.length, 0); assert.equal(local.lanes.filter((l) => l.kind === 'server').length, 1);
  assert.ok(local.lanes.filter((l) => l.kind === 'server').every((l) => l.muted));
  assert.ok(local.bars.some((b) => b.kind === 'method'));
});

test('layout: a child can finish after return; collapsing its handler hides all child rows', () => {
  const session = fixture('handler-http'), invocation = handler(session), exchange = session.exchanges[0];
  invocation.end.sequence = exchange.start.sequence + .5;
  exchange.completedAfterHandlerReturn = true;
  const layout = layoutSequence(session), returned = layout.localArrows.find((a) => a.kind === 'return');
  assert.ok(returned.y < layout.arrows.find((a) => a.kind === 'response').y);
  assert.match(layout.arrows.find((a) => a.kind === 'terminal').sub, /after handler returned/);
  const collapsed = layoutSequence(session, { collapsed: new Set([invocation.id]) });
  assert.equal(collapsed.arrows.length, 0); assert.equal(collapsed.bars.find((b) => b.entityId === invocation.id).counts.requests, 1);
});

test('layout: repeats are numbered and component expansion preserves ownership', () => {
  const session = fixture('handler-no-http'), invocation = handler(session), duplicate = structuredClone(invocation);
  invocation.repeatCount = 2; duplicate.repeatCount = 2; duplicate.repeatIndex = 2; duplicate.id += '-repeat'; duplicate.spanId = 'repeat';
  duplicate.start.sequence = invocation.end.sequence + .1; duplicate.end.sequence = invocation.end.sequence + .2;
  session.operations.push(duplicate);
  const layout = layoutSequence(session, { expandedOwners: new Set(['integrator', 'sdk']) });
  assert.match(layout.bars.find((b) => b.entityId === invocation.id).label, /#1$/);
  assert.match(layout.bars.find((b) => b.entityId === duplicate.id).label, /#2$/);
  assert.ok(layout.lanes.some((l) => l.component === invocation.component));
  assert.ok(layout.bars.every((b) => !b.label.includes(b.operation.spanId)));
});

test('layout: orphan observations never fabricate a request or local call start', () => {
  const text = loadText('examples/handler-http.ndjson');
  const events = text.trim().split('\n').map(JSON.parse);
  const removed = events.find((e) => e.event_type === 'http.request.started');
  const session = fromText(events.filter((e) => e !== removed).map(JSON.stringify).join('\n') + '\n'), layout = layoutSequence(session);
  assert.equal(layout.arrows.filter((a) => a.kind === 'request').length, 0);
  assert.equal(layout.serverBars.length, 0);
  assert.match(layout.arrows.find((a) => a.kind === 'terminal').sub, /start not recorded/);
  assert.match(layout.arrows.find((a) => a.kind === 'terminal').label, /duration not verified/);
  const invocation = handler(session); invocation.start = null; invocation.orphan = true;
  const orphanLayout = layoutSequence(session);
  assert.equal(orphanLayout.localArrows.length, 0); assert.ok(orphanLayout.rows.some((r) => r.kind === 'orphan'));
});

test('layout: HTTP application error remains a failed terminal even with successful HTTP status', () => {
  const session = fixture('handler-http'); session.exchanges[0].applicationOutcome = 'error';
  const terminal = layoutSequence(session).arrows.find((a) => a.kind === 'terminal');
  assert.equal(terminal.tone, 'error'); assert.match(terminal.label, /application error/);
});

test('layout: search narrows origins, while local-only retains the original participants', () => {
  const session = fromText(loadText('samples/live/successful-sign-in.ndjson'));
  assert.equal(session.origins.length, 3);
  const filtered = projected(session, { search: '/todos/1' });
  assert.deepEqual(filtered.lanes.filter((l) => l.kind === 'server').map((l) => l.origin), ['https://jsonplaceholder.typicode.com']);
  const local = projected(session, { kind: 'local', search: 'loadTask' });
  assert.equal(local.lanes.filter((l) => l.kind === 'server').length, 3);
  const transactions = fixture('ios-logical-transactions');
  assert.deepEqual(layoutSequence(transactions).lanes.filter((l) => l.kind === 'server').map((l) => l.origin), transactions.origins);
});

test('layout: a known HTTP error stays visible through cancellation', () => {
  const session = fixture('http-error'), exchange = session.exchanges.find((x) => x.status >= 400);
  exchange.outcome = 'cancelled';
  const layout = layoutSequence(session), response = layout.arrows.find((a) => a.entityId === exchange.id && a.kind === 'response');
  assert.equal(response.tone, 'error'); assert.match(response.label, /^✕ 4/); assert.match(response.sub, /headers only/);
  assert.match(layout.arrows.find((a) => a.entityId === exchange.id && a.kind === 'terminal').label, /cancelled/);
});

test('layout: same-owner local calls loop and nested handler depth follows explicit parent', () => {
  const session = fixture('handler-no-http'), outer = handler(session), nested = structuredClone(outer);
  nested.id += '-nested'; nested.spanId = 'nested'; nested.parentId = outer.id; nested.parentScope = 'local'; nested.depth = 3;
  nested.origin = { owner: 'integrator', component: 'TaskCache', method: 'read' }; nested.owner = 'integrator'; nested.component = 'TaskCache'; nested.method = 'read'; nested.name = 'TaskCache.read';
  nested.invocation.caller = { ...outer.origin }; nested.start.sequence = outer.start.sequence + .1; nested.end.sequence = outer.end.sequence - .1;
  session.operations.push(nested);
  const layout = layoutSequence(session), arrow = layout.localArrows.find((a) => a.entityId === nested.id && a.kind === 'call');
  assert.equal(arrow.self, true); assert.equal(layout.bars.find((b) => b.entityId === nested.id).depth, 3);
  const wait = layout.waitSegments.find((w) => w.entityId === nested.id);
  assert.equal(wait.callerId, outer.id);
});
