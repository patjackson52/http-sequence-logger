import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { diffSequences, sequencesFromCapture, LIMITS, validateDiff } from '../sequence-diff/index.mjs';
import { importFiles } from '../viewer/src/model.mjs';
import { createComparisonSnapshot, snapshotsFromCapture, eventsForReference, validateSourceReferences, SNAPSHOT_LIMITS } from '../viewer/src/comparison-data.mjs';
import { compareRequest } from '../viewer/src/comparison-worker.mjs';
import { ComparisonClient } from '../viewer/src/comparison-client.mjs';
import { CollectorClient } from '../viewer/src/collector-client.mjs';
import { startCollector } from '../collector/server.mjs';
import { comparisonFixture } from './comparison-fixtures.mjs';

const text = readFileSync(new URL('../examples/success.ndjson', import.meta.url), 'utf8');
const document = () => sequencesFromCapture(text)[0];
const snapshot = () => createComparisonSnapshot(document());
const json = value => new Response(JSON.stringify(value));
const workerURL = new URL('../viewer/src/comparison-worker.mjs', import.meta.url).href;

test('snapshots detach canonical events, metadata and evidence, and refuse skipped input', () => {
  const input = importFiles([{ name: 'success.ndjson', text }]), snap = snapshotsFromCapture(input)[0];
  assert.equal(snap.document, snap.sequence);
  input.events[0].data.name = 'changed after snapshot';
  input.sourceLines[snap.document.events[0].event_id][0].text = 'changed';
  assert.equal(snap.document.events[0].data.name, 'success');
  assert.notEqual(snap.evidence[snap.document.events[0].event_id][0].text, 'changed');
  assert.ok(Object.isFrozen(snap.document.events[0].data));
  assert.throws(() => { snap.document.events[0].data.name = 'mutation'; }, TypeError);
  for (const trailing of ['\n{broken}\n', '\n{"schema_version":']) {
    assert.throws(() => snapshotsFromCapture(importFiles([{ name: 'bad.ndjson', text: text + trailing }])), /invalid or skipped/);
  }
  assert.equal(SNAPSHOT_LIMITS.events, LIMITS.events);
  assert.throws(() => createComparisonSnapshot({ ...document(), events: Array(LIMITS.events + 1).fill(document().events[0]) }), /event limit/);
});

