import { readFileSync } from 'node:fs';
import { sequencesFromCapture } from '../sequence-diff/index.mjs';

const sample = readFileSync(new URL('../examples/success.ndjson', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const eventOf = type => structuredClone(sample.find(event => event.event_type === type));
const bodyOf = direction => structuredClone(sample.find(event => event.event_type === 'http.body.captured' && event.data.direction === direction));

/** Canonical fixtures with independent clocks/IDs and independent expected findings. */
export function comparisonFixture(paths, side, { platform = 'android', query = false, unknown = true } = {}) {
  const events = [], trace = (side === 'primary' ? 'a' : 'b').repeat(32), rootSpan = '1'.repeat(16);
  const context = span => ({ trace_id: trace, span_id: span, parent_span_id: span === rootSpan ? null : rootSpan, parent_scope: span === rootSpan ? 'none' : 'local' });
  const start = eventOf('session.started'); start.data.name = 'Comparison workflow';start.data.producer.platform=platform;start.data.producer.app_id='dev.comparison.fixture';events.push(start);
  const root = eventOf('operation.started');root.data.name='Workflow.run';root.context=context(rootSpan);events.push(root);
  const captured = { availability: 'captured', representation: 'raw', order_preserved: true, entries: [], reason: null };
  paths.forEach((path,index)=>{
    const ctx=context((index+2).toString(16).padStart(16,'0'));
    const request=eventOf('http.request.started');request.context=ctx;request.data.request.url='https://api.example'+path+(query&&path==='/verify'?'?value=secondary':'');request.data.request.headers=structuredClone(captured);
    const response=eventOf('http.response.headers');response.context=ctx;response.data.response.url=request.data.request.url;response.data.response.headers=structuredClone(captured);
    const requestBody=bodyOf('request'),responseBody=bodyOf('response');
    for(const bodyEvent of [requestBody,responseBody]){
      bodyEvent.context=ctx;Object.assign(bodyEvent.data.body,{availability:'captured',redacted:false,truncated:false,reason:null,observed_bytes:11,total_bytes:11,stored_bytes:11,content:{encoding:'utf-8',data:'{"ok":true}'}});
      bodyEvent.data.body.observed_bytes=bodyEvent.data.body.total_bytes=bodyEvent.data.body.stored_bytes=Buffer.byteLength(bodyEvent.data.body.content.data);
    }
    if(unknown&&['/config','/unknown'].includes(path))responseBody.data.body.redacted=true;
    if(query&&path==='/verify'){responseBody.data.body.content.data='{"ok":false}';responseBody.data.body.observed_bytes=responseBody.data.body.total_bytes=responseBody.data.body.stored_bytes=12;}
    const end=eventOf('http.ended');end.context=ctx;end.data.application_outcome='success';
    events.push(request,requestBody,response,responseBody,end);
  });
  const rootEnd=eventOf('operation.ended');rootEnd.context=context(rootSpan);events.push(rootEnd,eventOf('session.ended'));
  const starts=new Map();events.forEach((event,index)=>{
    event.session_namespace='comparison/development';event.session_id=side;event.recording_id=side+'-recording';event.event_id=side+'-event-'+(index+1);event.sequence=index+1;
    event.monotonic_ns=String(index*1000000);event.timestamp=new Date(Date.UTC(2026,9,2)+(side==='primary'?0:3600000)+index).toISOString();
    if(event.event_type==='operation.started'||event.event_type==='http.request.started')starts.set(event.context.span_id,index);
    if(event.event_type==='operation.ended'||event.event_type==='http.ended')event.data.duration_ns=String((index-starts.get(event.context.span_id))*1000000);
  });
  return sequencesFromCapture(events)[0];
}
export const ndjsonOf = document => document.events.map(JSON.stringify).join('\n')+'\n';
