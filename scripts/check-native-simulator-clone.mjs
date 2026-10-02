#!/usr/bin/env node
// Actual clone of run-created simulators only. Local ownership binding is distinct from bearer authority.
import assert from 'node:assert/strict';
import {chmod,cp,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rename,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {startCollector} from '../collector/server.mjs';
import {watchSimulators} from '../collector/ios-simulator.mjs';
import {runOwnedProcess} from './lib/instrumentation-process.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const usage=`Usage: node scripts/check-native-simulator-clone.mjs --fixture-app PASSED_PRIVATE_LIFECYCLE_APP\n       node scripts/check-native-simulator-clone.mjs --help\nCreates, shuts down, clones and deletes ONLY simulators created by this run.\nNo pre-existing simulator/device targets are accepted. Fixture must be a passed private lifecycle artifact.\n`;
export function parseArguments(argv){
 const options=new Map();for(let i=0;i<argv.length;i++){
  const key=argv[i];assert(['--fixture-app','--help'].includes(key),'Unknown argument: '+key);assert(!options.has(key),'Duplicate option: '+key);
  if(key==='--help'){options.set(key,true);continue;}const value=argv[++i];assert(value&&!value.startsWith('--'),'Missing value for '+key);options.set(key,value);
 }
 if(options.has('--help'))assert.equal(argv.length,1,'--help must be used alone');else assert(options.has('--fixture-app'),'An explicit --fixture-app PASSED_PRIVATE_LIFECYCLE_APP is required');
 return{help:options.has('--help'),fixture:options.get('--fixture-app')};
}
export function assertOwnedMetadata(metadata,ownedEnvironments,app){
 if(metadata?.app_id!==app||!ownedEnvironments.has(metadata?.environment_id))throw Object.assign(new Error('Owned clone fixture guard: foreign enrollment/binding refused'),{status:403});
}
export async function boundedFile(path,maximum=16384){
 const fd=await open(path,'r');try{const info=await fd.stat();assert(info.isFile()&&info.size<=maximum,'Fixture file is not bounded regular data');const bytes=Buffer.alloc(info.size);let offset=0;while(offset<bytes.length){const result=await fd.read(bytes,offset,bytes.length-offset,offset);assert(result.bytesRead>0,'Fixture changed during read');offset+=result.bytesRead;}return bytes;}finally{await fd.close();}
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function within(label,operation,timeout){let timer;try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,fail)=>{timer=setTimeout(()=>fail(new Error(label+' deadline exceeded')),timeout);})]);}finally{clearTimeout(timer);}}
// Register non-idempotent resource effects synchronously, before fallible evidence writes.
export function trackCreatedSimulator(command,args,stdout,ownedUDIDs,ownedEnvironments){
 if(command!=='xcrun'||args[0]!=='simctl'||!['create','clone'].includes(args[1]))return undefined;
 if(args[1]==='clone')assert(ownedUDIDs.has(args[2]),'Clone origin must have been created by this run');
 const udid=stdout.toString('utf8').trim();assert(/^[a-fA-F0-9-]{36}$/.test(udid));ownedUDIDs.add(udid);ownedEnvironments.add('simulator:'+udid);return udid;
}
// Ordinary operation checkpoints stay strict; cleanup commands still run if evidence storage fails.
export async function runCloneTool(command,args,{checkpoint,cleanup=false,onEvidenceError=()=>{},onClosed=()=>{},onFailure=()=>{},...options}){
 const save=async()=>{try{await checkpoint();}catch(error){if(!cleanup)throw error;onEvidenceError(error);}};
 await save();try{const out=await runOwnedProcess(command,args,options);assert.equal(out.code,0,command+' exited '+out.code+' signal '+out.signal);onClosed(out);await save();return out;}
 catch(error){onFailure(error);try{await save();}catch(evidenceError){onEvidenceError(evidenceError);}throw error;}
}
// Checkpoint failures cannot interrupt ownership cleanup or replace the primary failure.
export async function cleanupOwnedAction(label,action,checkpoint,errors,timeout=30000){
 const note=async(name,data)=>{try{await checkpoint(name,data);}catch(error){errors.push({action:'checkpoint '+name,error:error.message});}};
 await note('cleanup-start',{action:label});try{await within(label,action,timeout);await note('cleanup-complete',{action:label});return true;}catch(error){errors.push({action:label,error:error.message});await note('cleanup-failed',{action:label,reason:error.message});return false;}
}
async function main(options){
 assert.equal(process.platform,'darwin','Actual simulator clone gate requires macOS');await mkdir(join(root,'artifacts'),{recursive:true});
 const directory=await mkdtemp(join(root,'artifacts/native-simulator-clone-'));await chmod(directory,0o700);
 const app='com.example.networklog.clone.i'+Date.now()+randomUUID().replaceAll('-','').slice(0,6);
 const report={directory,started_at:new Date().toISOString(),scope:'Actual simctl clone of run-created simulator using current SDK fixture; production local bind rejection and separately copied-bearer HTTP authorization',application_id:app,activation:false,operations:[],phases:[],bindings:[],checks:{},discovery:{device_filter:null,bundle_filter:null,foreign_mutations_refused:0},limitations:['This is actual simulator clone, not OS backup restoration or hardware attestation.','HTTP bearer intentionally continues to authorize the original source; a local bind conflict does not revoke copied credentials.','Synthetic complete events use the actual SDK fixture or explicit copied-bearer HTTP submission. No browser paint or discovery latency claim.']};
 let collector,watcher,original,clone,fixture,cleaning=false;const evidenceErrors=[];const ownedUDIDs=new Set(),ownedEnvironments=new Set();
 let serialWrite=Promise.resolve();
 const persist=()=>{const bytes=JSON.stringify(report,null,2)+'\n';serialWrite=serialWrite.catch(()=>{}).then(async()=>{const temp=join(directory,'result.json.tmp');await writeFile(temp,bytes,{mode:0o600});await rename(temp,join(directory,'result.json'));});return serialWrite;};
 const phase=async(name,data={})=>{report.phase=name;report.phases.push({name,at:new Date().toISOString(),...data});await persist();console.log(JSON.stringify({phase:name,directory,...data}));};
 async function tool(command,args,{timeout=15000,maxBuffer=32*1024*1024,env=process.env,input}={}){
  const record={command,args,started_at:new Date().toISOString(),state:'running'};report.operations.push(record);
  const out=await runCloneTool(command,args,{timeout,outputLimit:maxBuffer,env,input,checkpoint:persist,cleanup:cleaning,
   onEvidenceError:error=>{evidenceErrors.push({action:'tool evidence '+command,error:error.message});report.passed=false;console.error('Tool checkpoint failed: '+error.message);},
   onClosed:out=>{const created=trackCreatedSimulator(command,args,out.stdout,ownedUDIDs,ownedEnvironments);if(created)record.created_udid=created;record.state='closed';record.finished_at=new Date().toISOString();},
   onFailure:error=>{record.state='failed';record.error=error.message;record.finished_at=new Date().toISOString();}});
  return{stdout:out.stdout.toString('utf8'),stderr:out.stderr.toString('utf8')};
 }
 const sim=(args,options)=>tool('xcrun',['simctl',...args],options);
 async function snapshot(base){
  const files={};let bytes=0;async function walk(path){for(const name of await readdir(path)){const child=join(path,name),info=await lstat(child);assert(!info.isSymbolicLink(),'Canonical fixture state must not contain symlinks');if(info.isDirectory())await walk(child);else{assert(info.isFile(),'Canonical fixture state must be regular');assert(Object.keys(files).length<512,'Canonical fixture file bound exceeded');const content=await boundedFile(child,16*1024*1024);bytes+=content.length;assert(bytes<=64*1024*1024,'Canonical fixture byte bound exceeded');files[relative(base,child)]=sha(content);}}}await walk(base);return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
 }
 const appContainer=async udid=>(await sim(['get_app_container',udid,app,'data'])).stdout.trim();
 const canonical=async udid=>join(await appContainer(udid),'Library/Application Support/HTTPSequenceLogger');
 async function exportOwned(udid,label){const container=await appContainer(udid),path=join(directory,label+'.tar');await tool('tar',['-cf',path,'-C',container,'Library/Application Support/HTTPSequenceLogger']);await chmod(path,0o600);const bytes=await boundedFile(path,64*1024*1024);return{path,bytes:bytes.length,sha256:sha(bytes)};}
 async function waitFor(label,test,timeout=60000){const until=Date.now()+timeout;while(Date.now()<until){const value=await test();if(value)return value;await sleep(100);}throw new Error(label+' deadline exceeded');}
 async function bootOwned(udid){assert(ownedUDIDs.has(udid));await sim(['boot',udid]);await sim(['bootstatus',udid,'-b'],{timeout:120000});}
 try{
  await phase('validate-passed-fixture');fixture=await realpath(resolve(options.fixture));
  const suffix='/DerivedData/Build/Products/Debug-iphonesimulator/OwnedLifecycleFixture.app';assert(fixture.endsWith(suffix),'Fixture must have the owned lifecycle build layout');
  const fixtureRoot=fixture.slice(0,-suffix.length);assert(fixtureRoot.startsWith(join(root,'artifacts/native-installation-lifecycle-ios-')),'Fixture must be a private owned lifecycle artifact');
  const ownership=await lstat(fixtureRoot);assert(ownership.uid===process.getuid()&&(ownership.mode&0o077)===0,'Fixture artifact must be private and owned');
  const previous=JSON.parse(await boundedFile(join(fixtureRoot,'result.json'),256*1024));assert.equal(previous.passed,true,'Fixture artifact must have passed actual lifecycle checks');
  const source=await boundedFile(join(fixtureRoot,'ios-fixture/Sources/App.swift'),128*1024);assert(source.toString().includes('Bundle.main.bundleIdentifier!')&&source.toString().includes('DebugCapture.start()')&&source.toString().includes('await capture.close()'),'Fixture must use dynamic app ID and actual closed SDK capture');
  report.fixture={path:fixture,lifecycle_result:join(fixtureRoot,'result.json'),source_sha256:sha(source),dynamic_bundle_identifier:true};
  report.sdk_source_sha256=Object.fromEntries(await Promise.all((await readdir(join(root,'ios/Sources/NetworkLogTransfer'))).filter(name=>name.endsWith('.swift')).sort().map(async name=>[name,sha(await boundedFile(join(root,'ios/Sources/NetworkLogTransfer',name),1024*1024))])));assert.deepEqual(report.sdk_source_sha256,previous.sdk_source_sha256,'Fixture must match current SDK sources');
  const copied=join(directory,'OwnedCloneFixture.app');await cp(fixture,copied,{recursive:true,errorOnExist:true,force:false});const originalPlist=await boundedFile(join(fixture,'Info.plist'),128*1024);report.fixture.original_plist_sha256=sha(originalPlist);report.fixture.original_bundle_id=(await tool('plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(fixture,'Info.plist')])).stdout.trim();
  const beforeCopy=await snapshot(copied);await tool('plutil',['-replace','CFBundleIdentifier','-string',app,join(copied,'Info.plist')]);const afterCopy=await snapshot(copied);assert.deepEqual(Object.keys(afterCopy),Object.keys(beforeCopy));for(const name of Object.keys(beforeCopy))if(name!=='Info.plist')assert.equal(afterCopy[name],beforeCopy[name],'Only copied plist may change');assert.equal(sha(await boundedFile(join(fixture,'Info.plist'),128*1024)),sha(originalPlist));report.fixture.copied_files_sha256=afterCopy;report.fixture.original_files_sha256=beforeCopy;report.checks.fixture_copy_only_plist_changed=true;
  const runtimes=JSON.parse((await sim(['list','runtimes','--json'])).stdout).runtimes.filter(r=>r.isAvailable&&r.identifier.includes('.iOS-')).sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}));assert(runtimes.length);const types=JSON.parse((await sim(['list','devicetypes','--json'])).stdout).devicetypes.filter(t=>t.name.startsWith('iPhone'));assert(types.length);report.runtime=runtimes[0].identifier;report.device_type=types[0].identifier;
  await phase('create-owned-original');original=(await sim(['create','Owned NetworkLog clone original '+randomUUID(),types[0].identifier,runtimes[0].identifier])).stdout.trim();assert(/^[a-fA-F0-9-]{36}$/.test(original));ownedUDIDs.add(original);ownedEnvironments.add('simulator:'+original);report.original_udid=original;await persist();await bootOwned(original);await sim(['install',original,copied]);
  collector=await startCollector({directory:join(directory,'collector'),port:0,activate:false});report.collector_id=collector.store.config.collector_id;report.origin=collector.origin;
  const enroll=collector.enroll.bind(collector),bind=collector.store.bindLocal.bind(collector.store),status=collector.setAdapterStatus.bind(collector);
  const guard=metadata=>{try{assertOwnedMetadata(metadata,ownedEnvironments,app);}catch(error){report.discovery.foreign_mutations_refused++;throw error;}};
  collector.enroll=async(metadata,...args)=>{guard(metadata);return enroll(metadata,...args);};
  collector.store.bindLocal=async(token,metadata)=>{guard(metadata);const entry={environment_id:metadata.environment_id,app_id:metadata.app_id,installation_id:metadata.installation_id,started_at:new Date().toISOString(),state:'running'};report.bindings.push(entry);await persist();try{const result=await bind(token,metadata);Object.assign(entry,{state:'bound',source_id:result.source_id,finished_at:new Date().toISOString()});await persist();return result;}catch(error){Object.assign(entry,{state:'rejected',status:error.status,reason:error.message,finished_at:new Date().toISOString()});await persist();throw error;}};
  collector.setAdapterStatus=(name,value)=>{if(name.startsWith('ios-simulator:'))report.discovery[name]={state:value.state,reason:value.reason};return status(name,value);};
  watcher=await watchSimulators({collector});await phase('first-normal-discovery');const session='clone-original-'+randomUUID();await sim(['launch','--terminate-running-process',original,app],{env:{...process.env,SIMCTL_CHILD_NLOG_FIXTURE_STAGE:session}});
  let originalSource,originalLines;await waitFor('actual first SDK capture and local binding',async()=>{let marker;try{marker=JSON.parse(await boundedFile(join(await appContainer(original),'Documents','stage-'+session+'.json')));}catch(error){if(error.code==='ENOENT')return false;throw error;}assert(!marker.error,'SDK fixture failed: '+marker.error);const sources=(await collector.store.sources()).sources;assert(sources.every(s=>s.app_id===app&&ownedEnvironments.has(s.environment_id)),'Foreign source enrolled');originalSource=sources.find(s=>s.app_id===app&&s.installation_id===marker.installation_id);if(!originalSource)return false;originalLines=(await collector.store.page({source_id:originalSource.source_id,after:0,limit:50})).lines.map(JSON.parse).filter(e=>e.session_id===session);return originalLines.length===2&&originalSource.local_binding==='simulator:'+original;});
  assert.equal(report.bindings.filter(b=>b.environment_id==='simulator:'+original&&b.state==='bound').length,1,'First watcher must establish binding without restart');assert.equal(originalSource.environment_id,'simulator:'+original);report.original_source={source_id:originalSource.source_id,installation_id:originalSource.installation_id,environment_id:originalSource.environment_id,local_binding:originalSource.local_binding,event_ids:originalLines.map(e=>e.event_id)};report.checks.first_normal_reconciliation_local_binding=true;
  const originalRoot=await canonical(original),descriptor=JSON.parse(await boundedFile(join(originalRoot,'source.json')));assert.equal(descriptor.app_id,app);assert.equal(descriptor.installation_id,originalSource.installation_id);await assert.rejects(boundedFile(join(originalRoot,'pairing.json')),{code:'ENOENT'});
  await sim(['terminate',original,app]);await within('close original watcher',()=>watcher.close(),30000);watcher=null;report.original_state_sha256=await snapshot(originalRoot);report.export_before_clone=await exportOwned(original,'owned-before-clone');await phase('closed-exported-original',{original_udid:original});await sim(['shutdown',original]);
  await phase('actual-simctl-clone');assert(ownedUDIDs.has(original));clone=(await sim(['clone',original,'Owned NetworkLog clone copy '+randomUUID()],{timeout:120000})).stdout.trim();assert(/^[a-fA-F0-9-]{36}$/.test(clone)&&clone!==original);ownedUDIDs.add(clone);ownedEnvironments.add('simulator:'+clone);report.clone_udid=clone;await persist();await bootOwned(clone);
  const cloneRoot=await canonical(clone),cloneState=await snapshot(cloneRoot);assert.deepEqual(cloneState,report.original_state_sha256,'Actual clone must preserve canonical bytes and copied proposal');report.clone_state_before_discovery_sha256=cloneState;await assert.rejects(boundedFile(join(cloneRoot,'pairing.json')),{code:'ENOENT'});const cloneProposal=JSON.parse(await boundedFile(join(cloneRoot,'pairing-local.json')));assert.equal(cloneProposal.source_id,originalSource.source_id);report.checks.actual_clone_preserved_installation_and_credential=true;
  await phase('clone-local-binding-rejection',{clone_udid:clone});watcher=await watchSimulators({collector});const rejection=await waitFor('actual cloned environment bindLocal rejection',async()=>report.bindings.find(b=>b.environment_id==='simulator:'+clone&&b.state==='rejected'));assert.equal(rejection.status,409);assert.match(rejection.reason,/already bound to another device/);await within('close clone watcher',()=>watcher.close(),30000);watcher=null;
  report.clone_state_after_discovery_sha256=await snapshot(cloneRoot);assert.deepEqual(report.clone_state_after_discovery_sha256,cloneState);assert.deepEqual(await snapshot(originalRoot),report.original_state_sha256);const still=(await collector.store.sources()).sources;assert.equal(still.length,1);assert.equal(still[0].source_id,originalSource.source_id);assert.equal(still[0].environment_id,'simulator:'+original);assert.equal(still[0].local_binding,'simulator:'+original);report.clone_rejection={status:rejection.status,reason:rejection.reason};report.checks.clone_rejected_before_pairing_or_history_mutation=true;
  await phase('separate-copied-bearer-http-authority');async function push(events){const response=await fetch(collector.origin+'/api/v2/events',{method:'POST',headers:{Authorization:'Bearer '+cloneProposal.source_token,'Content-Type':'application/x-ndjson'},body:events.map(e=>JSON.stringify(e)+'\n').join(''),signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,'Copied bearer HTTP authorization unexpectedly rejected');const ack=await response.json();assert.equal(ack.source_id,originalSource.source_id);assert.equal(ack.collector_id,report.collector_id);return ack;}
  const replay=await push(originalLines);assert.equal(replay.accepted,0);assert.equal(replay.duplicates,2);const recording=randomUUID(),pushSession='clone-copied-bearer-'+randomUUID();const explicit=originalLines.map((line,i)=>({...line,event_id:recording+'/'+(i+1),recording_id:recording,session_id:pushSession,sequence:i+1,timestamp:new Date(Date.now()+i).toISOString(),monotonic_ns:String(i)}));const fresh=await push(explicit);assert.equal(fresh.accepted,2);assert.equal(fresh.duplicates,0);assert.deepEqual(new Set(fresh.acknowledged_event_ids),new Set(explicit.map(e=>e.event_id)));
  const finalSources=(await collector.store.sources()).sources;assert.equal(finalSources.length,1);assert.equal(finalSources[0].source_id,originalSource.source_id);assert.equal(finalSources[0].environment_id,'simulator:'+original);assert.equal(finalSources[0].local_binding,'simulator:'+original);const stored=(await collector.store.page({source_id:originalSource.source_id,after:0,limit:50})).lines.map(JSON.parse);assert.equal(stored.length,4);assert.deepEqual(new Set(stored.map(e=>e.event_id)),new Set([...originalLines,...explicit].map(e=>e.event_id)));assert.deepEqual(await snapshot(cloneRoot),cloneState);assert.deepEqual(await snapshot(originalRoot),report.original_state_sha256);
  report.http_copied_bearer={authority:'Original source bearer, independent of local simulator binding; no device attestation',replay:{accepted:replay.accepted,duplicates:replay.duplicates},fresh:{accepted:fresh.accepted,duplicates:fresh.duplicates,event_ids:explicit.map(e=>e.event_id)},source_id:originalSource.source_id};report.checks.copied_bearer_authorizes_original_source_only=true;report.checks.canonical_histories_and_proposals_unchanged=true;report.final_source_count=finalSources.length;report.final_event_cursor=collector.store.cursor;report.export_clone_final=await exportOwned(clone,'owned-clone-final');report.passed=true;await phase('checks-passed');
 }catch(error){report.passed=false;report.error=error.message;try{await phase('failed',{reason:error.message});}catch(persistenceError){report.evidence_error=persistenceError.message;console.error('Failed to checkpoint primary failure: '+persistenceError.message);}}
 finally{
  cleaning=true;const errors=evidenceErrors;const note=async(name,data)=>{try{await phase(name,data);}catch(error){errors.push({action:'checkpoint '+name,error:error.message});report.passed=false;console.error('Cleanup checkpoint failed: '+error.message);}};const clean=(label,action,timeout=30000)=>cleanupOwnedAction(label,action,phase,errors,timeout);
  const watcherClosed=await clean('close only owned watcher',async()=>await watcher?.close()),collectorClosed=await clean('close only owned collector',async()=>await collector?.close());const devices={};
  for(const udid of [...ownedUDIDs].reverse()){
   const entry=devices[udid]={};entry.shutdown=await clean('shutdown only created '+udid,async()=>{assert(ownedUDIDs.has(udid));const all=JSON.parse((await sim(['list','devices','--json'])).stdout).devices;const state=Object.values(all).flat().find(d=>d.udid===udid)?.state;if(state==='Booted')await sim(['shutdown',udid]);});entry.deleted=await clean('delete only created '+udid,async()=>{assert(ownedUDIDs.has(udid));await sim(['delete',udid],{timeout:60000});},70000);entry.absent=await clean('confirm created '+udid+' absent',async()=>{const all=JSON.parse((await sim(['list','devices','--json'])).stdout).devices;assert(!Object.values(all).flat().some(d=>d.udid===udid),'Owned simulator remains');});
  }
  report.cleanup={watcher_closed:watcherClosed,collector_closed:collectorClosed,owned_devices:devices,existing_devices_apps_pairings_untouched:true,errors};if(errors.length)report.passed=false;report.finished_at=new Date().toISOString();await note('complete',{passed:report.passed});console.log(JSON.stringify({passed:report.passed,evidence:join(directory,'result.json'),checks:report.checks,cleanup_errors:errors.length}));if(!report.passed)process.exitCode=1;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let options;try{options=parseArguments(process.argv.slice(2));}catch(error){console.error(error.message+'\n'+usage);process.exit(2);}if(options.help){console.log(usage);}else{await main(options);}
}