test('worker, canonical module and CLI produce identical schema-valid JSON with exact source references', async t => {
  const primary = document(), secondary = document();
  secondary.events.find(event => event.event_type === 'http.request.started').data.request.url += '?check=changed';
  const expected = diffSequences(primary, secondary);
  assert.equal(expected.result, 'different');
  assert.ok(expected.pairs.some(pair => pair.changes.some(change => change.path.startsWith('/request/query'))));
  const worker = new Worker(`import {parentPort} from 'node:worker_threads'; globalThis.self={postMessage:data=>parentPort.postMessage(data)}; await import(${JSON.stringify(workerURL)}); parentPort.on('message',data=>self.onmessage({data}));`, { eval: true });
  t.after(() => worker.terminate());
  const answer = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  worker.postMessage({ id: 7, primary, secondary });
  const result = await answer;
  assert.equal(result.id, 7); assert.equal(result.error, undefined); assert.deepEqual(result.diff, expected);
  assert.ok(result.models.primary.exchanges.length); assert.equal(validateDiff(result.diff), true);
  assert.equal(validateSourceReferences(result.diff, primary, secondary), true);
  for (const pair of result.diff.pairs) for (const [side, doc] of [['primary', primary], ['secondary', secondary]]) {
    const reference = pair[side]; if (!reference) continue;
    const events = eventsForReference(doc, reference);
    assert.deepEqual(events.map(event => event.event_id), reference.event_ids);
    assert.ok(events.every(event => event.recording_id === reference.recording_id));
  }
  const directory = mkdtempSync(join(tmpdir(), 'comparison-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'primary.json'), JSON.stringify(primary));
  writeFileSync(join(directory, 'secondary.json'), JSON.stringify(secondary));
  const cli = spawnSync(process.execPath, ['sequence-diff/cli.mjs', 'compare', join(directory, 'primary.json'), join(directory, 'secondary.json')], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), expected);
  const edited = structuredClone(expected); edited.pairs[0].primary.event_ids[0] = 'foreign-event';
  assert.throws(() => validateSourceReferences(edited, primary, secondary), /snapshot event/);
});

test('worker returns explicit input, engine-limit and profile failures without a partial diff', () => {
  const a = snapshot();
  for (const request of [
    { primary: { ...a.document, events: [] }, secondary: a },
    { primary: { ...a.document, events: Array(LIMITS.events + 1).fill(a.document.events[0]) }, secondary: a },
    { primary: a, secondary: a, profile: { matches: [{ primary: 'missing', secondary: 'missing' }] } },
  ]) {
    const result = compareRequest({ id: 3, ...request });
    assert.ok(result.error.message); assert.equal(result.diff, undefined); assert.equal(result.id, 3);
  }
  const imported = compareRequest({ id: 4, operation: 'import', files: [{ name: 'canonical.ndjson', text }] });
  assert.equal(imported.snapshots.length, 1);
  assert.equal(compareRequest({ id: 5, operation: 'import', files: [{ text: text + '{' }] }).snapshots, undefined);
});

test('current canonical platform fixtures agree in worker, module and CLI; historical captures are rejected',t=>{
  const directory=mkdtempSync(join(tmpdir(),'comparison-platforms-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  for (const file of ['samples/realtime/android-adb-emulator-5556-user-0.ndjson','samples/realtime/ios-simulator-8638be44-26c3-44a3-9815-901395ca8d84.ndjson','samples/web/browser-multi-session.ndjson']) assert.throws(() => sequencesFromCapture(readFileSync(new URL('../'+file,import.meta.url),'utf8')), /schema 1.3 required/);
  for(const platform of ['android','ios','web']){
    const documents=[comparisonFixture(['/verify'],'current-'+platform,{platform})];
    for(const doc of documents){
      const expected=diffSequences(doc,doc);assert.equal(expected.summary.field_changes,0);assert.equal(expected.summary.order_changes,0);
      assert.deepEqual(compareRequest({id:1,primary:doc,secondary:doc}).diff,expected);validateSourceReferences(expected,doc,doc);
      const path=join(directory,'input.json');writeFileSync(path,JSON.stringify(doc));
      const cli=spawnSync(process.execPath,['sequence-diff/cli.mjs','compare',path,path],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
      assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),expected);
    }
  }
});

test('cross-platform correspondence requires explicit recording and method ancestry, preserving exact names',()=>{
  const primary=comparisonFixture(['/verify'],'primary');
  for(const platform of ['ios','web']){
    const secondary=comparisonFixture(['/verify'],'secondary',{platform});
    const start=secondary.events.find(event=>event.event_type==='operation.started');start.data.name='Workflow.run()';start.data.origin.method='run()';
    let result=compareRequest({id:1,primary,secondary}).diff;
    assert.equal(result.summary.matched,0);
    const primaryRecording=result.pairs.find(pair=>pair.primary?.kind==='recording').primary.node_id;
    const secondaryRecording=result.pairs.find(pair=>pair.secondary?.kind==='recording').secondary.node_id;
    const profile={recording_matches:[{primary:primaryRecording,secondary:secondaryRecording}],matches:[]};
    result=compareRequest({id:2,primary,secondary,profile}).diff;
    const primaryOperation=result.pairs.find(pair=>pair.primary?.kind==='operation').primary.node_id;
    const secondaryOperation=result.pairs.find(pair=>pair.secondary?.kind==='operation').secondary.node_id;
    profile.matches.push({primary:primaryOperation,secondary:secondaryOperation});
    result=compareRequest({id:3,primary,secondary,profile}).diff;
    assert.equal(result.summary.unresolved,0);assert.equal(result.summary.matched,3);
    const operation=result.pairs.find(pair=>pair.primary?.kind==='operation');
    assert.equal(operation.matching.basis,'explicit');assert.equal(operation.primary.label,'Workflow.run');assert.equal(operation.secondary.label,'Workflow.run()');
    assert.ok(operation.changes.some(change=>change.path==='/operation/name'&&change.primary.value==='Workflow.run'&&change.secondary.value==='Workflow.run()'));
    assert.deepEqual(result,diffSequences(primary,secondary,profile));
  }
});

test('replacement, abort, stale callbacks, worker errors and dispose release every owned worker', async () => {
  const workers = [], client = new ComparisonClient({ workerFactory: () => {
    const worker = { terminated: 0, postMessage(data) { this.request = data; }, terminate() { this.terminated++; } }; workers.push(worker); return worker;
  } });
  const a = snapshot(), first = client.compare(a, a), firstRejected = assert.rejects(first, { name: 'AbortError' });
  const next = client.compare(a, a); await firstRejected;
  workers[0].onmessage({ data: compareRequest(workers[0].request) });
  workers[1].onmessage({ data: { ...compareRequest(workers[1].request), id: 999 } });
  assert.equal(client.pending.worker, workers[1]);
  workers[1].onmessage({ data: compareRequest(workers[1].request) });
  assert.deepEqual(await next, diffSequences(a.document, a.document));
  assert.equal(workers[0].terminated, 1); assert.equal(workers[1].terminated, 1);
  const controller = new AbortController(), aborted = client.compare(a, a, {}, { signal: controller.signal });
  const rejected = assert.rejects(aborted, { name: 'AbortError' }); controller.abort(); await rejected;
  assert.equal(workers[2].terminated, 1);
  const failed = client.compare(a, a); workers[3].onerror({ message: 'observed worker crash' });
  await assert.rejects(failed, /observed worker crash/); assert.equal(workers[3].terminated, 1);
  const disposed = client.compare(a, a), disposedRejected = assert.rejects(disposed, { name: 'AbortError' });
  client.dispose(); await disposedRejected; assert.equal(workers[4].terminated, 1);
  await assert.rejects(client.compare(a, a), /disposed/);
});

test('snapshot pagination pins the boundary, advances empty global pages and keeps viewer selection', async () => {
  const doc = document(), queries = [], client = new CollectorClient({ fetcher: async url => {
    const params = new URL('http://collector' + url).searchParams; queries.push(params);
    return json(params.get('after') === '0' ? { collector_id: 'collector', lines: [], cursor: 500, high_water: 502, has_more: true } : { collector_id: 'collector', lines: doc.events.map(JSON.stringify), cursor: 502, high_water: 502, has_more: false });
  } });
  client.collectorId = 'collector'; client.selection = { session_id: 'displayed-other-session' }; client.lines = ['displayed']; client.cursor = 90;
  const snap = await client.snapshotSession({ namespace: doc.session.namespace, id: doc.session.id, source_id: 'chosen-source' });
  assert.equal(snap.scope.kind, 'source-limited'); assert.equal(snap.boundary.high_water, 502);
  assert.equal(queries[1].get('high_water'), '502'); assert.equal(queries[1].get('after'), '500'); assert.equal(queries[0].get('source_id'), 'chosen-source');
  assert.equal(client.selection.session_id, 'displayed-other-session'); assert.equal(client.cursor, 90); assert.deepEqual(client.lines, ['displayed']);
});

test('snapshot reads reject limits, changing boundaries, collector resets and late stopped responses', async () => {
  const doc = document(), page = { collector_id: 'collector', lines: doc.events.map(JSON.stringify), cursor: 9, high_water: 9, has_more: false };
  const identity = { namespace: doc.session.namespace, id: doc.session.id };
  const limited = new CollectorClient({ fetcher: async () => json(page) }); limited.collectorId = 'collector';
  await assert.rejects(limited.snapshotSession(identity, { limits: { ...SNAPSHOT_LIMITS, events: 2 } }), /input limit/);
  await assert.rejects(limited.snapshotSession(identity, { limits: { ...SNAPSHOT_LIMITS, bytes: 2 } }), /input limit/);
  const reset = new CollectorClient({ fetcher: async () => json({ ...page, collector_id: 'replacement' }) }); reset.collectorId = 'collector';
  await assert.rejects(reset.snapshotSession(identity), { name: 'CollectorResetError' });
  let release;
  const stopped = new CollectorClient({ fetcher: () => new Promise(resolve => release = resolve) }); stopped.collectorId = 'collector';
  const pending = stopped.snapshotSession(identity), rejected = assert.rejects(pending, { name: 'AbortError' });
  stopped.stop(); release(json(page)); await rejected; assert.equal(stopped.snapshotReads.size, 0);
  let requests = 0;
  const badBoundary = new CollectorClient({ fetcher: async () => json(++requests === 1 ? { ...page, lines: [], cursor: 1, has_more: true } : { ...page, cursor: 10, high_water: 10 }) });
  await assert.rejects(badBoundary.snapshotSession(identity), /Invalid collector snapshot page/);
});

test('independent snapshot reads survive viewer selection changes and preserve arbitrary canonical event IDs', async () => {
  const doc=document();doc.events[0].event_id='__proto__';
  let release;
  const client=new CollectorClient({fetcher:()=>new Promise(resolve=>release=resolve)});client.collectorId='collector';
  const pending=client.snapshotSession(doc.session);
  client.select({session_namespace:'other-namespace',session_id:'other-session'});
  release(json({collector_id:'collector',lines:doc.events.map(JSON.stringify),cursor:doc.events.length,high_water:doc.events.length,has_more:false}));
  const acquired=await pending;
  assert.equal(acquired.evidence.__proto__[0].line,1);
  assert.equal(acquired.document.events[0].event_id,'__proto__');
  assert.equal(client.selection.session_id,'other-session');
  assert.equal(compareRequest({id:1,primary:acquired,secondary:acquired}).error,undefined);
});

test('live update checks ignore unrelated sessions and explicitly identify a changed collector', async () => {
  const doc=document(),snap=createComparisonSnapshot(doc,{kind:'collector',collectorId:'collector',highWater:5});
  const requests=[];
  const client=new CollectorClient({fetcher:async path=>{requests.push(path);return json(path.includes('/sources')?{collector_id:'collector',event_cursor:10}:{collector_id:'collector',lines:[],cursor:10,high_water:10,has_more:false});}});
  const update=await client.comparisonUpdates([snap]);
  assert.equal(update.changed,false);assert.equal(update.count,0);
  const params=new URL('http://collector'+requests[1]).searchParams;
  assert.equal(params.get('session_namespace'),doc.session.namespace);assert.equal(params.get('session_id'),doc.session.id);assert.equal(params.get('after'),'5');assert.equal(params.get('high_water'),'10');
  client.fetcher=async()=>json({collector_id:'replacement',event_cursor:0});
  assert.equal((await client.comparisonUpdates([snap])).collectorChanged,true);
});

test('comparison session catalog reads unscoped fixed-watermark pages independently from selected source',async()=>{
  const requests=[],client=new CollectorClient({fetcher:async path=>{requests.push(path);return json({collector_id:'collector',sessions:[{session_namespace:'other-source',session_id:'secondary'}],high_water:100,next_after:50,has_more:false});}});
  client.collectorId='collector';client.selection={source_id:'primary-source'};client.sessions=[{session_id:'displayed'}];
  const page=await client.comparisonSessions({after:20,highWater:100});
  const params=new URL('http://collector'+requests[0]).searchParams;
  assert.equal(params.get('source_id'),null);assert.equal(params.get('after'),'20');assert.equal(params.get('high_water'),'100');assert.equal(page.sessions[0].session_id,'secondary');assert.equal(client.sessions[0].session_id,'displayed');
});

test('real retained collector snapshots detect relevant later events while the active comparison stays immutable', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'comparison-live-')), collector = await startCollector({ directory, port: 0, activate: false });
  const lines = text.trim().split('\n'), producer = JSON.parse(lines[0]).data.producer;
  const source = await collector.enroll({ version: 2, registration_id: randomUUID(), platform: producer.platform, environment_id: 'comparison-test', app_id: producer.app_id, installation_id: randomUUID() });
  const client = new CollectorClient({ token: collector.browserToken, fetcher: (path, options) => fetch(collector.origin + path, options) });
  t.after(async () => { client.stop(); await collector.close(); rmSync(directory, { recursive: true, force: true }); });
  await collector.ingest(source.source_token, lines.slice(0, 3).join('\n') + '\n');
  const doc = document(), identity = { namespace: doc.session.namespace, id: doc.session.id };
  const primary = await client.snapshotSession(identity), secondary = await client.snapshotSession(identity);
  assert.equal(primary.eventCount, 3); assert.equal(client.lines.length, 0);
  const initial = compareRequest({ id: 1, primary, secondary }).diff, retained = JSON.stringify(initial);
  assert.equal((await client.comparisonUpdates([primary, secondary])).changed, false);
  await collector.ingest(source.source_token, lines.slice(3).join('\n') + '\n');
  const updates = await client.comparisonUpdates([primary, secondary]);
  assert.equal(updates.changed, true); assert.equal(updates.bySnapshot[primary.id], lines.length - 3);
  assert.equal(JSON.stringify(initial), retained); assert.equal(primary.eventCount, 3);
  const recomputed = await client.snapshotSession(identity);
  assert.equal(recomputed.eventCount, lines.length); assert.ok(recomputed.boundary.high_water > primary.boundary.high_water);
  assert.deepEqual(compareRequest({ id: 2, primary: recomputed, secondary: recomputed }).diff, diffSequences(recomputed.document, recomputed.document));
});
