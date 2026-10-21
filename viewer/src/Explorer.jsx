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

const plural=(n,one,many=one+'s')=>`${n} ${n===1?one:many}`;

// Collapsible section: an h3 holding a disclosure button keeps heading navigation; extra controls share the header line.
function Section({actions,collapsed,id,title,label,extra,className='',children}){
 const open=!collapsed.has(id);
 return <section className={`tree-section ${className}`.trim()}><div className="tree-section-head"><h3><button type="button" aria-expanded={open} title={label} onClick={()=>actions.toggle(id,!open)}>{title}</button></h3>{extra}</div>{open&&children}</section>;
}

// Folder rows receive stable actions and their own listing/entries, so progress in one folder doesn't re-render the others.
const Tree=memo(function Tree({actions,collapsed,shown,folder,path,entries,...rest}){
 const key=actions.nodeKey(folder.id,path),limit=shown[key]??actions.limits.pageLogs;
 const [dirs,logs,visible]=useMemo(()=>{const logs=entries.filter(e=>e.kind==='file');return [entries.filter(e=>e.kind==='directory'),logs,logs.length>limit?logs.slice(0,limit):logs];},[entries,limit]);
 return <>{dirs.map(dir=><SubFolder key={dir.path} actions={actions} collapsed={collapsed} shown={shown} folder={folder} entry={dir} {...rest}/>)}<LogRows entries={visible} folder={folder} {...rest}/>
  {logs.length>visible.length&&<Row className="tree-more" name={`Show ${Math.min(actions.limits.pageLogs,logs.length-visible.length)} more`} subs={[{text:`${visible.length} of ${logs.length} logs shown`}]} onClick={()=>actions.showMore(key)}/>}</>;
});

// Scanned subfolders all contain logs; they start open and stay user-collapsible.
const SubFolder=memo(function SubFolder({actions,collapsed,folder,entry,...rest}){
 const key=actions.nodeKey(folder.id,entry.path),open=!collapsed.has(key);
 return <details className="tree-folder" open={open} onToggle={e=>actions.toggle(key,e.currentTarget.open)}><summary title={`${entry.path}\n${plural(entry.logs,'log')}`}><span className="name">{entry.name}/</span><small aria-hidden="true">{entry.logs}</small><span className="sr-only">, folder, {plural(entry.logs,'log')}</span></summary>{open&&<Tree actions={actions} collapsed={collapsed} folder={folder} path={entry.path} entries={entry.entries} {...rest}/>}</details>;
});

const Folder=memo(function Folder({actions,folder,listing,...rest}){
 const key=actions.nodeKey(folder.id),open=!rest.collapsed.has(key),ready=folder.status==='ready',{limits}=actions;
 const suffix=folder.status==='prompt'?'· access needed':folder.status==='denied'?'· access denied':folder.status==='missing'?'· unavailable':folder.persisted?'':'· this visit';
 const scanning=listing?.state==='loading',done=listing?.state==='ready';
 // Focus the next folder (else previous, else Add folder) once the row is gone; a failed removal keeps focus here.
 const remove=async e=>{const row=e.currentTarget.closest('.tree-root'),machine=row.closest('.tree-machine'),rows=[...machine.querySelectorAll(':scope>.tree-root')],i=rows.indexOf(row),next=rows[i+1]||rows[i-1];
  if(await actions.remove(folder.id))requestAnimationFrame(()=>(next?.isConnected?next.querySelector('summary'):machine.querySelector('.tree-add')||machine.querySelector('h3 button'))?.focus());};
 // Buttons come first in the DOM so they stay reachable without tabbing through the tree; CSS places them on the summary line.
 return <div className="tree-root">
  <span className="tree-root-actions">{ready&&<button type="button" aria-label={`Refresh folder ${folder.name}`} title={listing?.at?`Refresh folder (scanned ${formatShortTime(listing.at,rest.now)})`:'Refresh folder'} onClick={()=>actions.refresh(folder.id)}>↻</button>}<button type="button" className="tree-remove" aria-label={`Remove folder ${folder.name}`} title="Remove folder" onClick={remove}>−</button></span>
  <span className="sr-only" role="status">{scanning?`Scanning ${folder.name}…`:done?`Scanned ${folder.name}, ${plural(listing.logs,'log')}`:''}</span>
  <details className="tree-folder tree-root-folder" data-folder-id={folder.id} open={open} onToggle={e=>actions.toggle(key,e.currentTarget.open)}>
  <summary title={folder.name+'/'}><span className="name">{folder.name}/</span>{suffix?<small>{suffix}</small>:listing?.logs!=null&&<small aria-hidden="true">{listing.logs}</small>}<span className="sr-only">, folder{done?`, ${plural(listing.logs,'log')}`:''}</span></summary>
  {scanning&&<p className="tree-empty" aria-hidden="true">Scanning…{listing.progress?` ${listing.progress}`:''}</p>}
  {folder.status==='prompt'&&<div className="tree-actions"><span>Reconnect to list {folder.name}/ again.</span><button type="button" onClick={()=>actions.reconnect(folder.id)}>Reconnect</button></div>}
  {folder.status==='denied'&&<p className="tree-empty warn">⚠ Access to {folder.name}/ was denied.</p>}
  {folder.status==='missing'&&<p className="tree-empty warn">⚠ Folder unavailable</p>}
  {ready&&listing?.state==='error'&&<p className="tree-empty warn">⚠ {listing.error}</p>}
  {ready&&open&&listing?.entries&&<Tree actions={actions} folder={folder} path="" entries={listing.entries} {...rest}/>}
  {ready&&done&&<>{!listing.logs&&<p className="tree-empty">No .ndjson logs in this folder or its subfolders.</p>}
   {listing.logLimit&&<p className="tree-empty">Showing newest {listing.logs} logs; limit reached.</p>}
   {listing.truncated&&<p className="tree-empty">Scan stopped after {limits.maxScanned} entries; showing {plural(listing.logs,'log')}.</p>}
   {listing.tooDeep>0&&<p className="tree-empty">{plural(listing.tooDeep,'folder')} more than {limits.maxDepth} levels deep not scanned.</p>}
   {listing.unreadable>0&&<p className="tree-empty warn">⚠ {plural(listing.unreadable,'subfolder')} couldn’t be read.</p>}</>}
 </details></div>;
});

