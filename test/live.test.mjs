import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCollector } from '../collector/server.mjs';
import { followJournal } from '../collector/follower.mjs';
const text=readFileSync(new URL('../examples/handler-http.ndjson',import.meta.url),'utf8');
async function setup(t){const dir=mkdtempSync(join(tmpdir(),'follower-v2-'));const collector=await startCollector({directory:dir,port:0});t.after(async()=>{await collector.close();rmSync(dir,{recursive:true,force:true});});const connection=await collector.enroll({version:2,registration_id:randomUUID(),platform:'android',environment_id:'emulator',app_id:'dev.test',installation_id:randomUUID()});return {collector,connection};}
test('follower retrieves only durable complete lines with bounded reads and a committed checkpoint',async t=>{
  const {collector,connection}=await setup(t),bytes=Buffer.from(text+'{"tail":'),reads=[];
  const args={collector,connection,key:'j',generation:'g',identity:'file-1',durableBytes:bytes.length,read:async(offset,count)=>{reads.push({offset,count});return bytes.subarray(offset,offset+count);}};
  await followJournal(args);assert.equal(collector.store.cursor,text.trim().split('\n').length);const cp=await collector.store.checkpoint(connection.source_id,'j');assert.equal(cp.offset,Buffer.byteLength(text));
  assert.ok(reads.every(r=>r.count<=65536));assert.equal((await collector.store.page(0)).lines.join('\n')+'\n',text);
  reads.length=0;await followJournal(args);assert.equal(collector.store.cursor,text.trim().split('\n').length);assert.ok(reads.every(r=>r.offset>=cp.offset-64));
});
test('rejected follower batch keeps its previous checkpoint and resumes exact IDs',async t=>{
  const {collector,connection}=await setup(t),bytes=Buffer.from(text);const args={collector,connection,key:'j',generation:'g',identity:'file-1',durableBytes:bytes.length,read:async(offset,count)=>bytes.subarray(offset,offset+count)};
  const real=collector.ingest;collector.ingest=async()=>{throw new Error('storage full');};await assert.rejects(followJournal(args),/storage full/);assert.equal(await collector.store.checkpoint(connection.source_id,'j'),null);assert.equal(collector.store.cursor,0);
  collector.ingest=real;await followJournal(args);assert.equal(collector.store.cursor,text.trim().split('\n').length);
});
test('generation replacement replays stable events without duplicating collected history',async t=>{
  const {collector,connection}=await setup(t),bytes=Buffer.from(text);const args={collector,connection,key:'j',generation:'g',identity:'file-1',durableBytes:bytes.length,read:async(offset,count)=>bytes.subarray(offset,offset+count)};
  await followJournal(args);const H=collector.store.cursor;await followJournal({...args,generation:'g2',identity:'file-2'});assert.equal(collector.store.cursor,H);assert.equal((await collector.store.checkpoint(connection.source_id,'j')).generation,'g2');
});
test('follower preserves multibyte tails until a complete durable newline and resumes bounded short reads',async t=>{
  const {collector,connection}=await setup(t),events=text.trim().split('\n').slice(0,2).map(JSON.parse);
  events[1].data.name='日本語 🧭';
  const first=Buffer.from(JSON.stringify(events[0])+'\n'),second=Buffer.from(JSON.stringify(events[1])+'\n'),bytes=Buffer.concat([first,second]);
  const split=first.length+second.indexOf(Buffer.from('🧭'))+2;
  const args={collector,connection,key:'unicode',generation:'g',identity:'file',durableBytes:split,read:async(offset,count)=>bytes.subarray(offset,offset+Math.min(count,7))};
  await followJournal(args);assert.equal(collector.store.cursor,1);assert.equal((await collector.store.checkpoint(connection.source_id,'unicode')).offset,first.length);
  await followJournal({...args,durableBytes:bytes.length});assert.equal(collector.store.cursor,2);assert.equal((await collector.store.page(0)).lines[1],JSON.stringify(events[1]));
});
test('boundary mismatch and missing cursor safely replay stable IDs without skipping new events',async t=>{
  const {collector,connection}=await setup(t);let bytes=Buffer.from(text);const reads=[];
  const args={collector,connection,key:'original',generation:'g',identity:'same-file',durableBytes:bytes.length,read:async(offset,count)=>{reads.push(offset);return bytes.subarray(offset,offset+count);}};
  await followJournal(args);const H=collector.store.cursor;
  const extra={...JSON.parse(text.trim().split('\n')[0]),recording_id:'added-recording',event_id:'added-event'};
  // Changed serialization is identical semantically, but invalidates the checkpoint boundary.
  bytes=Buffer.from(text.trim().split('\n').map(line=>JSON.stringify(JSON.parse(line),null,0)+' \n').join('')+JSON.stringify(extra)+'\n');
  reads.length=0;await followJournal({...args,durableBytes:bytes.length});assert.ok(reads.includes(0));assert.equal(collector.store.cursor,H+1);
  await followJournal({...args,key:'lost-cursor',durableBytes:bytes.length});assert.equal(collector.store.cursor,H+1);assert.equal((await collector.store.checkpoint(connection.source_id,'lost-cursor')).offset,bytes.length);
});
test('a legal maximum-size line crossing read chunks is not rejected with following records',async t=>{
  const {collector,connection}=await setup(t),fixture=readFileSync(new URL('../examples/redacted-truncated.ndjson',import.meta.url),'utf8').trim().split('\n'),large=JSON.parse(fixture[4]),body=large.data.body,target=1024*1024-64;
  body.content.data='';body.observed_bytes=0;body.total_bytes=0;body.stored_bytes=0;
  for(let i=0;i<3;i++){const length=body.content.data.length+target-Buffer.byteLength(JSON.stringify(large)+'\n');body.content.data='x'.repeat(length);body.observed_bytes=length;body.total_bytes=length;body.stored_bytes=length;}
  const line=JSON.stringify(large)+'\n';assert.equal(Buffer.byteLength(line),target);
  const bytes=Buffer.from(fixture[0]+'\n'+line+fixture[5]+'\n'+fixture[7]+'\n'),args={collector,connection,key:'large',generation:'g',identity:'file',durableBytes:bytes.length,read:async(offset,count)=>bytes.subarray(offset,offset+count)};
  await followJournal(args);assert.equal(collector.store.cursor,1);
  await followJournal(args);assert.equal(collector.store.cursor,2);
  await followJournal(args);assert.equal(collector.store.cursor,4);assert.equal((await collector.store.checkpoint(connection.source_id,'large')).offset,bytes.length);
});
test('oversized and invalid UTF-8 complete lines never advance a follower checkpoint',async t=>{
  const {collector,connection}=await setup(t);
  for(const [key,bytes,pattern] of [['oversize',Buffer.from('x'.repeat(1024*1024)+'\n'),/line exceeds batch limit/],['invalid',Buffer.from([255,10]),/encoded data was not valid/]]){
    const args={collector,connection,key,generation:'g',identity:'file',durableBytes:bytes.length,read:async(offset,count)=>bytes.subarray(offset,offset+count)};
    await assert.rejects(followJournal(args),pattern);assert.equal(await collector.store.checkpoint(connection.source_id,key),null);assert.equal(collector.store.cursor,0);
  }
});
test('retained historical sample evidence is private and obsolete capture versions are not advertised as current',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../samples/live/manifest.json',import.meta.url),'utf8'));
  for(const sample of manifest.files){const raw=readFileSync(new URL('../samples/live/'+sample.file,import.meta.url),'utf8');assert.equal(raw.includes('emilyspass'),false);assert.equal(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(raw),false);}
});
