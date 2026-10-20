import React, {memo,useEffect,useMemo,useRef} from 'react';
import {baseName,duplicateLabels,formatShortTime,logLabel,machineLabel,rowTitle,sessionsByFile} from './log-explorer.mjs';
import './explorer.css';

const EMPTY=[];
const PLATFORMS={android:'Android',ios:'iOS',web:'Browser',server:'Server'};
const platformLabel=p=>PLATFORMS[p]||p||'Source';
const READY=/^(Ready|Delivering)/;
const iso=v=>{if(v==null||v==='')return null;const d=new Date(v);return Number.isFinite(d.getTime())?d.toISOString():null;};
const sessionName=s=>s.name&&s.name!=='Session metadata not recorded'?s.name:null;
// One Date per minute keeps memoized rows stable between renders while "today" stays current.
let minute=null;
const minuteNow=()=>{const at=Math.floor(Date.now()/60000);if(minute?.at!==at)minute={at,date:new Date(at*60000)};return minute.date;};
const withShort=(rows,now)=>rows.map(row=>({...row,short:row.time?formatShortTime(row.time,now):''}));

export function Row({name,time,short,timeLabel='started',title,glyph='',subs=[],badge,current,pressed,className='',onClick,disabled,warn,now}){
 return <button type="button" className={`tree-row ${className}${warn?' warn':''}`} aria-current={current?'true':undefined} aria-pressed={pressed} title={title} disabled={disabled} onClick={onClick}><span className={`glyph${glyph==='●'?' live':''}`} aria-hidden="true">{glyph}</span><span className="name"><span className="label">{name}</span>{badge&&<span className="count" title={badge.title}>{badge.text}</span>}</span>{time?<time dateTime={time}><span className="sr-only">{timeLabel} </span>{short??formatShortTime(time,now)}</time>:<span/>}{subs.filter(Boolean).map((sub,i)=><span key={i} className={`sub${sub.mono?' mono':''}`}>{sub.text}</span>)}</button>;
}

const LogRows=memo(function LogRows({entries,folder,current,openSessions,onOpenLog,onSelectSession,now}){
 const [logs,dups]=useMemo(()=>{const rows=withShort(entries.map(e=>({entry:e,...logLabel(e)})),now);return [rows,duplicateLabels(rows,now)];},[entries,now]);
 return logs.map(({entry,name,time,short,sessions},i)=>{const key=`${folder.id}:${entry.path}`,isOpen=current?.kind==='folder'&&current.key===key,split=isOpen&&openSessions?.length>1,error=entry.header?.error;
  return <React.Fragment key={entry.path}><Row className="log-row" name={name} time={time} short={short} now={now} warn={!!error} disabled={error==='Too large'} current={isOpen&&!split} badge={sessions>1?{text:`+${sessions-1}`,title:`${sessions} sessions`}:null} title={rowTitle({name,path:entry.path,time,events:entry.header?.complete?entry.header.events:undefined,sessions,extra:error})} subs={[dups[i]&&{text:entry.name,mono:true},error&&{text:`⚠ ${error}`}]} onClick={()=>onOpenLog(folder,entry)}/>
  {split&&<div className="tree-children">{openSessions.map(s=><Row key={s.id} className="log-session" name={sessionName(s)||baseName(entry.name)} time={iso(s.startedAt)} now={now} current={current.sessionId===s.id} title={rowTitle({name:sessionName(s)||entry.name,path:`${entry.path} · ${s.sessionId}`,time:iso(s.startedAt)})} onClick={()=>onSelectSession(s.id)}/>)}</div>}</React.Fragment>;});
});

function Listing({explorer,folder,path,depth,...rest}){
 const listing=explorer.listings[explorer.nodeKey(folder.id,path)],entries=listing?.entries;
 const [dirs,logs]=useMemo(()=>[entries?.filter(e=>e.kind==='directory')??EMPTY,entries?.filter(e=>e.kind==='file')??EMPTY],[entries]);
 if(!listing||listing.state==='loading')return <p className="tree-empty" role="status">Scanning…{listing?.progress?` ${listing.progress}`:''}</p>;
 if(listing.state==='error')return <p className="tree-empty warn">⚠ {listing.error}</p>;
 // depth counts nested subfolders below the added folder; maxDepth of them are listable.
 return <>{dirs.map(dir=>depth+1>explorer.limits.maxDepth?<p key={dir.path} className="tree-empty" title={dir.path}>{dir.name}/ · too deep to list</p>:<SubFolder key={dir.path} explorer={explorer} folder={folder} entry={dir} depth={depth+1} {...rest}/>)}
 <LogRows entries={logs} folder={folder} {...rest}/>
 {!listing.entries.length&&<p className="tree-empty">No .ndjson logs in this folder.</p>}
 {listing.overflow>0&&<p className="tree-empty">{listing.overflow} more not shown</p>}{listing.truncated&&<p className="tree-empty">Listing stopped after {explorer.limits.maxScanned} entries; open a narrower folder.</p>}</>;
}