function Explorer({explorer,machineName,liveAvailable,liveState,sources=EMPTY,sessions=EMPTY,moreSessions,sourceFilter,onAllDevices,onSource,onLiveSession,onMoreSessions,onResume,imported,onImportedSession,onOpenLog,onSelectSession,onChooseFiles,current,openSessions,now:nowProp,children}){
 const root=useRef(),dirInput=useRef(),now=nowProp??minuteNow();
 // Every mounted instance (nav, sheet, import page) tries; the visible one focuses, then the request is cleared either way.
 useEffect(()=>{const id=explorer.focusId;if(!id)return;const target=root.current?.querySelector(`[data-folder-id="${CSS.escape(id)}"]>summary`);if(target?.getClientRects().length)target.focus();const frame=requestAnimationFrame(()=>explorer.clearFocus(id));return()=>cancelAnimationFrame(frame);},[explorer.focusId,explorer.folders]);
 const paused=liveState==='idle',showDevices=liveAvailable||sources.length>0,label=machineLabel(machineName);
 const environments=[...new Set(sources.map(s=>s.environment_id))],filtered=sources.find(s=>s.source_id===sourceFilter);
 const [liveRows,liveDups]=useMemo(()=>{const rows=withShort(sessions.map(s=>({s,name:s.name||'Unnamed session',time:iso(s.first_event_at)})),now);return [rows,duplicateLabels(rows,now)];},[sessions,now]);
 const importedGroups=useMemo(()=>sessionsByFile(imported).map(({file,sessions:list})=>{const rows=withShort(list.map(s=>({s,name:sessionName(s)||baseName(file.name),time:iso(s.startedAt),events:s.recordings.reduce((n,r)=>n+r.events.length,0)})),now);return {file,rows,dups:duplicateLabels(rows,now)};}),[imported,now]);
 const importedRow=({s,name,time,short,events},file,dup)=>{return <Row key={s.id} className="session-row imported-session" name={name} time={time} short={short} now={now} current={current?.kind==='import'&&current.sessionId===s.id} subs={[dup&&{text:s.sessionId,mono:true}]} title={rowTitle({name,file:file.name,time,events})} onClick={()=>onImportedSession(s.id)}/>;};
 const {actions,collapsed,shown}=explorer;
 return <div className="source-navigation explorer" ref={root}>
  {showDevices&&<><Section actions={actions} collapsed={collapsed} id="devices" title={<>Devices and environments{paused&&<span>· Paused</span>}</>} extra={paused&&liveAvailable&&<button type="button" className="tree-resume" onClick={onResume}>Resume live</button>}>
  <Row name="All devices" pressed={!sourceFilter} onClick={onAllDevices}/>
  {environments.map(environment=>{const first=sources.find(s=>s.environment_id===environment),name=first?.environment_name||environment;return <details key={environment} open><summary title={environment}><span className="name">{name}</span>{new Set(sources.filter(s=>(s.environment_name||s.environment_id)===name).map(s=>s.environment_id)).size>1&&<small>{environment}</small>}</summary>
   {[...new Set(sources.filter(s=>s.environment_id===environment).map(s=>s.app_id))].map(app=>{const group=sources.filter(s=>s.environment_id===environment&&s.app_id===app);return <details key={app} open><summary title={app}><span className="name">{app}</span></summary>{group.map(source=>{const ready=READY.test(source.status||''),collide=group.filter(s=>s.platform===source.platform).length>1,detail=!ready&&source.status&&source.status!=='Last seen with retained history'?source.status:null,time=iso(source.last_seen);
    return <Row key={source.source_id} className="source-row" glyph={ready?'●':'◌'} name={platformLabel(source.platform)} time={time} timeLabel="last seen" now={now} pressed={sourceFilter===source.source_id} subs={[collide&&{text:`inst ${source.installation_id?.slice(0,8)||source.source_id.slice(0,8)} · ${source.instance_id?.slice(0,8)||source.source_id.slice(-8)}`,mono:true},detail&&{text:detail},!ready&&source.reason&&detail&&{text:source.reason}]} title={[`${platformLabel(source.platform)} · ${app}`,source.status||'Status not reported',source.reason,time&&`Last seen ${time}`,source.source_id].filter(Boolean).join('\n')} onClick={()=>onSource(source)}/>;})}</details>;})}</details>;})}</Section>
  <Section actions={actions} collapsed={collapsed} id="sessions" title={<>Sessions{filtered&&<span>· {platformLabel(filtered.platform)}</span>}</>}>
  {liveRows.map(({s,name,time,short},i)=>{const id=JSON.stringify([s.session_namespace,s.session_id]);return <Row key={id} className="session-row live-session" name={name} time={time} short={short} now={now} current={current?.kind==='live'&&current.sessionId===id} subs={[liveDups[i]&&{text:s.session_id,mono:true}]} title={rowTitle({name,path:`${s.session_namespace} / ${s.session_id}`,time,events:s.event_count,extra:`${s.source_ids?.length||1} source(s)`})} onClick={()=>onLiveSession(s)}/>;})}
  {moreSessions&&<Row className="tree-more" name="More sessions" onClick={onMoreSessions}/>}
  {!sources.length&&!paused&&<p className="tree-empty">Ready and waiting for apps. Start an instrumented debug app.</p>}</Section></>}
  <Section actions={actions} collapsed={collapsed} id="machine" className="tree-machine" label={machineName||'Machine name not reported'} title={label?<>This machine <span>· {label}</span></>:'This computer'}>
   {explorer.folders.map(folder=><Folder key={folder.id} actions={actions} collapsed={collapsed} shown={shown} folder={folder} listing={explorer.listings[actions.nodeKey(folder.id)]} current={current} openSessions={openSessions} onOpenLog={onOpenLog} onSelectSession={onSelectSession} now={now}/>)}
   {explorer.support==='picker'&&<Row className="tree-add" glyph="+" name="Add folder…" title="Choose a folder of .ndjson captures. It stays listed after reload." onClick={()=>explorer.addFolder()}/>}
   {explorer.support==='input'&&<><input ref={dirInput} className="sr-only" type="file" tabIndex={-1} aria-hidden="true" multiple {...{webkitdirectory:''}} onChange={e=>{explorer.addFiles(e.target.files);e.target.value='';}}/><Row className="tree-add" glyph="+" name="Add folder (this visit only)" title="Lists a snapshot of the chosen folder until reload." onClick={()=>dirInput.current?.click()}/></>}
   {explorer.support==='none'&&<><p className="tree-empty">Folder access needs Chrome or Edge; use Import files.</p>{onChooseFiles&&<Row className="tree-add" name="Choose files…" onClick={onChooseFiles}/>}</>}
   {!explorer.folders.length&&explorer.support!=='none'&&<p className="tree-empty">Add a folder to browse its .ndjson logs.</p>}
   {explorer.storageNotice&&<p className="tree-empty warn">{explorer.storageNotice}</p>}
   {explorer.notice&&<p className="tree-empty" role="status">{explorer.notice}</p>}
  </Section>
  {importedGroups.length>0&&<Section actions={actions} collapsed={collapsed} id="imported" title="Imported files">{importedGroups.map(({file,rows:list,dups})=>{
   if(list.length===1)return importedRow(list[0],file,false);
   if(!list.length)return <Row key={file.id} className="imported-file" glyph="⇣" name={file.name} warn subs={[{text:'⚠ No sessions'}]} title={`${file.name}\nOpen import diagnostics`} onClick={()=>onImportedSession(null)}/>;
   return <details key={file.id} className="tree-folder" open><summary title={file.name}><span className="glyph" aria-hidden="true">⇣</span><span className="name">{file.name}</span><small>{list.length} sessions</small></summary>{list.map((row,i)=>importedRow(row,file,dups[i]))}</details>;})}</Section>}
  {children}
 </div>;
}
export default memo(Explorer);
