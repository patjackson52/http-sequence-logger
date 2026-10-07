export const ownerLabel = (owner) => ({integrator:'App code',sdk:'SDK',system:'System',unknown:'Unknown owner'}[owner]||'Not recorded');
export const actorLabel = (actor) => actor ? `${actor.component}${actor.method?'.'+actor.method:''} · ${ownerLabel(actor.owner)}` : 'Not recorded';
export const duration = (ns) => {
 if(ns==null)return '—';
 const ms=Number(BigInt(ns)/1000n)/1000;
 return ms<1?`${ms.toFixed(3)} ms`:ms<1000?`${ms.toFixed(ms<10?1:0)} ms`:`${(ms/1000).toFixed(2)} s`;
};
export function statusInfo(item) {
 if(item?.kind==='log')return ['neutral','·','Log'];
 const outcome=item?.outcome;
 if(item?.applicationOutcome==='error'||item?.end?.data.application_outcome==='error')return ['failed','✕','Application error'];
 if(item?.isHandler){
  const awaited=item.invocation?.dispatch==='awaited';
  return ({returned:['success','↩',awaited?'Resolved':'Returned'],threw:['failed','↯',awaited?'Rejected':'Threw'],cancelled:['cancelled','⊘','Cancelled'],observation_stopped:['incomplete','?','Observation stopped']}[item.completion]||['incomplete','…','Unfinished']);
 }
 if(item?.request || item?.rawEvents?.some(e=>e.event_type.startsWith('http.'))){
  if(['timeout','transport_error','http_error'].includes(outcome))return ['failed',outcome==='timeout'?'◷':outcome==='transport_error'?'⚠':'✕',{timeout:'Timeout',transport_error:'Transport error',http_error:'HTTP error'}[outcome]];
  if(item.status>=400)return ['failed','✕',`HTTP error${outcome==='unknown'?' · observation stopped':outcome==='cancelled'?' · cancelled':''}`];
 }
 if(outcome==='cancelled')return ['cancelled','⊘','Cancelled'];
 if(outcome==='unknown')return ['incomplete','?','Observation stopped'];
 if(outcome==='success')return ['success','✓','Success'];
 if(outcome==='error')return ['failed','↯','Error'];
 return ['incomplete','…','Unfinished'];
}
