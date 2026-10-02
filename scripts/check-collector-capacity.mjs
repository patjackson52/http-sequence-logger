import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir,cpus,totalmem,platform,release } from 'node:os';
import { join,resolve } from 'node:path';
import { performance,monitorEventLoopDelay } from 'node:perf_hooks';
import { CaptureStore } from '../collector/store.mjs';
const total=Number(process.env.COLLECTOR_PERF_EVENTS||1000000),sourceCount=10,batchSize=500;
if(!Number.isSafeInteger(total)||total<sourceCount||total%sourceCount)throw new Error('COLLECTOR_PERF_EVENTS must be divisible by10');
const dir=await mkdtemp(join(tmpdir(),'collector-capacity-'));
const store=new CaptureStore(dir,{journalBytes:2*1024**3,sourceBytes:1024**3,physicalBytes:4*1024**3});
const lag=monitorEventLoopDelay({resolution:10});lag.enable();
let bytes=0,maxQueueBytes=0;
try {
  await store.ready;const sources=[];
  for(let i=0;i<sourceCount;i++){const grant=await store.ticket({principal:'capacity-'+i,max_sources:1});sources.push(await store.register(grant.enrollment_token,{version:2,registration_id:'capacity-'+i,platform:['android','ios','web'][i%3],environment_id:'capacity-device-'+i,environment_name:'Capacity fixture '+i,app_id:'dev.capacity.app',installation_id:'installation-'+i,journal_id:'journal-'+i,instance_id:'instance-'+i,origin:'http://127.0.0.1:4180'}));}
  const start=performance.now(),perSource=total/sourceCount;
  for(let begin=0;begin<perSource;begin+=batchSize){
    const pending=sources.map((source,i)=>{
      const events=[];
      for(let j=begin;j<Math.min(begin+batchSize,perSource);j++){
        const sequence=j+1;events.push(JSON.stringify({schema_version:'1.2',event_type:'capture.gap',event_id:`capacity-${i}-${sequence}`,session_namespace:'capacity',session_id:'session-'+i,recording_id:'recording-'+i,sequence,timestamp:'2026-10-01T00:00:00.000Z',monotonic_ns:String(j*1000),data:{dropped_events:1,reason:'synthetic_capacity_fixture'}}));
      }
      const text=events.join('\n')+'\n';bytes+=Buffer.byteLength(text);const work=store.ingest(source.source_token,text);maxQueueBytes=Math.max(maxQueueBytes,store.bytes);return work;
    });
    await Promise.resolve();maxQueueBytes=Math.max(maxQueueBytes,store.bytes);
    await Promise.all(pending);
    if((begin+batchSize)%10000===0)console.log(`Committed ${Math.min(begin+batchSize,perSource)*sourceCount}/${total} synthetic events`);
  }
  const duration=performance.now()-start;
  assert.equal(store.cursor,total);const status=await store.status();assert.equal((await store.sources()).sources.length,sourceCount);
  const pageStart=performance.now(),page=await store.page({source_id:sources[9].source_id});assert.ok(page.lines.length<=500);assert.equal(page.high_water,total);assert.ok(page.next_after>0);
  const sessionsStart=performance.now(),sessions=await store.sessions({limit:100});assert.equal(sessions.sessions.length,10);
  const result={kind:'synthetic collector capacity; no hardware capture or power-loss proof',events:total,activeSources:sourceCount,eventBytes:bytes,meanEventBytes:bytes/total,durationMs:duration,eventsPerSecond:total/(duration/1000),maxQueueBytes,selectedPageMs:sessionsStart-pageStart,sessionSummaryMs:performance.now()-sessionsStart,eventLoop:{p99Ms:lag.percentile(99)/1e6,maxMs:lag.max/1e6},databaseBytes:status.database_bytes,walBytes:status.wal_bytes,sqlite:status.sqlite_version,node:process.version,hardware:{cpu:cpus()[0].model,cpuCount:cpus().length,memoryBytes:totalmem(),os:platform()+' '+release()},limits:store.limits};
  const artifact=resolve('artifacts/collector-capacity');await mkdir(artifact,{recursive:true});await writeFile(join(artifact,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{lag.disable();await store.close();await rm(dir,{recursive:true,force:true});}
