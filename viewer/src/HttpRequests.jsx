import React, {useEffect,useMemo,useRef,useState} from 'react';
import {requestSources,exportHTTP} from './export-http.mjs';
import './http-requests.css';

export default function HttpRequests({session,sources,recordingSources,selectedSourceId,onSelectedSourceChange,onSourceChange}){
 const [downloadError,setDownloadError]=useState('');
 const textRef=useRef(null);
 const options=useMemo(()=>({sources,recordingSources}),[sources,recordingSources]);
 const groups=useMemo(()=>requestSources(session,options),[session,options]);
 const selected=groups.find(group=>group.id===selectedSourceId);
 const result=useMemo(()=>exportHTTP(session,selected?.id??null,options),[session,selected?.id,options]);
 useEffect(()=>{const availableId=selected?.id??null;if((selectedSourceId??null)!==availableId)onSelectedSourceChange?.(availableId);},[selected?.id,selectedSourceId,onSelectedSourceChange]);
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
   {groups.length>1?<label className="http-request-source">Request source<select aria-label="Request source" value={selected?.id??''} onChange={event=>{onSelectedSourceChange?.(event.target.value||null);onSourceChange?.();}}><option value="">All sources</option>{groups.map(group=><option key={group.id} value={group.id}>{group.label} · {group.requestCount} requests{group.observationCount>group.requestCount?` · ${group.observationCount-group.requestCount} response-only`:""}</option>)}</select></label>:groups[0]&&<p className="http-request-source"><strong>Request source</strong><span>{groups[0].label}</span></p>}
   <div className="http-request-downloads"><button disabled={!result?.observationCount} onClick={()=>download('http')}>Download .http</button><button disabled={!result?.observationCount} onClick={()=>download('rest')}>Download .rest</button></div>
  </div>
  <p className="http-request-scope" id="http-request-scope" aria-live="polite">{result?.requestCount??0} requests{result?.observationCount>result?.requestCount?` · ${result.observationCount-result.requestCount} response-only observations`:""} · Requests and responses</p>
  {downloadError&&<p role="alert" className="notice error">{downloadError}</p>}
  {result?.observationCount?<pre ref={textRef} className="http-request-text" role="region" aria-label="HTTP request file" aria-describedby="http-request-scope" tabIndex={0}><code>{result.text}</code></pre>:<div className="empty"><h2>No HTTP requests captured</h2><p>This source has no recorded HTTP request or response data.</p></div>}

 </section>;
}
