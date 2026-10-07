import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CollectorClient} from '../viewer/src/collector-client.mjs';
const json=value=>new Response(JSON.stringify(value));
test('stop ends an idle actual Node fetch SSE stream after garbage collection without closing the collector', {timeout:15000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'viewer-stop-gc-'));
  const source = `
    import assert from 'node:assert/strict';
    import {rm,readFile} from 'node:fs/promises';
    import {randomUUID} from 'node:crypto';
    import {startCollector} from ${JSON.stringify(new URL('../collector/server.mjs',import.meta.url).href)};
    import {CollectorClient} from ${JSON.stringify(new URL('../viewer/src/collector-client.mjs',import.meta.url).href)};
    const directory=${JSON.stringify(directory)};
    let collector,client,running;
    try {
      const lines=(await readFile(new URL(${JSON.stringify(new URL('../examples/success.ndjson',import.meta.url).href)}),'utf8')).trim().split('\\n');
      const producer=JSON.parse(lines[0]).data.producer;
      collector=await startCollector({directory,port:0,activate:false});
      const connection=await collector.enroll({version:2,registration_id:randomUUID(),platform:producer.platform,environment_id:'owned-stop-test',app_id:producer.app_id,installation_id:randomUUID()});
      const captures=[];
      client=new CollectorClient({token:collector.browserToken,fetcher:(path,options)=>fetch(collector.origin+path,options),onCapture:text=>captures.push(text)});
      running=client.run();
      await collector.ingest(connection.source_token,lines.join('\\n')+'\\n');
      const deadline=Date.now()+3000;
      while(!captures.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(captures.length,1);
      for(let i=0;i<20;i++){global.gc();await new Promise(resolve=>setTimeout(resolve,20));}
      client.stop();
      let timer;
      const result=await Promise.race([running.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);
      clearTimeout(timer);
      assert.equal(result,true,'run stayed pending after stop until collector shutdown');
      assert.equal((await client.request('/api/v2/health')).status,200);
    } finally {
      client?.stop();await collector?.close();await running;await rm(directory,{recursive:true,force:true});
    }
  `;
  try { await promisify(execFile)(process.execPath,['--expose-gc','--input-type=module','-e',source],{timeout:12000,maxBuffer:64*1024}); }
  finally { await rm(directory,{recursive:true,force:true}); }
});
test('late old stream cancellation cannot prevent stopping a restarted client', {timeout:5000}, async()=>{
  function stream(deferred=false) {
    let readReply,readStarted,finishCancel;
    const reading=new Promise(resolve=>readStarted=resolve);
    const cancellation=deferred?new Promise(resolve=>finishCancel=resolve):Promise.resolve();
    const reader={read:()=>{readStarted();return new Promise(resolve=>readReply=resolve);},cancel:()=>{readReply?.({done:true});return cancellation;}};
    return {reader,reading,finish:()=>finishCancel?.()};
  }
  const old=stream(true),next=stream();let requests=0;
  const client=new CollectorClient({fetcher:async path=>path.includes('/stream')?{ok:true,body:{getReader:()=>requests++?next.reader:old.reader}}:json(path.includes('/sources')?{collector_id:'collector',event_cursor:0,sources:[]}:path.includes('/status')?{adapters:{}}:{high_water:0,sessions:[],has_more:false})});
  const first=client.run();await old.reading;client.stop();
  const second=client.run();await next.reading;old.finish();await first;
  client.stop();let timer;
  try { assert.equal(await Promise.race([second.then(()=>true),new Promise(resolve=>timer=setTimeout(()=>resolve(false),500))]),true); }
  finally { clearTimeout(timer);old.finish();await next.reader.cancel();client.stop();await Promise.all([first,second]); }
});
test('starting a client preserves a selection made before run without retaining its aborted signal', {timeout:5000}, async()=>{
  let captured,timer;
  const capture=new Promise(resolve=>captured=resolve);
  const client=new CollectorClient({onCapture:text=>{if(text)captured(text);},fetcher:async path=>path.includes('/stream')?new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));}})):json(path.includes('/events')?{collector_id:'collector',lines:['{"event_id":"selected"}'],cursor:1,high_water:1,has_more:false}:path.includes('/sources')?{collector_id:'collector',event_cursor:1,sources:[]}:path.includes('/status')?{adapters:{}}:{high_water:1,sessions:[{session_namespace:'namespace',session_id:'selected'}],has_more:false})});
  client.followLatest=false;client.select({session_namespace:'namespace',session_id:'selected'});
  const running=client.run();
  try { assert.equal(await Promise.race([capture,new Promise(resolve=>timer=setTimeout(()=>resolve(null),500))]),'{"event_id":"selected"}\n'); }
  finally { clearTimeout(timer);client.stop();await running; }
});
test('a stopped stream response cannot acquire the restarted client reader', {timeout:5000}, async()=>{
  let oldReady,releaseOld,nextReading,nextReply,timer,streamRequests=0,canceledBody=0;
  const ready=new Promise(resolve=>oldReady=resolve),held=new Promise(resolve=>releaseOld=resolve),reading=new Promise(resolve=>nextReading=resolve);
  const nextReader={read:()=>{nextReading();return new Promise(resolve=>nextReply=resolve);},cancel:()=>{nextReply?.({done:true});return Promise.resolve();}};
  const oldBody={cancel:()=>{canceledBody++;return Promise.resolve();},getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>Promise.resolve()})};
  const client=new CollectorClient({fetcher:async path=>path.includes('/stream')?{ok:true,body:streamRequests++?{getReader:()=>nextReader}:oldBody}:json(path.includes('/sources')?{collector_id:'collector',event_cursor:0,sources:[]}:path.includes('/status')?{adapters:{}}:{high_water:0,sessions:[],has_more:false})});
  const request=client.request.bind(client);let holdFirst=true;
  client.request=async(...args)=>{const response=await request(...args);if(args[0].includes('/stream')&&holdFirst){holdFirst=false;oldReady();await held;}return response;};
  const first=client.run();await ready;client.stop();const second=client.run();await reading;releaseOld();await first;client.stop();
  try {
    assert.equal(await Promise.race([second.then(()=>true),new Promise(resolve=>timer=setTimeout(()=>resolve(false),500))]),true);
    assert.equal(canceledBody,1);
  } finally {clearTimeout(timer);releaseOld();await nextReader.cancel();client.stop();await Promise.all([first,second]);}
});
test('filtered empty pages advance global cursor at fixed high-water',async()=>{const urls=[],captures=[];const client=new CollectorClient({onCapture:(...args)=>captures.push(args),fetcher:async(url)=>{urls.push(url);return json(url.includes('after=0')?{collector_id:'collector',lines:[],cursor:100,next_after:100,has_more:true,high_water:101}:{collector_id:'collector',lines:['{"event_id":"last"}'],cursor:101,next_after:101,has_more:false,high_water:101});}});client.collectorId='collector';client.selection={source_id:'s',session_namespace:'namespace',session_id:'session'};await client.catchUp(new AbortController().signal);assert.ok(urls[1].includes('after=100'));assert.ok(urls[1].includes('high_water=101'));assert.equal(captures.length,1);assert.equal(captures[0][1],1);});
test('selection generation fences an already returned stale page',async()=>{let resolve;const capture=[];const client=new CollectorClient({onCapture:text=>capture.push(text),fetcher:()=>new Promise(ok=>resolve=ok)});client.collectorId='collector';const promise=client.catchUp(new AbortController().signal);client.select({session_id:'new'});resolve(json({collector_id:'collector',lines:['stale'],cursor:1,high_water:1,has_more:false}));await promise;assert.deepEqual(capture,['']);assert.equal(client.lines.length,0);});
test('session pagination pins summary high-water and current source',async()=>{let request;const client=new CollectorClient({fetcher:async(url)=>{request=url;return json({sessions:[],has_more:false});}});client.controller=new AbortController();client.selection={source_id:'source'};client.nextSessions=100;client.sessionHighWater=400;await client.moreSessions();assert.ok(request.includes('high_water=400'));assert.ok(request.includes('source_id=source'));assert.equal(client.nextSessions,null);});
test('rapid selections coalesce to one catch-up job and newest generation',async()=>{let release,calls=0;const client=new CollectorClient({});client.controller=new AbortController();client.refresh=async()=>{calls++;if(calls===1)await new Promise(r=>release=r);};const work=client._schedule();for(let i=0;i<1000;i++)client.select({session_id:String(i)});release();await work;assert.equal(calls,2);assert.equal(client.selection.session_id,'999');client.stop();});
test('zero-event refresh publishes discovery diagnostics independently of capture',async()=>{
  const devices=[],sources=[];const client=new CollectorClient({onDevice:value=>devices.push(value),onSources:value=>sources.push(value),fetcher:async url=>json(url.includes('/status')?{adapters:{android:{state:'waiting',reason:'Permission required',devices:[{serial:'usb',state:'unauthorized'}]},'ios-simulator':{reason:'0 booted simulators'}}}:url.includes('/sources')?{collector_id:'collector',event_cursor:0,sources:[]}:{high_water:0,sessions:[],has_more:false})});
  await client.refresh(new AbortController().signal);assert.equal(devices[0].android.devices[0].state,'unauthorized');assert.equal(devices[0]['ios-simulator'].reason,'0 booted simulators');assert.deepEqual(sources,[[]]);
});
test('pairing action coalesces clicks, grants one installation and fences stopped clients',async()=>{
  const calls=[],pairings=[];let release;const client=new CollectorClient({token:'reader',onPairing:value=>pairings.push(value),fetcher:async(url,options)=>{calls.push({url,options});if(url.includes('/pairing'))return json({connections:[{endpoint:'https://collector.local:4320',enrollment_token:'expired'}]});await new Promise(resolve=>release=resolve);return json({enrollment_token:'fresh',expires_at:123});}});client.controller=new AbortController();client.collectorId='collector';
  const first=client.pairing(),second=client.pairing();assert.equal(first,second);await new Promise(resolve=>setImmediate(resolve));release();await first;
  assert.equal(calls.length,2);assert.equal(calls[1].options.method,'POST');assert.equal(JSON.parse(calls[1].options.body).max_sources,1);assert.equal(JSON.parse(calls[1].options.body).principal,'native-pairing');assert.equal(pairings[0][0].enrollment_token,'fresh');
  const stale=client.pairing();await new Promise(resolve=>setImmediate(resolve));client.stop();release();await assert.rejects(stale,{name:'AbortError'});assert.equal(pairings.length,1);
});

