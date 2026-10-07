import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerLogger, parseTraceparent } from '../server-sdk/index.mjs';
import { validateCapture } from '../shared/validate.mjs';
import { createLocalFileAdapter, createCloudflareAdapter, createJSONMappingParser, canonicalParser, parseRecords } from '../collector/adapters.mjs';
import { startCollector } from '../collector/server.mjs';
const trace = 'a'.repeat(32), parent = 'b'.repeat(16);
async function capture(service = 'A') {
  const events = [];
  const logger = createServerLogger({service,sessionNamespace:'test',emit:event=>events.push(event),propagationOrigins:['http://b'],fetch:async()=>new Response('ok')});
  await logger.handleRequest(new Request('http://a/request', {headers:{traceparent:`00-${trace}-${parent}-01`}}), async ctx => { ctx.log('incoming'); await Promise.all([ctx.operation('work', async c=>{await c.fetch('http://b/task');}),ctx.fetch('http://b/other')]); return new Response('ok'); });
  return events;
}
test('server contexts propagate exact causal parent and remain isolated under concurrency', async()=> {
  const events = [], transmitted = [], diagnostics = [];
  const logger = createServerLogger({service:'A',sessionNamespace:'test',emit:e=>events.push(e),onDiagnostic:x=>diagnostics.push(x),propagationOrigins:['http://b'],fetch:async r=>{transmitted.push(r.headers.get('traceparent'));return new Response('ok');}});
  let retained;
  await Promise.all(['a','c'].map(ch=>logger.handleRequest(new Request('http://a/',{headers:{traceparent:`00-${ch.repeat(32)}-${parent}-01`}}),async ctx=>{retained=ctx;await ctx.operation('work',async child=>{await child.fetch('http://b/');});return new Response('ok');})));
  assert.equal(new Set(transmitted.map(x=>parseTraceparent(x).trace_id)).size,2);
  const result = validateCapture(events.map(x=>JSON.stringify(x)).join('\n')+'\n'); assert.equal(result.valid,true,result.errors.join('\n'));
  const count=events.length;retained.log('too late');assert.equal(events.length,count);assert.ok(diagnostics.includes('context_closed'));
  for (const e of events.filter(x=>x.event_type==='operation.started'&&x.data.span_kind==='server')) assert.equal(e.context.parent_scope,'remote');
});
test('raw mappings preserve stable identity and attach messages without inventing spans',()=>{
  const parser=createJSONMappingParser({namespace:'test',service:'legacy',fields:{message:'msg',timestamp:'ts',trace_id:'trace',span_id:'span'}});
  const record={msg:'hello',ts:'2026-10-07T00:00:00Z',trace,span:parent};
  const a=parser(record,'file:42'),b=parser(record,'file:42');assert.deepEqual(a,b);assert.equal(a[0].event_type,'log.message');assert.equal(a[0].extensions['source.clock'],'monotonic_unavailable');
  assert.equal(canonicalParser({http_sequence:a[0]})[0].event_id,a[0].event_id);
});
test('collection joins independent sessions, retains metadata, deduplicates replay and authenticates controls',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sources-'));let collector;
  try {
    const server=await capture(),file=join(dir,'server.ndjson');await writeFile(file,server.map(x=>JSON.stringify({http_sequence:x})).join('\n')+'\n');
    collector=await startCollector({directory:join(dir,'collector'),port:0,sources:[createLocalFileAdapter({id:'local',path:file,metadata:{environment_id:'local',app_id:'A',installation_id:'local-A'}})]});
    const client=await capture('client');for(const e of client)e.session_id='mobile-session';
    const cred=await collector.enroll({platform:'server',registration_id:'test-client',environment_id:'client',app_id:'client',installation_id:'client'});await collector.ingest(cred.source_token,client.map(x=>JSON.stringify(x)).join('\n')+'\n');
    const headers={authorization:`Bearer ${collector.browserToken}`,'content-type':'application/json','sec-fetch-site':'same-origin','x-network-log-viewer':'1'};
    const first=await fetch(collector.origin+'/api/v2/collections',{method:'POST',headers,body:JSON.stringify({session_namespace:'test',session_id:'mobile-session'})});assert.equal(first.status,202);const job=await first.json();
    await collector.collections.jobs.get(job.job_id).task;assert.equal(collector.collections.get(job.job_id).state,'completed');assert.equal(collector.collections.get(job.job_id).event_count,server.length);
    const page=await collector.store.page({session_namespace:'test',session_id:'mobile-session',include_related:true});assert.equal(page.lines.length,server.length+client.length);assert.ok(page.lines.map(JSON.parse).some(x=>x.data.producer?.service_name==='A'));
    const second=await collector.collections.start({trace_ids:[trace]});await collector.collections.jobs.get(second.job_id).task;assert.equal(collector.collections.get(second.job_id).event_count,0);
    const forbidden=await fetch(collector.origin+'/api/v2/collections',{method:'POST',headers:{authorization:headers.authorization,'content-type':'application/json'},body:JSON.stringify({trace_ids:[trace]})});assert.equal(forbidden.status,403);
  } finally {await collector?.close();await rm(dir,{recursive:true,force:true});}
});
test('Cloudflare retained endpoint bounds provider response and preserves parser envelope',async()=>{
  const events=await capture();let body;
  const adapter=createCloudflareAdapter({id:'cf',endpoint:'https://example.test/logs',metadata:{},fetch:async(_url,options)=>{body=JSON.parse(options.body);return Response.json({records:events,has_more:false,sampled:true});}});
  const result=await adapter.query({trace_ids:[trace],max_records:500,max_bytes:1048576,signal:new AbortController().signal});assert.deepEqual(body.trace_ids,[trace]);assert.equal(result.sampled,true);assert.equal(result.records.length,events.length);
});
test('local pagination collects later traces and lifecycle metadata across page boundaries',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sources-pages-'));let collector;
  try {
    const events=await capture();const lines=[JSON.stringify({http_sequence:events[0]}),...Array.from({length:600},()=> 'ordinary raw application line'),...events.slice(1).map(e=>'[mf:info] '+JSON.stringify({http_sequence:e}))];
    const file=join(dir,'raw.log');await writeFile(file,lines.join('\n')+'\n');
    collector=await startCollector({directory:join(dir,'collector'),port:0,sources:[createLocalFileAdapter({id:'raw',path:file,metadata:{environment_id:'local',app_id:'A',installation_id:'A'}})]});
    const job=await collector.collections.start({trace_ids:[trace]});await collector.collections.jobs.get(job.job_id).task;
    assert.equal(collector.collections.get(job.job_id).state,'completed');assert.equal(collector.collections.get(job.job_id).event_count,events.length);assert.equal(collector.collections.get(job.job_id).sources[0].unmatched,600);
    const result=validateCapture((await collector.store.page({trace_id:trace})).lines.join('\n')+'\n');assert.equal(result.valid,true,result.errors.join('\n'));
  }finally{await collector?.close();await rm(dir,{recursive:true,force:true});}
});
test('collection active jobs deduplicate and cancellation completes even for uncooperative adapter',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sources-cancel-'));let collector;
  try {
    collector=await startCollector({directory:dir,port:0,sources:[{id:'stalled',kind:'custom',metadata:{environment_id:'local',app_id:'A',installation_id:'A'},parser:canonicalParser,query:()=>new Promise(()=>{})}]});
    const first=await collector.collections.start({trace_ids:[trace]}),second=await collector.collections.start({trace_ids:[trace]});assert.equal(first.job_id,second.job_id);
    collector.collections.cancel(first.job_id);await collector.collections.jobs.get(first.job_id).task;assert.equal(collector.collections.get(first.job_id).state,'cancelled');
  }finally{await collector?.close();await rm(dir,{recursive:true,force:true});}
});
test('related snapshot supports more than64 traces and excludes later joined records',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sources-many-'));let collector;
  try {
    collector=await startCollector({directory:dir,port:0});const cred=await collector.enroll({platform:'server',registration_id:'many',environment_id:'many',app_id:'A',installation_id:'A'});
    const events=Array.from({length:70},(_,i)=>({schema_version:'1.3',event_type:'log.message',event_id:`many:${i}`,session_namespace:'test',session_id:'many',recording_id:`many-record:${i}`,sequence:1,timestamp:new Date().toISOString(),monotonic_ns:'0',context:{trace_id:(i+1).toString(16).padStart(32,'0'),span_id:'1'.repeat(16),parent_span_id:null,parent_scope:'none'},data:{message:'raw',level:'info'}}));
    await collector.ingest(cred.source_token,events.map(JSON.stringify).join('\n')+'\n');const high=collector.store.cursor;
    await collector.ingest(cred.source_token,JSON.stringify({...events[0],event_id:'later',recording_id:'later-record',session_id:'later'})+'\n');
    const snapshot=await collector.store.page({session_namespace:'test',session_id:'many',include_related:true,high_water:high});assert.equal(snapshot.lines.length,70);
    const expanded=await collector.store.page({session_namespace:'test',session_id:'many',include_related:true});assert.equal(expanded.lines.length,71);
    await assert.rejects(collector.collections.start({session_namespace:'test',session_id:'many'}),/64 traces/);
  }finally{await collector?.close();await rm(dir,{recursive:true,force:true});}
});
test('forwarded incoming headers allocate distinct outgoing spans under concurrency',async()=>{
  const events=[],headers=[];const incoming=`00-${trace}-${parent}-01`;
  const logger=createServerLogger({service:'A',sessionNamespace:'test',emit:e=>events.push(e),propagationOrigins:['http://b'],fetch:async request=>{headers.push(request.headers.get('traceparent'));return new Response('ok');}});
  await logger.handleRequest(new Request('http://a/',{headers:{traceparent:incoming}}),async context=>{await Promise.all([context.fetch('http://b/',{headers:{traceparent:incoming}}),context.fetch('http://b/',{headers:{traceparent:incoming}})]);return new Response('ok');});
  assert.equal(new Set(headers.map(x=>parseTraceparent(x).span_id)).size,2);assert.ok(headers.every(x=>parseTraceparent(x).span_id!==parent));
  const result=validateCapture(events.map(JSON.stringify).join('\n')+'\n');assert.equal(result.valid,true,result.errors.join('\n'));
});
test('trace-only raw log correlation retains honest unspanned observations',async()=>{
  const parser=createJSONMappingParser({namespace:'test',service:'legacy',fields:{message:'msg',timestamp:'ts',trace_id:'trace'}});
  const event=parser({msg:'trace info',ts:new Date().toISOString(),trace},'raw:trace-only')[0];assert.equal(event.context,undefined);assert.equal(event.data.trace_id,trace);
  const dir=await mkdtemp(join(tmpdir(),'sources-trace-only-'));let collector;
  try {
    collector=await startCollector({directory:dir,port:0});const cred=await collector.enroll({platform:'server',registration_id:'trace-only',environment_id:'local',app_id:'A',installation_id:'A'});await collector.ingest(cred.source_token,JSON.stringify(event)+'\n');assert.deepEqual(await collector.store.traceSeeds({session_id:trace}),[trace]);assert.equal((await collector.store.page({trace_id:trace})).lines.length,1);
  } finally {await collector?.close();await rm(dir,{recursive:true,force:true});}
});
test('client-only latest sessions filter server traffic before limit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sources-follow-'));let collector;
 try {
  collector=await startCollector({directory:dir,port:0});
  const client=await collector.enroll({platform:'web',registration_id:'client-follow',environment_id:'browser',app_id:'web',installation_id:'web',journal_id:'page',origin:'http://localhost:4180'});
  const server=await collector.enroll({platform:'server',registration_id:'server-follow',environment_id:'server',app_id:'A',installation_id:'A'});
  const events=await capture();for(const e of events)e.session_id='client-session';await collector.ingest(client.source_token,events.map(JSON.stringify).join('\n')+'\n');
  const many=Array.from({length:110},(_,i)=>({schema_version:'1.3',event_type:'log.message',event_id:`follow:${i}`,session_namespace:'test',session_id:`server:${i}`,recording_id:`follow:${i}`,sequence:1,timestamp:new Date().toISOString(),monotonic_ns:'0',data:{message:'raw',level:'info'}}));await collector.ingest(server.source_token,many.map(JSON.stringify).join('\n')+'\n');
  assert.equal((await collector.store.sessions({latest:true,limit:1,client_only:true})).sessions[0].session_id,'client-session');
  assert.equal((await collector.store.sessions({latest:true,limit:1})).sessions[0].session_id,'server:109');
  assert.equal((await collector.store.sessions({latest:true,limit:1,client_only:true,high_water:collector.store.cursor-1})).sessions[0].session_id,'client-session');
 }finally{await collector?.close();await rm(dir,{recursive:true,force:true});}
});
test('capture metadata failures preserve fetch response and business error identity',async()=>{
 const events=[],diagnostics=[];let calls=0;const response=new Response('body');Object.defineProperty(response,'url',{value:'http://b/'+ 'x'.repeat(17000)});
 const logger=createServerLogger({service:'A',sessionNamespace:'test',emit:e=>events.push(e),onDiagnostic:c=>diagnostics.push(c),propagationOrigins:['http://b'],fetch:async()=>{calls++;return response;}});
 let operationCalls=0;
 const actual=await logger.handleRequest(new Request('http://a/'),async context=>{
  context.log({toString(){throw new Error('poison message');}});
  await context.operation({toString(){throw new Error('poison name');}},async()=>{operationCalls++;});
  const long=await context.fetch('http://b/'+ 'x'.repeat(17000));assert.equal(long,response);
  return context.fetch('http://b/short');
 });
 assert.equal(actual,response);assert.equal(calls,2);assert.equal(operationCalls,1);assert.ok(diagnostics.filter(x=>x==='capture_failed').length>=3);
 assert.equal(events.filter(x=>x.event_type==='http.request.started').length,1);
 assert.equal(events.filter(x=>x.event_type==='http.response.headers').length,0);
 const throwingSink=createServerLogger({service:'A',sessionNamespace:'test',emit:()=>{throw new Error('sink');},fetch:async()=>response});
 assert.equal(await throwingSink.handleRequest(new Request('http://a/'),context=>context.fetch('http://b/')),response);
 const error={};Object.defineProperty(error,'name',{get(){throw new Error('poison error name');}});
 const broken=createServerLogger({service:'A',sessionNamespace:'test',emit:()=>{throw new Error('emit error');},onDiagnostic:c=>diagnostics.push(c),fetch:async()=>{throw error;}});
 await assert.rejects(broken.handleRequest(new Request('http://a/'),context=>context.fetch('http://b/')),actual=>actual===error);assert.ok(diagnostics.includes('emit_failed'));
});


test('ordinary provider banners are unmatched while canonical parse failures retain bounded source references',()=>{
  const banner=`curl /query -d '{"sql":"SELECT service FROM spans"}'`;
  assert.deepEqual(canonicalParser(banner),[]);
  assert.deepEqual(canonicalParser('ordinary text {braces}'),[]);
  const parsed=parseRecords({parser:canonicalParser},[{value:banner,reference:'banner'},...Array.from({length:10},(_,i)=>({value:'prefix {"http_sequence":',reference:'line:'+i}))],[trace]);
  assert.equal(parsed.unmatched,1);assert.equal(parsed.parse_errors,10);assert.equal(parsed.examples.length,5);
  assert.deepEqual(parsed.examples[0],{reference:'line:0',reason:'parser_failed'});
});
