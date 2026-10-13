import React, {useEffect,useMemo,useRef,useState} from 'react';
import {requestSources,exportHTTP} from './export-http.mjs';
import './http-requests.css';

export default function HttpRequests({session,sources,recordingSources,selectedSourceId,onSelectedSourceChange,onSourceChange}){
 const [downloadError,setDownloadError]=useState('');
 const textRef=useRef(null);
 const options=useMemo(()=>({sources,recordingSources}),[sources,recordingSources]);
 const groups=useMemo(()=>requestSources(session,options),[session,options]);
 const selected=groups.find(group=>group.id===selectedSourceId)||groups[0];
 const result=useMemo(()=>selected?exportHTTP(session,selected.id,options):null,[session,selected?.id,options]);
 useEffect(()=>{const availableId=selected?.id??null;if(selectedSourceId!==availableId)onSelectedSourceChange?.(availableId);},[selected?.id,selectedSourceId,onSelectedSourceChange]);
 useEffect(()=>{setDownloadError('');if(textRef.current){textRef.current.scrollTop=0;textRef.current.scrollLeft=0;}},[session.id,selected?.id]);
 function download(extension){
  setDownloadError('');
  try{
   const blob=new Blob([result.text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');
   anchor.href=url;anchor.download=result.filename.replace(/\.http$/,`.${extension}`);anchor.click();
   setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch{setDownloadError('Request download failed. Try again.');}
 }
 return <section className="http-requests" aria-label="HTTP requests">
  <div className="http-request-controls">
   {groups.length>1?<label className="http-request-source">Request source<select aria-label="Request source" value={selected.id} onChange={event=>{onSelectedSourceChange?.(event.target.value);onSourceChange?.();}}>{groups.map(group=><option key={group.id} value={group.id}>{group.label} · {group.requestCount} requests</option>)}</select></label>:selected&&<p className="http-request-source"><strong>Request source</strong><span>{selected.label}</span></p>}
   <div className="http-request-downloads"><button disabled={!result} onClick={()=>download('http')}>Download .http</button><button disabled={!result} onClick={()=>download('rest')}>Download .rest</button></div>
  </div>
  <p className="http-request-scope" id="http-request-scope"><strong aria-live="polite">{result?.requestCount??0} requests</strong>{selected&&<> · {selected.recordings.length} recording(s) · {selected.label}</>}<br/>Session: <span className="mono">{session.namespace} / {session.sessionId}</span>. All captured requests for this source; diagram filters do not apply.</p>
  <p className="http-request-help" id="http-request-help">Read-only request file. Select text or download the displayed content for an HTTP file client. Capture limitations and response observations appear as comments.</p>
  {downloadError&&<p role="alert" className="notice error">{downloadError}</p>}
  {result?<pre ref={textRef} className="http-request-text" role="region" aria-label="HTTP request file" aria-describedby="http-request-scope http-request-help" tabIndex={0}><code>{result.text}</code></pre>:<div className="empty"><h2>No HTTP requests captured</h2><p>This session has no recorded HTTP requests.</p></div>}
 </section>;
}