test('related snapshots reread late source records and unchanged revisions preserve capture identity', async()=>{
  let cursor=3,captures=0;const queries=[];
  const client=new CollectorClient({token:'read',onCapture:()=>captures++,fetcher:async path=>{
    queries.push(path);if(path.includes('/sources'))return json({collector_id:'c',event_cursor:cursor,sources:[]});
    if(path.includes('/status'))return json({adapters:{}});
    if(path.includes('/sessions'))return json({high_water:cursor,sessions:[{session_namespace:'client',session_id:'session'}],has_more:false});
    return json({collector_id:'c',cursor,high_water:cursor,lines:['client','server-start'],has_more:false});
  }});client.selection={session_namespace:'client',session_id:'session'};client.followLatest=false;
  const signal=new AbortController().signal;await client.refresh(signal);assert.equal(captures,1);
  await client.refresh(signal);assert.equal(captures,1);
  cursor++;await client.refresh(signal);assert.equal(captures,1,'global changes without selected records must not rebuild diagram');
  assert.ok(queries.filter(p=>p.includes('/events')).every(p=>new URL(p,'http://local').searchParams.get('include_related')==='true'));
});

test('collection jobs publish terminal status and cancellation reaches collector',async()=>{
  const states=[],requests=[];
  const client=new CollectorClient({token:'t',onCollection:j=>states.push(j.state),fetcher:async(path,options)=>{requests.push({path,options});return json(options.method==='POST'?{job_id:'job',state:'completed',event_count:0}:{job_id:'job',state:'cancelled'});}});
  client.selection={session_namespace:'n',session_id:'s'};await client.collectRelated();assert.deepEqual(states,['queued','completed']);
  client.collectionController=new AbortController();client.collectionJob='job';await client.cancelCollection();assert.equal(requests.at(-1).options.method,'DELETE');assert.equal(states.at(-1),'cancelled');
});

