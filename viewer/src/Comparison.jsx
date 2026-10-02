import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import ComparisonLayouts from './ComparisonLayouts.jsx';
import PairInspector from './PairInspector.jsx';
import {MatchDialog, RulesDialog} from './ComparisonDialogs.jsx';
import {ComparisonClient} from './comparison-client.mjs';
import {snapshotsFromCapture} from './comparison-data.mjs';
import {projectComparison, restorePair, swapProfile} from './comparison-state.mjs';
import './comparison.css';

const identity = value => JSON.stringify([value.namespace, value.id]);
const documentOf = snapshot => snapshot.document || snapshot.sequence;
const descriptor = snapshot => ({key:identity(documentOf(snapshot).session), snapshot, session:documentOf(snapshot).session});
function metadataText(snapshot) {
 const starts = documentOf(snapshot).events.filter(e=>e.event_type==='session.started');
 return [...new Set(starts.map(e=>{const p=e.data.producer;return `${p?.platform || 'platform not recorded'} · ${p?.app_id || 'app not recorded'} · ${p?.app_version || 'version not recorded'} · build ${p?.build || p?.build_number || 'not recorded'}`;}))].join(' | ') || 'Producer/build not recorded';
}
function trapTab(e) {
 if(e.key!=='Tab')return;
 const controls=[...e.currentTarget.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(x=>!x.disabled&&x.getClientRects().length);
 if(e.shiftKey&&document.activeElement===controls[0]){e.preventDefault();controls.at(-1)?.focus();}
 else if(!e.shiftKey&&document.activeElement===controls.at(-1)){e.preventDefault();controls[0]?.focus();}
}
function Identity({side,snapshot}) {
 const doc=documentOf(snapshot);
 return <div className={`comparison-identity ${side}`}><strong>{side==='primary'?'P · Primary':'S · Secondary'}</strong><span className="mono">{doc.session.namespace} / {doc.session.id}</span><small>{metadataText(snapshot)}</small><small>{doc.events.length} events · {snapshot.scope?.kind || snapshot.scope?.type || 'whole-session'}{snapshot.scope?.source_id?` · source ${snapshot.scope.source_id}`:''}</small></div>;
}
export default function Comparison({capture,primarySession,collector,retainedSessions=[],sources=[],sourceFilter,onExit,collectorEpoch=0}) {
 const [catalog,setCatalog]=useState([]),[catalogPage,setCatalogPage]=useState(null),[catalogError,setCatalogError]=useState(''),[library,setLibrary]=useState([]),[primary,setPrimary]=useState(null),[result,setResult]=useState(null),[picker,setPicker]=useState(true),[pickerSearch,setPickerSearch]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[updates,setUpdates]=useState(null),[watching,setWatching]=useState(true);
 const [controlsOpen,setControlsOpen]=useState(false),[layout,setLayout]=useState('aligned'),[search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[collapseEqual,setCollapseEqual]=useState(false),[collapsed,setCollapsed]=useState(new Set());
 const [selectedId,setSelectedId]=useState(null),[inspector,setInspector]=useState(false),[tab,setTab]=useState('changes'),[dialog,setDialog]=useState(null),[resolution,setResolution]=useState(null),[navOpen,setNavOpen]=useState(()=>window.innerWidth>=1700),[inspectorWidth,setInspectorWidth]=useState(420),[viewport,setViewport]=useState(window.innerWidth);
 const client=useRef(null),operation=useRef(0),readAbort=useRef(null),mounted=useRef(true),resultRef=useRef(null),selectionRef=useRef(null),focusOrigin=useRef(null),dialogOrigin=useRef(null),pickerRef=useRef(null),pickerTrigger=useRef(null),pickerCancelled=useRef(false),inspectorRef=useRef(null),watchAbort=useRef(null),catalogAbort=useRef(null),catalogGeneration=useRef(0);
 resultRef.current=result;selectionRef.current=selectedId;
 const previewCandidate=useCallback(value=>setResolution(value?{...value,sourceNodeId:value.nodeId,candidateNodeId:value.selectedNodeId}:null),[]);
 const overlay=viewport-inspectorWidth-(navOpen?236:0)<720;
 useEffect(()=>{const resize=()=>setViewport(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 useEffect(()=>{
  client.current=new ComparisonClient();mounted.current=true;
  try {
   const snapshots=snapshotsFromCapture(capture);setLibrary(snapshots.map(s=>({...descriptor(s),live:!!collector})));
   const found=snapshots.find(s=>identity(documentOf(s).session)===primarySession.id);
   if(!found)throw new Error('Primary session is unavailable.');
   setPrimary(found);
  }catch(e){setError(e.message);}
  return()=>{mounted.current=false;++operation.current;readAbort.current?.abort();watchAbort.current?.abort();catalogAbort.current?.abort();++catalogGeneration.current;client.current?.dispose();};
 },[]);
 useEffect(()=>{if(picker)pickerRef.current?.querySelector('input,button')?.focus();else requestAnimationFrame(()=>{if(pickerCancelled.current&&pickerTrigger.current?.isConnected)pickerTrigger.current.focus({preventScroll:true});else document.querySelector('.comparison-viewport')?.focus({preventScroll:true});});},[picker]);
 useEffect(()=>{if(inspector&&overlay)inspectorRef.current?.querySelector('button')?.focus();},[inspector,overlay]);
 useEffect(()=>{
  if(!result||!collector||!watching)return;
  let stopped=false,timer;const abort=new AbortController();watchAbort.current=abort;
  const check=async()=>{
   try{const value=await collector.comparisonUpdates(Object.values(result.snapshots),{signal:abort.signal});if(!stopped)setUpdates(value);}
   catch(e){if(!stopped&&e.name!=='AbortError')setUpdates({changed:true,error:`Update check unavailable: ${e.message}`});}
   if(!stopped)timer=setTimeout(check,2000);
  };check();return()=>{stopped=true;clearTimeout(timer);abort.abort();};
 },[result,collector,watching,collectorEpoch]);
 async function loadCatalog(more=false){
  if(!collector)return;const generation=++catalogGeneration.current;catalogAbort.current?.abort();const abort=new AbortController();catalogAbort.current=abort;setCatalogError('');
  try{const page=await collector.comparisonSessions({signal:abort.signal,...(more&&catalogPage?{after:catalogPage.next_after,highWater:catalogPage.high_water}:{})});if(!mounted.current||generation!==catalogGeneration.current)return;setCatalog(old=>more?[...old,...page.sessions]:page.sessions);setCatalogPage(page);}
  catch(e){if(mounted.current&&generation===catalogGeneration.current&&e.name!=='AbortError')setCatalogError(`Retained session catalog unavailable: ${e.message}`);}
 }
 useEffect(()=>{if(picker)loadCatalog();return()=>{catalogAbort.current?.abort();++catalogGeneration.current;};},[picker,collector,collectorEpoch]);
 const diff=result?.diff,pair=diff?.pairs.find(p=>p.id===selectedId),projection=useMemo(()=>diff?projectComparison(diff,{search,filter,collapseEqual,collapsed,selectedId}):null,[diff,search,filter,collapseEqual,collapsed,selectedId]);
 const choices=useMemo(()=>{
  const all=new Map(library.map(item=>[item.key,item]));
  for(const s of [...retainedSessions,...catalog]){const session={namespace:s.session_namespace,id:s.session_id},key=identity(session);if(!all.has(key))all.set(key,{key,session,retained:s});}
  return [...all.values()].filter(item=>item.key!==identity(documentOf(primary || {document:{session:{}}}).session) && (!pickerSearch||[item.session.namespace,item.session.id,item.retained?.name,item.snapshot?metadataText(item.snapshot):'',...(item.retained?.source_ids||[]).map(id=>{const source=sources.find(s=>s.source_id===id);return source?[source.platform,source.app_id,source.environment_name].join(' '):id;})].join(' ').toLowerCase().includes(pickerSearch.toLowerCase())));
 },[library,retainedSessions,catalog,primary,pickerSearch,sources]);
 function cancel(){++operation.current;readAbort.current?.abort();client.current?.cancel();setBusy(false);setNotice(resultRef.current?'Computation cancelled. The last valid comparison remains active.':'Computation cancelled. Choose a secondary session to try again.');}
 async function snapshotFor(item,signal){
  if(item.snapshot && !item.live)return item.snapshot;
  if(!collector)throw new Error('Collector unavailable.');
  return collector.snapshotSession({session_namespace:item.session.namespace,session_id:item.session.id},{signal});
 }
 async function compute(snapshots,profile={}, {swapped=false,refresh=false}={}){
  const id=++operation.current;readAbort.current?.abort();client.current.cancel();const abort=new AbortController();readAbort.current=abort;setBusy(true);setError('');setNotice('');
  try{
   let next=snapshots;
   if(refresh){next={};for(const side of ['primary','secondary']){const previous=snapshots[side];if(previous.kind==='collector' || previous.boundary?.collector_id){
    const doc=documentOf(previous);next[side]=await collector.snapshotSession({session_namespace:doc.session.namespace,session_id:doc.session.id,...(previous.scope?.source_id?{source_id:previous.scope.source_id}:{})},{signal:abort.signal});
   }else next[side]=previous;}}
   const output=await client.current.compare(next.primary,next.secondary,profile,{signal:abort.signal});
   if(!mounted.current||id!==operation.current)return false;
   const oldPair=resultRef.current?.diff.pairs.find(p=>p.id===selectionRef.current);const restored=restorePair(oldPair,output,swapped);
   const nextCollapsed=new Set();for(const oldId of collapsed){const old=resultRef.current?.diff.pairs.find(p=>p.id===oldId);const mapped=restorePair(old,output,swapped);if(mapped)nextCollapsed.add(mapped);}setCollapsed(nextCollapsed);
   next={primary:{...next.primary,model:client.current.lastModels.primary},secondary:{...next.secondary,model:client.current.lastModels.secondary}};
   setResult({diff:output,snapshots:next,at:new Date().toISOString()});setPrimary(next.primary);setSelectedId(restored);setUpdates(null);pickerCancelled.current=false;setPicker(false);setDialog(null);setResolution(null);
   if(oldPair&&!restored){setInspector(false);setNotice('The selected source node no longer exists in this snapshot. Select another pair.');}
   else if(restored)setNotice('Selection restored by source identity.');return true;
  }catch(e){if(id===operation.current&&e.name!=='AbortError')setError(`${resultRef.current?'Recomputation failed; the last valid result is retained. ':''}${e.message}${e.details?.length?' '+e.details.join('; '):''}`);return false;}
  finally{if(mounted.current&&id===operation.current)setBusy(false);}
 }
 async function choose(item){
  if(!primary)return;
  const id=++operation.current;readAbort.current?.abort();const abort=new AbortController();readAbort.current=abort;setBusy(true);setError('');
  try{
   const secondary=await snapshotFor(item,abort.signal);if(id!==operation.current)return;
   let first=primary;
   // Current live UI can be source-limited. A whole-session read explicitly acquires all retained sources.
   if(collector && (!result || primary.kind==='collector')){const doc=documentOf(primary);first=await collector.snapshotSession({session_namespace:doc.session.namespace,session_id:doc.session.id,...((result?primary.scope?.source_id:sourceFilter)?{source_id:result?primary.scope.source_id:sourceFilter}:{})},{signal:abort.signal});}
   if(id!==operation.current)return;await compute({primary:first,secondary});
  }catch(e){if(id===operation.current){setBusy(false);if(e.name==='AbortError')setNotice('Snapshot read cancelled or collector reset. The previous comparison remains available.');else setError(e.message);}}
 }
 function openPicker(){pickerTrigger.current=document.activeElement;pickerCancelled.current=false;setPicker(true);}
 function closePicker(){if(busy)cancel();pickerCancelled.current=true;if(result)setPicker(false);else onExit();}
 function closeInspector(){setInspector(false);requestAnimationFrame(()=>{if(focusOrigin.current?.isConnected)focusOrigin.current.focus({preventScroll:true});else document.querySelector('.comparison-viewport')?.focus({preventScroll:true});});}
 function select(id,options={}){if(!inspector)focusOrigin.current=document.activeElement;setSelectedId(id);if(options.open!==false)setInspector(true);}
 function reveal(id,open=false){if(!id)return;setCollapsed(new Set());setCollapseEqual(false);setSearch('');setFilter('all');select(id,{open});}
 function navigate(list,delta,{revealHidden=false}={}){if(!list?.length)return;const index=list.findIndex(p=>p.id===selectedId);const id=list[(index<0?(delta<0?list.length-1:0):(index+delta+list.length)%list.length)].id;if(revealHidden)reveal(id,false);else{select(id,{open:false});}}
 function openDialog(value){dialogOrigin.current=document.activeElement;setDialog(value);setError('');}
 function closeDialog(){if(busy)cancel();setDialog(null);setResolution(null);setError('');requestAnimationFrame(()=>dialogOrigin.current?.isConnected&&dialogOrigin.current.focus());}
 useEffect(()=>{
  const key=e=>{
   if(e.key==='Escape'){if(dialog){e.preventDefault();closeDialog();}else if(picker){e.preventDefault();closePicker();}else if(inspector){e.preventDefault();closeInspector();}return;}
   if(e.defaultPrevented || overlay&&inspector&&inspectorRef.current?.contains(e.target))return;
   if(picker||dialog||e.altKey||e.metaKey||e.ctrlKey||e.target.closest('input,textarea,select,[contenteditable="true"]'))return;
   if(e.key==='['||e.key===']'){e.preventDefault();navigate(projection?.differences,e.key==='['?-1:1,{revealHidden:true});}
   else if(['ArrowUp','ArrowDown','j','k'].includes(e.key)){e.preventDefault();navigate(projection?.navigable,['ArrowUp','k'].includes(e.key)?-1:1);}
   else if(e.key==='Enter' && selectedId && (e.target===document.body || e.target.getAttribute('aria-label')==='Comparison findings')){e.preventDefault();setInspector(true);}
  };document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
 },[picker,dialog,inspector,selectedId,projection,overlay]);
 async function importSecondary(fileList){
  const files=[...fileList];if(files.some(f=>f.size>16*1024*1024)||files.reduce((n,f)=>n+f.size,0)>64*1024*1024){setError('Files exceed the 16 MiB each / 64 MiB combined limit.');return;}
  const id=++operation.current;readAbort.current?.abort();client.current.cancel();const abort=new AbortController();readAbort.current=abort;setBusy(true);setError('');
  try{const payload=await Promise.all(files.map(async f=>({name:f.name,text:await f.text()})));if(id!==operation.current||!mounted.current)return;const snapshots=await client.current.importFiles(payload,{signal:abort.signal});if(id!==operation.current)return;setLibrary(old=>{const map=new Map(old.map(x=>[x.key,x]));for(const s of snapshots)map.set(identity(documentOf(s).session),descriptor(s));return [...map.values()];});}
  catch(e){if(id===operation.current)setError(e.message);}finally{if(id===operation.current)setBusy(false);}
 }
 function exportJSON(){try{const blob=new Blob([JSON.stringify(diff,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='comparison.diff.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError(`Export failed: ${e.message}`);}}
 const matchPair=dialog==='match'?pair:null;
 return <div className="comparison-workspace" style={{'--comparison-inspector-width':`${inspectorWidth}px`}}>
  <div className="comparison-main-shell" inert={picker||!!dialog||inspector&&overlay}>
   <header className="comparison-topbar"><button aria-label="Toggle comparison navigator" aria-expanded={navOpen} onClick={()=>setNavOpen(!navOpen)}>☰</button><strong>↔ Network Log Lab</strong><button onClick={onExit}>Exit comparison</button></header>
   <div className="comparison-identities">{primary&&<Identity side="primary" snapshot={result?.snapshots.primary||primary}/>}<button disabled={!result||busy} aria-label="Swap primary and secondary" onClick={()=>compute({primary:result.snapshots.secondary,secondary:result.snapshots.primary},swapProfile(diff.profile),{swapped:true})}>⇄ Swap</button>{result&&<Identity side="secondary" snapshot={result.snapshots.secondary}/>}<button disabled={busy} onClick={openPicker}>Compare with…</button></div>
   {busy&&<div role="status" className="comparison-notice">Computing canonical comparison… <button onClick={cancel}>Cancel computation</button></div>}
   {error&&<div role="alert" className="comparison-notice error">{error}</div>}{notice&&<div role="status" className="comparison-notice">{notice}</div>}
   {result&&<><div className="comparison-snapshot">Snapshot {result.at} · {Object.entries(result.snapshots).map(([side,s])=>`${side}: ${s.scope?.kind || s.scope?.type || 'whole-session'}${s.scope?.source_id?' '+s.scope.source_id:''}${s.boundary?.high_water!=null?' @ '+s.boundary.high_water:''}`).join(' · ')} · UI filters only hide presentation.</div>
   {collector&&<div className="comparison-live" role="status">{updates?.collectorChanged?'Collector reset: the retained snapshots remain valid; reselect live sessions to compare the new collector.':updates?.error||updates?.changed?updates?.error||`${updates.count??''} new relevant events available. The active comparison is unchanged.`:'Live snapshots frozen; watching for relevant events.'}<button disabled={busy||updates?.collectorChanged} onClick={()=>compute(result.snapshots,diff.profile,{refresh:true})}>Recompute snapshots</button><button aria-pressed={!watching} onClick={()=>setWatching(!watching)}>{watching?'Pause comparison reads':'Resume comparison reads'}</button></div>}
   <div className={`comparison-controls ${controlsOpen?'is-expanded':''}`}><button className="comparison-controls-toggle" aria-expanded={controlsOpen} onClick={()=>setControlsOpen(!controlsOpen)}>Controls and counts</button><div role="tablist" aria-label="Comparison layout">{[['aligned','Aligned sequences'],['outline','Change outline'],['connections','Order connections']].map(([key,label])=><button key={key} role="tab" aria-selected={layout===key} tabIndex={layout===key?0:-1} onKeyDown={e=>{const keys=['aligned','outline','connections'];let next;if(e.key==='ArrowRight')next=(keys.indexOf(key)+1)%3;else if(e.key==='ArrowLeft')next=(keys.indexOf(key)+2)%3;else if(e.key==='Home')next=0;else if(e.key==='End')next=2;else return;e.preventDefault();setLayout(keys[next]);e.currentTarget.parentElement.children[next]?.focus();}} onClick={()=>setLayout(key)}>{label}</button>)}</div><input type="search" aria-label="Search both sessions" placeholder="Search both sessions…" value={search} onChange={e=>setSearch(e.target.value)}/><label>Show <select aria-label="Comparison filter" value={filter} onChange={e=>setFilter(e.target.value)}>{[['all','All'],['changed','Changed'],['one-sided','One-sided'],['unresolved','Unresolved'],['order','Order'],['unknown','Unknown'],['unknown-only','Unknown only']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><button aria-pressed={collapseEqual} onClick={()=>setCollapseEqual(!collapseEqual)}>Collapse unchanged</button><button aria-label="Previous difference" onClick={()=>navigate(projection.differences,-1,{revealHidden:true})}>‹</button><button aria-label="Next difference" onClick={()=>navigate(projection.differences,1,{revealHidden:true})}>›</button><button onClick={()=>navigate(projection.unknownOnly,1,{revealHidden:true})} disabled={!projection.unknownOnly.length}>Find unknown-only ({projection.unknownOnly.length})</button></div>
   <div className={`comparison-summary ${controlsOpen?'is-expanded':''}`} aria-label="Comparison summary"><strong>{diff.result==='equal'?'Equal within scope':diff.result==='different'?`Different${diff.summary.uncertain_pairs?' with uncertainty':''}`:'Inconclusive'}</strong><span>{diff.pairs.length} nodes · {diff.pairs.filter(p=>(p.primary||p.secondary).kind==='http').length} HTTP pairs · P {diff.pairs.filter(p=>p.primary?.kind==='http').length} / S {diff.pairs.filter(p=>p.secondary?.kind==='http').length} requests</span><span>{diff.summary.matched} matched · {diff.summary.primary_only} primary only · {diff.summary.secondary_only} secondary only · {diff.summary.unresolved} unresolved</span><span>Δ {diff.summary.changed_pairs} changed · {diff.summary.field_changes} fields · ⇅ {diff.summary.order_changes} order · ? {diff.summary.uncertain_pairs} uncertain (may overlap)</span><button onClick={()=>openDialog('rules')}>Comparison rules</button><button onClick={exportJSON}>Export JSON</button><button onClick={()=>{const docs={primary:documentOf(result.snapshots.primary),secondary:documentOf(result.snapshots.secondary)};const blob=new Blob([JSON.stringify(docs,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='comparison.snapshots.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>Export snapshots</button></div>

   <div className="comparison-body">{navOpen&&<nav className="comparison-nav" aria-label="Comparison pairs">{diff.pairs.map(p=><button key={p.id} aria-pressed={p.id===selectedId} onClick={()=>reveal(p.id,true)}>{(p.primary||p.secondary).label}<small>{p.presence.replaceAll('_',' ')} · {p.changes.length} fields · {p.uncertainties.length} unknown</small></button>)}</nav>}<main className="comparison-viewport" tabIndex={0} aria-label="Comparison findings">
   <div className="comparison-hidden">{projection.navigable.length} of {diff.pairs.length} nodes shown · {projection.hiddenCount} hidden {projection.hiddenCount>0&&<button onClick={()=>{setSearch('');setFilter('all');setCollapseEqual(false);setCollapsed(new Set());}}>Show all</button>}</div>
   {!projection.navigable.length?<div className="empty"><h2>{collapseEqual?'Unchanged regions collapsed':'No comparison findings match'}</h2><p>{diff.result==='equal'?'Both snapshots are equal within the declared scope and profile.':'Change the presentation filters or expand unchanged regions.'}</p></div>:<ComparisonLayouts layout={layout} diff={diff} snapshots={result.snapshots} selectedId={selectedId} onSelect={select} onLocate={reveal} visibleIds={projection.visibleIds} collapsed={collapsed} onToggleCollapse={id=>setCollapsed(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;})} resolution={resolution}/>}
   </main></div><footer className="comparison-footer">↑↓ / j k select · [ ] differences · Enter inspect · Escape close · Pan for full lanes. Order crossings are observations, not causal conclusions.</footer></>}
  </div>
  {result&&pair&&inspector&&<><div className="comparison-resizer" inert={!!dialog||picker} hidden={overlay} role="separator" aria-orientation="vertical" aria-label="Resize paired inspector" aria-valuemin={320} aria-valuemax={680} aria-valuenow={inspectorWidth} tabIndex={0} onKeyDown={e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setInspectorWidth(w=>Math.max(320,Math.min(680,w+(e.key==='ArrowLeft'?20:-20))));}}} onPointerDown={e=>e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))setInspectorWidth(Math.max(320,Math.min(680,window.innerWidth-e.clientX)));}}/><aside ref={inspectorRef} className={`comparison-inspector-host ${overlay?'overlay':''}`} inert={!!dialog||picker} role={overlay?'dialog':undefined} aria-modal={overlay||undefined} aria-label="Paired details" onKeyDown={overlay?trapTab:undefined}><PairInspector pair={pair} diff={diff} snapshots={result.snapshots} tab={tab} onTab={setTab} onClose={closeInspector} onResolve={()=>openDialog('match')} onLocate={(id,value)=>{if(value)setLayout(value);if(overlay)closeInspector();reveal(id);}}/></aside></>}
  {picker&&<div className="comparison-picker-backdrop"><section ref={pickerRef} className="comparison-picker" role="dialog" aria-modal="true" aria-label="Choose secondary session" onKeyDown={trapTab}><div className="actions"><h2>Compare with…</h2><button onClick={closePicker}>Close</button></div><p>Choose one secondary session. Namespace and session ID identify each side.</p><input type="search" aria-label="Search sessions" placeholder="Namespace, session, platform, build…" value={pickerSearch} onChange={e=>setPickerSearch(e.target.value)}/><label className="comparison-file-label">Import secondary files<input type="file" multiple accept=".ndjson,.jsonl,.json,.txt" aria-label="Import secondary files" onChange={e=>{importSecondary(e.target.files);e.target.value='';}}/></label>{busy&&<p role="status">Reading / computing… <button onClick={cancel}>Cancel computation</button></p>}{error&&<p role="alert" className="notice error">{error}</p>}{choices.map(item=><button className="comparison-session-option" key={item.key} disabled={busy} onClick={()=>choose(item)}><strong>{item.snapshot?documentOf(item.snapshot).events.find(e=>e.event_type==='session.started')?.data.name:item.retained?.name||item.session.id}</strong><span className="mono">{item.session.namespace} / {item.session.id}</span><small>{item.snapshot?metadataText(item.snapshot):`${(item.retained?.source_ids||[]).map(id=>{const source=sources.find(s=>s.source_id===id);return source?[source.platform,source.app_id,source.environment_name,id].filter(Boolean).join(' · '):id;}).join(' | ')} · ${item.retained?.event_count??'?'} events · build not recorded`}</small><small>Compare →</small></button>)}{catalogError&&<p role="alert" className="notice error">{catalogError}</p>}{catalogPage?.has_more&&<button disabled={busy} onClick={()=>loadCatalog(true)}>More retained sessions</button>}{!choices.length&&<p>No other sessions found. Import another canonical capture.</p>}<p className="muted">Files remain local. Retained sessions are read from the actual collector at a fixed event boundary. Whole-session scope includes all sources unless the primary source scope was explicitly selected.</p></section></div>}
  {dialog==='rules'&&diff&&<RulesDialog diff={diff} profile={diff.profile} onApply={profile=>compute(result.snapshots,profile)} onCancel={closeDialog} error={error} busy={busy} onCancelComputation={cancel}/>}
  {matchPair&&<MatchDialog pair={matchPair} diff={diff} resolution={resolution} onCandidate={previewCandidate} onApply={profile=>compute(result.snapshots,profile)} onCancel={closeDialog} error={error} busy={busy} onCancelComputation={cancel}/>}
 </div>;
}