function SubFolder({explorer,folder,entry,depth,...rest}){
 const key=explorer.nodeKey(folder.id,entry.path),open=explorer.expanded.has(key);
 return <details className="tree-folder" open={open} onToggle={e=>explorer.toggle(key,e.currentTarget.open,folder,entry.path,entry.handle)}><summary title={entry.path}><span className="name">{entry.name}/</span><span className="sr-only">, folder</span></summary>{open&&<Listing explorer={explorer} folder={folder} path={entry.path} depth={depth} {...rest}/>}</details>;
}

function Folder({explorer,folder,...rest}){
 const key=explorer.nodeKey(folder.id),open=explorer.expanded.has(key),listing=explorer.listings[key];
 const suffix=folder.status==='prompt'?'· access needed':folder.status==='denied'?'· access denied':folder.status==='missing'?'· unavailable':folder.persisted?'':'· this visit';
 const status=listing?.state==='loading'?`Scanning… ${listing.progress||''}`.trim():listing?.at?`scanned ${formatShortTime(listing.at,rest.now)}`:'';
 return <details className="tree-folder tree-root-folder" data-folder-id={folder.id} open={open} onToggle={e=>explorer.toggle(key,e.currentTarget.open,folder,'',folder.handle)}>
  <summary title={folder.name+'/'}><span className="name">{folder.name}/</span>{suffix&&<small>{suffix}</small>}<span className="sr-only">, folder{listing?.logs!=null?`, ${listing.logs} logs`:''}</span></summary>
  <div className="tree-actions">{folder.status==='ready'?<button type="button" onClick={()=>explorer.refresh(folder.id)}>Refresh</button>:folder.status==='prompt'?<button type="button" onClick={()=>explorer.reconnect(folder.id)}>Reconnect</button>:null}{folder.status!=='denied'&&folder.status!=='missing'&&<span aria-hidden="true">·</span>}<button type="button" onClick={async e=>{const machine=e.currentTarget.closest('.tree-machine');await explorer.remove(folder.id);requestAnimationFrame(()=>machine?.querySelector('.tree-root-folder>summary,.tree-add')?.focus());}}>Remove</button><span role="status">{status}</span></div>
  {folder.status==='prompt'&&<p className="tree-empty">Reconnect to list {folder.name}/ again.</p>}
  {folder.status==='denied'&&<p className="tree-empty warn">⚠ Access to {folder.name}/ was denied.</p>}
  {folder.status==='missing'&&<p className="tree-empty warn">⚠ Folder unavailable</p>}
  {folder.status==='ready'&&open&&<Listing explorer={explorer} folder={folder} path="" depth={0} {...rest}/>}
 </details>;
}