test('cancelling during job creation waits for its ID then cancels the remote job',async()=>{
  let created;const pending=new Promise(resolve=>created=resolve),methods=[];
  const client=new CollectorClient({token:'t',fetcher:async(_path,options)=>{methods.push(options.method);if(options.method==='POST')return pending;return json({state:'cancelled'});}});
  client.selection={session_namespace:'n',session_id:'s'};const run=client.collectRelated();await client.cancelCollection();
  created(json({job_id:'created-after-cancel',state:'running'}));await run;assert.deepEqual(methods,['POST','DELETE']);assert.equal(client.collectionController,null);
});

test('default following excludes newly collected server sessions while explicit server source can follow',async()=>{
  const requests=[];
  const client=new CollectorClient({fetcher:async path=>{
    requests.push(path);
    if(path.includes('/sources'))return json({collector_id:'c',event_cursor:2,sources:[{source_id:'client-source',platform:'web'},{source_id:'server-source',platform:'server'}]});
    if(path.includes('/status'))return json({adapters:{}});
    if(path.includes('/sessions')){const query=new URL(path,'http://local').searchParams;return json({high_water:2,has_more:false,sessions:query.get('latest')?[query.get('client_only')==='true'?{session_namespace:'client',session_id:'s',source_ids:['client-source']}:{session_namespace:'server',session_id:'new',source_ids:['server-source']}]:[{session_namespace:'client',session_id:'s',source_ids:['client-source']},{session_namespace:'server',session_id:'new',source_ids:['server-source']}]});}
    return json({collector_id:'c',cursor:2,high_water:2,lines:[],has_more:false});
  }});
  client.selection={session_namespace:'client',session_id:'s'};
  await client.refresh(new AbortController().signal);assert.equal(client.selection.session_namespace,'client');assert.ok(requests.some(p=>p.includes('client_only=true')));
  client.select({source_id:'server-source',session_namespace:'server',session_id:'old'});
  await client.refresh(new AbortController().signal);assert.equal(client.selection.session_id,'new');assert.ok(!requests.at(-2).includes('client_only=true'));
});
