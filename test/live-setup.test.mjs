import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCollector } from '../collector/server.mjs';
import { parseDevices,selectDevice } from '../collector/android-live.mjs';
import { CollectorClient } from '../viewer/src/collector-client.mjs';
const headers={'X-Network-Log-Viewer':'1','Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'same-origin'};
const lines=readFileSync(new URL('../examples/success.ndjson',import.meta.url),'utf8').trim().split('\n');
const metadata=()=>({version:2,registration_id:randomUUID(),platform:'android',environment_id:'phone',app_id:'dev.test',installation_id:randomUUID(),journal_id:randomUUID(),instance_id:randomUUID()});
async function until(predicate){const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('Timed out');await new Promise(ok=>setTimeout(ok,10));}}
function request(url,requestHeaders={},method='GET'){return new Promise((ok,fail)=>{const req=http.request(url,{method,headers:requestHeaders},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>ok({status:res.statusCode,headers:res.headers,text}));});req.on('error',fail);req.end();});}
test('viewer bootstrap is same-origin constrained and cannot authorize source uploads',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'live-v2-')),c=await startCollector({directory:dir,port:0});t.after(async()=>{await c.close();rmSync(dir,{recursive:true,force:true});});
  const url=c.origin+'/api/v2/bootstrap',allowed=await request(url,headers),session=JSON.parse(allowed.text);assert.equal(allowed.status,200);assert.equal(session.version,2);assert.equal(session.token,c.browserToken);
  assert.equal(allowed.headers['cache-control'],'no-store');assert.equal(allowed.headers['access-control-allow-origin'],undefined);assert.equal(allowed.headers['cross-origin-resource-policy'],'same-origin');
  for(const denied of [{},{...headers,'X-Network-Log-Viewer':''},...['cross-site','same-site','none',''].map(site=>({...headers,'Sec-Fetch-Site':site})),{...headers,'Sec-Fetch-Mode':'navigate'},{...headers,Origin:'https://foreign.example'},{...headers,Host:'rebound.example'}]){const response=await request(url,denied);assert.equal(response.status,403);assert.ok(!response.text.includes(c.browserToken));}
  assert.notEqual((await request(url,headers,'POST')).status,200);assert.notEqual((await request(url,headers,'OPTIONS')).status,200);
  assert.equal((await request(c.origin+'/api/v2/events')).status,401);assert.equal((await request(c.origin+'/api/v2/events',{...headers,Authorization:'Bearer '+session.token,'Content-Type':'application/x-ndjson'},'POST')).status,401);
  const alias=new URL(c.origin);alias.hostname='localhost';assert.equal((await request(url,{...headers,Host:alias.host,Origin:alias.origin})).status,200);
  assert.equal(JSON.parse((await request(c.origin+'/api/v2/health')).text).automatic_viewer,true);
});
test('automatic viewer refreshes credentials after a different collector takes the same address',async t=>{
  const first=mkdtempSync(join(tmpdir(),'live-old-')),second=mkdtempSync(join(tmpdir(),'live-new-'));let c=await startCollector({directory:first,port:0});
  const origin=c.origin,port=Number(new URL(origin).port),captures=[],statuses=[],sources=[];let resets=0;
  const client=new CollectorClient({automatic:true,retryMs:10,fetcher:(path,options)=>fetch(origin+path,{...options,headers:{...options.headers,...headers}}),onCapture:(text,count)=>captures.push({text,count}),onReset:()=>resets++,onStatus:state=>statuses.push(state),onSources:list=>sources.push(list)});
  t.after(async()=>{client.stop();await c.close();rmSync(first,{recursive:true,force:true});rmSync(second,{recursive:true,force:true});});
  const run=client.run(),source=await c.enroll(metadata());await c.ingest(source.source_token,lines.slice(0,3).join('\n')+'\n');
  await until(()=>statuses.at(-1)?.state==='live'&&captures.at(-1)?.count===3);assert.equal(sources.at(-1)[0].source_id,source.source_id);
  await c.close();await until(()=>statuses.at(-1)?.state==='reconnecting');c=await startCollector({directory:second,port});const replacement=await c.enroll(metadata());await c.ingest(replacement.source_token,lines[0]+'\n');
  await until(()=>resets===1&&captures.at(-1)?.count===1&&statuses.at(-1)?.state==='live');assert.equal(captures.at(-1).text,lines[0]+'\n');client.stop();await run;
});
test('stopping bootstrap before its response prevents stale callbacks',async()=>{
  let reply;const statuses=[];let resets=0;const client=new CollectorClient({automatic:true,onStatus:s=>statuses.push(s),onReset:()=>resets++,fetcher:()=>new Promise(ok=>reply=ok)});
  const run=client.run();client.stop();reply(Response.json({version:2,collector_id:'new',token:'x'.repeat(32)}));await run;assert.equal(resets,0);assert.ok(statuses.every(s=>s.state!=='live'));
});
test('device listing includes every authorized device and sample install requires explicit ambiguity resolution',()=>{
  const devices=parseDevices('List of devices attached\nemulator-5554 device model:Android_Emulator\nemulator-5556 device\nphone device usb:2-2 model:Pixel_10_Pro\nunauthorized unauthorized\n');
  assert.equal(devices.filter(d=>d.state==='device').length,3);assert.equal(selectDevice(devices,'phone').label,'Pixel 10 Pro');assert.equal(selectDevice(devices,'emulator-5556').serial,'emulator-5556');assert.throws(()=>selectDevice(devices),/explicit device/);assert.throws(()=>selectDevice(devices,'missing'),/explicit device/);
});
