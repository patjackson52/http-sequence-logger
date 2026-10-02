import{CaptureStore}from'../../collector/store.mjs';
const [directory,stage,text]=process.argv.slice(2);
const gate=stage==='before'?new SharedArrayBuffer(8):undefined;
const store=new CaptureStore(directory,{},gate?{testCommitGate:gate}:{});await store.ready;
const ticket=await store.ticket({principal:'crash-fixture',max_sources:1});
const source=await store.register(ticket.enrollment_token,{version:2,registration_id:'crash-operation',platform:'android',environment_id:'crash-device',app_id:'dev.crash',installation_id:'crash-installation'});
process.send({kind:'ready',source,collector_id:store.config.collector_id});
process.once('message',async()=>{
  if(gate){const values=new Int32Array(gate);const timer=setInterval(()=>{if(Atomics.load(values,1)){clearInterval(timer);process.send({kind:'blocked'});}},5);await store.ingest(source.source_token,text);}
  else{const ack=await store.ingest(source.source_token,text);process.send({kind:'committed',event_cursor:ack.event_cursor});}
});