function Explorer({explorer,machineName,liveAvailable,liveState,sources=EMPTY,sessions=EMPTY,moreSessions,sourceFilter,onAllDevices,onSource,onLiveSession,onMoreSessions,onResume,imported,onImportedSession,onOpenLog,onSelectSession,onChooseFiles,current,openSessions,now:nowProp,children}){
 const root=useRef(),dirInput=useRef(),now=nowProp??minuteNow();
 // Every mounted instance (nav, sheet, import page) tries; the visible one focuses, then the request is cleared either way.
 useEffect(()=>{const id=explorer.focusId;if(!id)return;const target=root.current?.querySelector(`[data-folder-id="${CSS.escape(id)}"]>summary`);if(target?.getClientRects().length)target.focus();const frame=requestAnimationFrame(()=>explorer.clearFocus(id));return()=>cancelAnimationFrame(frame);},[explorer.focusId,explorer.folders]);
 const paused=liveState==='idle',showDevices=liveAvailable||sources.length>0,label=machineLabel(machineName);
 const environments=[...new Set(sources.map(s=>s.environment_id))],filtered=sources.find(s=>s.source_id===sourceFilter);
 const [liveRows,liveDups]=useMemo(()=>{const rows=withShort(sessions.map(s=>({s,name:s.name||'Unnamed session',time:iso(s.first_event_at)})),now);return [rows,duplicateLabels(rows,now)];},[sessions,now]);
 const importedGroups=useMemo(()=>sessionsByFile(imported).map(({file,sessions:list})=>{const rows=withShort(list.map(s=>({s,name:sessionName(s)||baseName(file.name),time:iso(s.startedAt),events:s.recordings.reduce((n,r)=>n+r.events.length,0)})),now);return {file,rows,dups:duplicateLabels(rows,now)};}),[imported,now]);
 const importedRow=({s,name,time,short,events},file,dup)=>{return <Row key={s.id} className="session-row imported-session" name={name} time={time} short={short} now={now} current={current?.kind==='import'&&current.sessionId===s.id} subs={[dup&&{text:s.sessionId,mono:true}]} title={rowTitle({name,file:file.name,time,events})} onClick={()=>onImportedSession(s.id)}/>;};
 const toggleGroup=key=>e=>explorer.toggle(key,e.currentTarget.open);
 return <div className="source-navigation explorer" ref={root}>
  {showDevices&&<><h3>Devices and environments{paused&&<span>· Paused</span>}</h3>
  {paused&&liveAvailable&&<button type="button" className="tree-resume" onClick={onResume}>Resume live</button>}
  <Row name="All devices" pressed={!sourceFilter} onClick={onAllDevices}/>
  {environments.map(environment=>{const first=sources.find(s=>s.environment_id===environment),name=first?.environment_name||environment;return <details key={environment} open><summary title={environment}><span className="name">{name}</span>{new Set(sources.filter(s=>(s.environment_name||s.environment_id)===name).map(s=>s.environment_id)).size>1&&<small>{environment}</small>}</summary>
   {[...new Set(sources.filter(s=>s.environment_id===environment).map(s=>s.app_id))].map(app=>{const group=sources.filter(s=>s.environment_id===environment&&s.app_id===app);return <details key={app} open><summary title={app}><span className="name">{app}</span></summary>{group.map(source=>{const ready=READY.test(source.status||''),collide=group.filter(s=>s.platform===source.platform).length>1,detail=!ready&&source.status&&source.status!=='Last seen with retained history'?source.status:null,time=iso(source.last_seen);
    return <Row key={source.source_id} className="source-row" glyph={ready?'●':'◌'} name={platformLabel(source.platform)} time={time} timeLabel="last seen" now={now} pressed={sourceFilter===source.source_id} subs={[collide&&{text:`inst ${source.installation_id?.slice(0,8)||source.source_id.slice(0,8)} · ${source.instance_id?.slice(0,8)||source.source_id.slice(-8)}`,mono:true},detail&&{text:detail},!ready&&source.reason&&detail&&{text:source.reason}]} title={[`${platformLabel(source.platform)} · ${app}`,source.status||'Status not reported',source.reason,time&&`Last seen ${time}`,source.source_id].filter(Boolean).join('\n')} onClick={()=>onSource(source)}/>;})}</details>;})}</details>;})}
  <h3>Sessions{filtered&&<span>· {platformLabel(filtered.platform)}</span>}</h3>
  {liveRows.map(({s,name,time,short},i)=>{const id=JSON.stringify([s.session_namespace,s.session_id]);return <Row key={id} className="session-row live-session" name={name} time={time} short={short} now={now} current={current?.kind==='live'&&current.sessionId===id} subs={[liveDups[i]&&{text:s.session_id,mono:true}]} title={rowTitle({name,path:`${s.session_namespace} / ${s.session_id}`,time,events:s.event_count,extra:`${s.source_ids?.length||1} source(s)`})} onClick={()=>onLiveSession(s)}/>;})}
  {moreSessions&&<Row className="tree-more" name="More sessions" onClick={onMoreSessions}/>}
  {!sources.length&&!paused&&<p className="tree-empty">Ready and waiting for apps. Start an instrumented debug app.</p>}</>}
  <details className="tree-group tree-machine" open={explorer.expanded.has('machine')} onToggle={toggleGroup('machine')}><summary title={machineName||'Machine name not reported'}><span className="name">{label?<>This machine <span>· {label}</span></>:'This computer'}</span></summary>
   {explorer.folders.map(folder=><Folder key={folder.id} explorer={explorer} folder={folder} current={current} openSessions={openSessions} onOpenLog={onOpenLog} onSelectSession={onSelectSession} now={now}/>)}
   {explorer.support==='picker'&&<Row className="tree-add" glyph="+" name="Add folder…" title="Choose a folder of .ndjson captures. It stays listed after reload." onClick={()=>explorer.addFolder()}/>}
   {explorer.support==='input'&&<><input ref={dirInput} className="sr-only" type="file" tabIndex={-1} aria-hidden="true" multiple {...{webkitdirectory:''}} onChange={e=>{explorer.addFiles(e.target.files);e.target.value='';}}/><Row className="tree-add" glyph="+" name="Add folder (this visit only)" title="Lists a snapshot of the chosen folder until reload." onClick={()=>dirInput.current?.click()}/></>}
   {explorer.support==='none'&&<><p className="tree-empty">Folder access needs Chrome or Edge; use Import files.</p>{onChooseFiles&&<Row className="tree-add" name="Choose files…" onClick={onChooseFiles}/>}</>}
   {!explorer.folders.length&&explorer.support!=='none'&&<p className="tree-empty">Add a folder to browse its .ndjson logs.</p>}
   {explorer.storageNotice&&<p className="tree-empty warn">{explorer.storageNotice}</p>}
   {explorer.notice&&<p className="tree-empty" role="status">{explorer.notice}</p>}
  </details>
  {importedGroups.length>0&&<><h3>Imported files</h3>{importedGroups.map(({file,rows:list,dups})=>{
   if(list.length===1)return importedRow(list[0],file,false);
   if(!list.length)return <Row key={file.id} className="imported-file" glyph="⇣" name={file.name} warn subs={[{text:'⚠ No sessions'}]} title={`${file.name}\nOpen import diagnostics`} onClick={()=>onImportedSession(null)}/>;
   return <details key={file.id} className="tree-folder" open><summary title={file.name}><span className="glyph" aria-hidden="true">⇣</span><span className="name">{file.name}</span><small>{list.length} sessions</small></summary>{list.map((row,i)=>importedRow(row,file,dups[i]))}</details>;})}</>}
  {children}
 </div>;
}
export default memo(Explorer);
