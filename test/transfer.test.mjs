import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaptureStore } from '../collector/store.mjs';
import { startCollector } from '../collector/server.mjs';
import { localCertificate } from '../collector/tls.mjs';
const lines=readFileSync(new URL('../examples/success.ndjson',import.meta.url),'utf8').trim().split('\n');
const event=JSON.parse(lines[0]);
const encode=events=>events.map(e=>typeof e==='string'?e:JSON.stringify(e)).join('\n')+'\n';
const metadata=(extra={})=>({version:2,registration_id:randomUUID(),platform:'android',environment_id:'test-device',app_id:'dev.test',installation_id:randomUUID(),journal_id:randomUUID(),instance_id:randomUUID(),...extra});
async function store(t,limits={}) {
  const directory=mkdtempSync(join(tmpdir(),'transfer-v2-'));
  const s=new CaptureStore(directory,limits);await s.ready;
  t.after(async()=>{await s.close();rmSync(directory,{recursive:true,force:true});});return s;
}
async function enroll(s,md=metadata()) {const grant=await s.ticket({principal:'test'});return s.register(grant.enrollment_token,md);}
async function collector(t,options={}) {
  const directory=mkdtempSync(join(tmpdir(),'http-v2-'));const c=await startCollector({directory,port:0,...options});
  t.after(async()=>{await c.close();rmSync(directory,{recursive:true,force:true});});return c;
}
const status=code=>error=>error.status===code;
test('commit, lost-response replay, source credentials and checkpoints survive restart',async t=>{
  const s=await store(t),source=await enroll(s),text=encode(lines.slice(0,3));
  const ack=await s.ingest(source.source_token,text,{key:'journal',value:{generation:'g',offset:Buffer.byteLength(text)}});
  assert.equal(ack.accepted,3);assert.equal(ack.recordings[0].highest_contiguous_sequence,3);
  assert.equal(ack.source_id,source.source_id);assert.equal(ack.collector_id,s.config.collector_id);
  const id=s.config.collector_id;await s.close();
  const restored=new CaptureStore(s.directory);await restored.ready;t.after(()=>restored.close());
  assert.equal(restored.config.collector_id,id);assert.equal(restored.cursor,3);
  assert.equal((await restored.ingest(source.source_token,text)).duplicates,3);
  assert.deepEqual(await restored.checkpoint(source.source_id,'journal'),{generation:'g',offset:Buffer.byteLength(text)});
  assert.equal(restored.cursor,3);await restored.close();
});
test('conflicting IDs, sequence and session identities roll back the whole batch and checkpoint',async t=>{
  const s=await store(t),source=await enroll(s);await s.ingest(source.source_token,encode([lines[0]]));
  for(const bad of [{...event,timestamp:'2026-01-01T00:00:00.000Z'},{...event,event_id:'different-event'}, {...JSON.parse(lines[2]),session_id:'different-session'}]) {
    await assert.rejects(s.ingest(source.source_token,encode([lines[1],bad]),{key:'journal',value:{offset:99}}),status(409));
    assert.equal(s.cursor,1);assert.equal(await s.checkpoint(source.source_id,'journal'),null);
  }
  assert.equal((await s.ingest(source.source_token,encode([lines[1]]))).accepted,1);
});
test('new recording cannot change identity within the first batch',async t=>{
  const s=await store(t),source=await enroll(s);
  await assert.rejects(s.ingest(source.source_token,encode([lines[0],{...JSON.parse(lines[1]),session_id:'other'}])),status(409));assert.equal(s.cursor,0);
});
test('concurrent native push and file replay commit one owner and deduplicate either arrival order',async t=>{
  const c=await collector(t),source=await c.enroll(metadata()),other=await c.enroll(metadata());
  const text=encode(lines),upload=token=>fetch(c.origin+'/api/v2/events',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-ndjson'},body:text});
  const [httpResult,pullResult]=await Promise.all([upload(source.source_token),c.ingest(source.source_token,text,{key:'file',value:{generation:'g',offset:Buffer.byteLength(text)}})]);
  assert.equal(httpResult.status,200);const pushed=await httpResult.json();
  assert.equal(pushed.accepted+pullResult.accepted,lines.length);assert.equal(pushed.duplicates+pullResult.duplicates,lines.length);
  assert.equal(c.store.cursor,lines.length);assert.equal((await upload(other.source_token)).status,409);
  assert.equal((await c.store.sources()).sources.length,2);
});
test('out-of-order and canonical replay remain acknowledgeable when new writes reach capacity',async t=>{
  const text=encode(lines.slice(0,2)),s=await store(t,{journalBytes:Buffer.byteLength(text)}),source=await enroll(s);
  assert.equal((await s.ingest(source.source_token,encode([lines[1]]))).recordings[0].highest_contiguous_sequence,0);
  const reversed=Object.fromEntries(Object.entries(event).reverse());
  const ack=await s.ingest(source.source_token,encode([reversed,event]));assert.equal(ack.accepted,1);assert.equal(ack.duplicates,1);assert.equal(ack.recordings[0].highest_contiguous_sequence,2);
  await assert.rejects(s.ingest(source.source_token,encode([lines[2]])),status(507));
  assert.equal((await s.ingest(source.source_token,text)).duplicates,2);assert.equal(s.cursor,2);
});
test('current batches reject partial JSON, invalid schema and oversize data without advancing',async t=>{
  const s=await store(t),source=await enroll(s);
  for(const text of ['{}\n',lines[0],'\n','oops\n',encode([{...event,schema_version:'1.1'}])])await assert.rejects(s.ingest(source.source_token,text),status(400));
  await assert.rejects(s.ingest(source.source_token,'x'.repeat(1024*1024+1)),status(413));
  await assert.rejects(s.page(99),status(400));assert.equal(s.cursor,0);
});
test('filtered pagination advances through empty pages and pins an immutable export high-water',async t=>{
  const s=await store(t),a=await enroll(s),b=await enroll(s);
  await s.ingest(a.source_token,encode(lines));const H=s.cursor;
  const empty=await s.page({source_id:b.source_id,limit:2});assert.equal(empty.lines.length,0);assert.equal(empty.next_after,2);assert.equal(empty.has_more,true);
  await s.ingest(b.source_token,encode([{...event,event_id:'new',recording_id:'new'}]));
  let after=0,out=[];while(after<H){const p=await s.page({after,high_water:H,limit:2});out.push(...p.lines);assert.ok(p.next_after>after);after=p.next_after;}
  assert.deepEqual(out,lines);assert.equal((await s.page({after:H,high_water:H})).has_more,false);
});
test('HTTP reader/source/enrollment roles are separate, same-origin constrained and SSE signals committed changes',async t=>{
  const c=await collector(t),source=await c.enroll(metadata()),request=(path,options={})=>fetch(c.origin+path,options);
  const upload=(text,token=source.source_token)=>request('/api/v2/events',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-ndjson'},body:text});
  assert.equal((await request('/api/v2/events')).status,401);
  assert.equal((await request('/api/v2/events',{headers:{Authorization:'Bearer '+source.source_token}})).status,401);
  assert.equal((await upload(encode([lines[0]]),c.browserToken)).status,401);
  assert.equal((await request('/api/v2/health',{headers:{Origin:'https://foreign.test'}})).status,403);
  const spoof=await new Promise((ok,fail)=>{http.get(c.origin+'/api/v2/health',{headers:{Host:'foreign.test'}},r=>{r.resume();ok(r.statusCode);}).on('error',fail);});assert.equal(spoof,403);
  const controller=new AbortController();t.after(()=>controller.abort());
  const stream=await request('/api/v2/stream',{headers:{Authorization:'Bearer '+c.browserToken},signal:controller.signal}),reader=stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/event: ready/);
  assert.equal((await upload(encode([lines[0]]))).status,200);assert.match(new TextDecoder().decode((await reader.read()).value),/event: changed/);controller.abort();
  assert.equal((await upload(Buffer.from([255,10]))).status,400);assert.equal((await upload('x'.repeat(1024*1024+1))).status,413);
  const downloaded=await request('/api/v2/download',{headers:{Authorization:'Bearer '+c.browserToken}});assert.equal(await downloaded.text(),encode([lines[0]]));
  assert.equal((await request('/api/v1/events',{headers:{Authorization:'Bearer '+c.browserToken}})).status,404);
});
test('one owner locks the database and close permits fresh reopening',async t=>{
  const s=await store(t),second=new CaptureStore(s.directory);await assert.rejects(second.ready,status(409));await second.worker.terminate();
  await s.close();const reopened=new CaptureStore(s.directory);await reopened.ready;assert.equal(reopened.cursor,0);await reopened.close();
});
test('old state is rejected and left byte-for-byte untouched',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'unsupported-v2-'));const file=join(directory,'capture.ndjson'),text=encode(lines);writeFileSync(file,text);
  const s=new CaptureStore(directory);await assert.rejects(s.ready,status(409));await s.worker.terminate();assert.equal(readFileSync(file,'utf8'),text);rmSync(directory,{recursive:true,force:true});
});
test('paired HTTPS accepts source uploads and keeps viewer/read APIs unavailable',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'https-v2-')),tls={...localCertificate(directory,'127.0.0.1'),port:0,bind:'127.0.0.1'};
  const c=await startCollector({directory,port:0,tls});t.after(async()=>{await c.close();rmSync(directory,{recursive:true,force:true});});const source=await c.enroll(metadata({platform:'ios'}));
  const request=(path,method='GET',body='')=>new Promise((ok,fail)=>{const r=https.request(c.connections[1].endpoint+path,{method,ca:readFileSync(tls.cert),headers:{Authorization:'Bearer '+(method==='POST'?source.source_token:c.browserToken),'Content-Type':'application/x-ndjson'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});r.on('error',fail);r.end(body);});
  assert.equal(await request('/api/v2/events','POST',encode([lines[0]])),200);
  for(const path of ['/api/v2/events','/api/v2/pairing','/api/v2/bootstrap','/'])assert.equal(await request(path),404);
  assert.match(c.connections[1].certificate_sha256,/^[a-f0-9]{64}$/);
});
test('maximum-length identities fit the native ACK bound',async t=>{
  const s=await store(t),source=await enroll(s),ended=JSON.parse(lines.at(-1));
  for(const character of ['a','漢']){const records=Array.from({length:500},(_,i)=>({...ended,sequence:1,event_id:(character+'-event-'+i).padEnd(512,character),recording_id:(character+'-record-'+i).padEnd(512,'r')}));while(Buffer.byteLength(encode(records))>1024*1024)records.pop();const ack=await s.ingest(source.source_token,encode(records));assert.ok(Buffer.byteLength(JSON.stringify(ack))<=2*1024*1024);assert.equal(ack.accepted,records.length);}
});
test('stalled commit leaves HTTP/SSE responsive and close retains ownership until queued writes finish',async t=>{
  const buffer=new SharedArrayBuffer(8),gate=new Int32Array(buffer),c=await collector(t,{testCommitGate:buffer,limits:{queueJobs:2}});
  const release=()=>{Atomics.store(gate,0,1);Atomics.notify(gate,0);};t.after(release);
  const source=await c.enroll(metadata());
  const controller=new AbortController();t.after(()=>controller.abort());
  const stream=await fetch(c.origin+'/api/v2/stream',{headers:{Authorization:'Bearer '+c.browserToken},signal:controller.signal}),reader=stream.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: ready/);
  const commit=c.ingest(source.source_token,encode([lines[0]]));
  const deadline=Date.now()+3000;while(!Atomics.load(gate,1)){if(Date.now()>deadline)throw new Error('Commit did not enter gate');await new Promise(ok=>setTimeout(ok,5));}
  try {
    assert.equal(c.store.cursor,0);const health=await fetch(c.origin+'/api/v2/health',{signal:AbortSignal.timeout(500)});assert.equal(health.status,200);
    const second=c.ingest(source.source_token,encode([lines[1]]));const reserved=c.store.sources();
    await assert.rejects(c.ingest(source.source_token,encode([lines[2]])),status(429));
    const closing=c.store.close();const competing=new CaptureStore(c.store.directory);await assert.rejects(competing.ready,status(409));
    await assert.rejects(c.store.sources(),status(503));
    release();assert.equal((await commit).accepted,1);assert.equal((await second).accepted,1);assert.equal((await reserved).sources.length,1);await closing;
  } finally {release();controller.abort();}
});
test('SIGKILL before commit leaves no event, after commit survives lost ACK with stable source attribution',async t=>{
  const {fork}=await import('node:child_process');const{once}=await import('node:events');
  for(const stage of ['before','after']){
    const dir=mkdtempSync(join(tmpdir(),'crash-v2-'));let restored,child;
    try{
      child=fork(new URL('./fixtures/crash-store.mjs',import.meta.url),[dir,stage,encode(lines.slice(0,3))],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
      let errors='';child.stderr.on('data',c=>errors+=c);
      const next=()=>new Promise((ok,fail)=>{const timer=setTimeout(()=>{cleanup();fail(new Error('Crash fixture timed out: '+errors));},5000);const message=m=>{cleanup();ok(m);};const exit=()=>{cleanup();fail(new Error('Crash fixture exited early: '+errors));};function cleanup(){clearTimeout(timer);child.off('message',message);child.off('exit',exit);}child.once('message',message);child.once('exit',exit);});
      const ready=await next();assert.equal(ready.kind,'ready');const result=next();child.send('ingest');assert.equal((await result).kind,stage==='before'?'blocked':'committed');
      const exit=once(child,'exit');child.kill('SIGKILL');await exit;
      restored=new CaptureStore(dir);await restored.ready;assert.equal(restored.config.collector_id,ready.collector_id);assert.equal(restored.cursor,stage==='before'?0:3);
      const ack=await restored.ingest(ready.source.source_token,encode(lines.slice(0,3)));assert.equal(ack.accepted,stage==='before'?3:0);assert.equal(ack.duplicates,stage==='before'?0:3);assert.equal(ack.source_id,ready.source.source_id);
    }finally{if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGKILL');await restored?.close();rmSync(dir,{recursive:true,force:true});}
  }
});

 test('local discovery binds an enrolled installation without changing ownership and rejects cloned credentials',async t=>{
  const s=await store(t),md=metadata({environment_id:'installation-environment'}),source=await enroll(s,md);
  await s.ingest(source.source_token,encode(lines));
  const local={...md,environment_id:'android:usb-one:user-0',environment_name:'USB device'};
  assert.equal((await s.bindLocal(source.source_token,local)).source_id,source.source_id);
  assert.equal((await s.ingest(source.source_token,encode(lines),{key:'canonical',value:{offset:Buffer.byteLength(encode(lines))}})).duplicates,lines.length);
  const registry=await s.sources();assert.equal(registry.sources.length,1);assert.equal(registry.sources[0].environment_id,local.environment_id);
  await assert.rejects(s.bindLocal(source.source_token,{...local,environment_id:'android:usb-two:user-0'}),status(409));
  await assert.rejects(s.bindLocal(source.source_token,{...local,app_id:'other.app'}),status(409));assert.equal(s.cursor,lines.length);
});

 test('body-heavy pages obey byte limits while filtered scans advance without returning bodies',async t=>{
  const s=await store(t),source=await enroll(s),other=await enroll(s);
  const original=JSON.parse(readFileSync(new URL('../examples/redacted-truncated.ndjson',import.meta.url),'utf8').trim().split('\n')[4]);
  const content='x'.repeat(200000),events=Array.from({length:20},(_,i)=>({...original,event_id:'large-body-'+i,sequence:i+1,data:{...original.data,body:{...original.data.body,media_type:'text/plain',observed_bytes:content.length,total_bytes:content.length,stored_bytes:content.length,content:{encoding:'utf-8',data:content}}}}));
  for(let i=0;i<events.length;i+=4)await s.ingest(source.source_token,encode(events.slice(i,i+4)));
  let cursor=0,total=0,pages=0;
  do{const page=await s.page({after:cursor,high_water:20,source_id:source.source_id});assert.ok(Buffer.byteLength(encode(page.lines))<=s.limits.batchBytes);assert.ok(page.cursor>cursor);cursor=page.cursor;total+=page.lines.length;pages++;}while(cursor<20);
  assert.equal(total,20);assert.ok(pages>1);
  const filtered=await s.page({source_id:other.source_id});assert.deepEqual(filtered.lines,[]);assert.equal(filtered.cursor,20);assert.equal(filtered.has_more,false);
});
