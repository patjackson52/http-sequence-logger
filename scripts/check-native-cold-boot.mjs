#!/usr/bin/env node
// Installed Chrome + unfiltered adapter precede the first boot of a run-created AVD.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,copyFile,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {chromium,expect} from '@playwright/test';
import {adbPath,decodeAndroidControl,watchAndroid} from '../collector/android-live.mjs';
import {activeManifestPath,parsePrivateJSON} from '../collector/registry.mjs';
import {startCollector} from '../collector/server.mjs';
import {validateCapture} from '../shared/validate.mjs';
import {runOwnedProcess} from './lib/instrumentation-process.mjs';
import {boundedRead,delay,timestamp} from './lib/native-lifecycle-timeline.mjs';
import {assertSafeAvdDeletion,cleanupRestoreAction,closeOwnedEmulator,persistClosedCommand,portAvailable} from './check-native-os-restore.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const usage='Usage: node scripts/check-native-cold-boot.mjs --owned-avd --fixture-apk /absolute/passed-native-os-restore-artifact/owned-fixture.apk\n       node scripts/check-native-cold-boot.mjs --help\nCreates and deletes only its private Android35 default arm64 AVD. Existing device/AVD/port options are refused.\n';
export function parseArguments(argv){
 const options=new Map();for(let i=0;i<argv.length;i++){
  const key=argv[i];assert(['--owned-avd','--fixture-apk','--help'].includes(key),'Unknown argument: '+key);assert(!options.has(key),'Duplicate option: '+key);
  if(key!=='--fixture-apk'){options.set(key,true);continue;}const value=argv[++i];assert(value&&value.startsWith('/')&&!value.startsWith('--'),'--fixture-apk requires an explicit absolute passed artifact path');options.set(key,value);
 }
 if(options.has('--help')){assert.equal(argv.length,1,'--help must be used alone');return {help:true};}
 assert(options.has('--owned-avd'),'--owned-avd is required');assert(options.has('--fixture-apk'),'An explicit passed --fixture-apk is required');return {help:false,apk:options.get('--fixture-apk')};
}
export function assertFixtureProvenance(previous,sources,aar,api){
 assert.equal(previous.passed,true,'Fixture artifact has not passed its actual OS restore gate');
 assert.match(previous.application_id,/^dev\.networklog\.restore\.p[a-z0-9]+$/);
 for(const key of ['actual_os_business_state_restored','sdk_identity_journals_pairing_cursor_excluded','fresh_sdk_identity_source_after_restore','old_collector_history_retained'])assert.equal(previous.checks?.[key],true,'Missing passed fixture proof: '+key);
 assert.equal(previous.cleanup?.owned_avd_deleted,true,'Passed fixture AVD cleanup is unproven');
 assert.deepEqual(previous.sdk_source_sha256,sources,'Current SDK sources differ from the passed fixture; rerun the restore fixture with current SDK');
 assert.equal(previous.sdk_aar_sha256,aar,'Current SDK AAR differs from the passed fixture');assert.equal(previous.api_jar_sha256,api,'Current API artifact differs from the passed fixture');
}
export function assertOwnedMetadata(metadata,app,environment){
 if(metadata?.app_id!==app||metadata?.environment_id!==environment)throw Object.assign(new Error('Cold-boot fixture guard refused foreign enrollment/binding before mutation'),{status:403});
}
export function guardCollector(collector,app,environment,observations){
 const enroll=collector.enroll.bind(collector),bind=collector.store.bindLocal.bind(collector.store);
 const check=metadata=>{try{assertOwnedMetadata(metadata,app,environment);}catch(error){observations.foreign_refused++;throw error;}};
 collector.enroll=async(metadata,...args)=>{check(metadata);return enroll(metadata,...args);};
 collector.store.bindLocal=async(token,metadata)=>{check(metadata);return bind(token,metadata);};
}
const reverseInventory=text=>text.trim().split(/\r?\n/).filter(Boolean).sort();
export async function restoreOwnedReverse(device,baseline,route){
 const current=reverseInventory(await device(['reverse','--list']));
 if(route){
  const local=line=>line.trim().split(/\s+/).slice(-2)[0];
  assert(!baseline.some(line=>local(line)===route),'Owned route overlaps original reverse inventory');
  const matches=current.filter(line=>local(line)===route);
  assert(matches.length<=1&&matches.every(line=>line.trim().split(/\s+/).slice(-2).join(' ')===route+' '+route),'Refusing removal of a changed or foreign reverse route');
  if(matches.length)await device(['reverse','--remove',route]);
 }
 assert.deepEqual(reverseInventory(await device(['reverse','--list'])),baseline,'Original reverse inventory was not restored');
}
async function sourceHashes(){
 const entries=[];async function visit(directory){for(const item of await readdir(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())await visit(path);else if(item.isFile()&&item.name.endsWith('.kt'))entries.push([path.slice(root.length+1),sha(await boundedRead(path,1024*1024))]);}}
 for(const module of ['logger','logger-api'])await visit(join(root,'android',module,'src/main'));return Object.fromEntries(entries.sort(([a],[b])=>a.localeCompare(b)));
}
async function activeSnapshot(){try{const bytes=await boundedRead(activeManifestPath());return {sha256:sha(bytes),pid:parsePrivateJSON(bytes).pid??null};}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function databaseSnapshot(path){const db=new Database(path,{readonly:true});try{return {sources:db.prepare('select count(*) n from sources').get().n,events:db.prepare('select count(*) n from events').get().n,event_ids:db.prepare('select event_id from events order by position').all().map(row=>row.event_id)};}finally{db.close();}}
export async function rendered(page,selector,deadline=5000){
 let timer;try{return await Promise.race([(async()=>{
  await page.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
  return page.locator(selector).evaluate(element=>{const rect=element.getBoundingClientRect();return {text:element.textContent,visible_document:document.visibilityState==='visible',width:rect.width,height:rect.height,two_animation_frame_opportunities:true};});
 })(),new Promise((_,fail)=>{timer=setTimeout(()=>fail(new Error('Chrome DOM/two-frame observation deadline exceeded')),deadline);})]);}finally{clearTimeout(timer);}
}
async function main(options){
 await mkdir(join(root,'artifacts'),{recursive:true});const directory=await mkdtemp(join(root,'artifacts/native-cold-boot-'));await chmod(directory,0o700);
 const adb=adbPath(),sdk=dirname(dirname(adb)),profile=join(directory,'android-profile'),avdHome=join(directory,'avds'),avdData=join(directory,'avd-data');
 const environment={...process.env,JAVA_HOME:process.env.JAVA_HOME||'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',ANDROID_HOME:sdk,ANDROID_USER_HOME:profile,ANDROID_EMULATOR_HOME:profile,ANDROID_AVD_HOME:avdHome};
 const owner={name:'networklog_coldboot_'+randomUUID().replaceAll('-',''),port:null,pid:null,closed:false};
 const report={directory,started_at:new Date().toISOString(),owner,activation:false,phases:[],checks:{},discovery:{device_filter:null,package_filter:null,foreign_refused:0},limitations:['First boot of a newly created Android35 default arm64 AVD; no existing OS reset or hardware cold-boot claim.','Passed fixture uses actual current DebugTransfer.open and two complete SDK session records with no HTTP requests; no request SVG claim.','Device-before-app evidence is ephemeral adapter status plus actual Chrome DOM/layout and two animation-frame opportunities, not a persisted SQLite device row or hardware paint timestamp.','All durations use host monotonic observation times; no native-to-host clock subtraction.']};
 let child,closed,emergencyTimer,context,page,collector,watcher,installed=false,avdCreated=false,verified=false,serial,app,activeBefore,dbPath;
 async function checkpoint(name,data={}){report.phases.push({name,...timestamp(),...data});await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({phase:name,directory,...data}));}
 async function run(command,args,{timeout=15000,input,encoding='utf8',onSuccess,onDiagnosticError,...config}={}){
  let result;try{result=await runOwnedProcess(command,args,{timeout,input,env:environment,outputLimit:8*1024*1024,...config});}catch(error){report.failed_command={command,args,timeout_ms:timeout,input_omitted:input!==undefined};throw error;}
  const log=join(directory,'command-'+randomUUID()+'.log');await persistClosedCommand(result,onSuccess,async()=>{try{await writeFile(log,Buffer.concat([result.stdout,result.stderr]),{mode:0o600});}catch(error){if(onDiagnosticError)onDiagnosticError(error);else throw error;}});
  if(result.code!==0)report.failed_command={command,args,timeout_ms:timeout,input_omitted:input!==undefined};assert.equal(result.code,0,`Owned command failed (${result.code}); diagnostic ${log}`);return encoding==='buffer'?result.stdout:result.stdout.toString('utf8');
 }
 const rawDevice=(args,config={})=>run(adb,['-s',serial,...args],config);
 const alive=()=>assert(child&&child.exitCode===null&&child.signalCode===null,'Owned emulator is no longer alive');
 const device=(args,config={})=>{alive();assert(verified,'Refusing mutation/read before exact private AVD verification');assert.equal(serial,'emulator-'+owner.port);return rawDevice(args,config);};
 async function control(path){assert(/^[a-zA-Z0-9._/-]+$/.test(path));return decodeAndroidControl(await device(['exec-out','run-as',app,'--user','0','sh','-c',`test ! -L no_backup && test ! -L ${path} && if [ ! -e ${path} ];then printf N;elif [ ! -f ${path} ];then printf U;else printf F;head -c 16385 ${path};fi`],{encoding:'buffer'}));}
 try{
  activeBefore=await activeSnapshot();report.active_manifest={before:activeBefore};report.harness_sha256=sha(await boundedRead(fileURLToPath(import.meta.url),1024*1024));
  const apk=await realpath(options.apk);assert.equal(apk,options.apk,'Fixture symlink paths are refused');assert.equal(basename(apk),'owned-fixture.apk');const previousDirectory=dirname(apk);assert.match(basename(previousDirectory),/^native-os-restore-[a-zA-Z0-9]+$/);
  const info=await lstat(previousDirectory);assert(info.isDirectory()&&!(info.mode&0o077)&&info.uid===process.getuid(),'Fixture directory is not private and owned');const apkInfo=await lstat(apk);assert(apkInfo.isFile()&&!apkInfo.isSymbolicLink(),'Fixture APK is not a regular file');
  const previous=parsePrivateJSON(await boundedRead(join(previousDirectory,'result.json'),1024*1024)),sources=await sourceHashes(),aar=sha(await readFile(join(root,'android/logger/build/outputs/aar/logger-debug.aar'))),api=sha(await readFile(join(root,'android/logger-api/build/libs/logger-api.jar')));assertFixtureProvenance(previous,sources,aar,api);app=previous.application_id;report.application_id=app;
  const binary=await boundedRead(apk,64*1024*1024);const buildOutput=join(previousDirectory,'android-fixture/build/outputs/apk/debug');const candidates=(await readdir(buildOutput)).filter(name=>name.endsWith('.apk'));assert.equal(candidates.length,1);assert.equal(sha(await boundedRead(join(buildOutput,candidates[0]),64*1024*1024)),sha(binary),'Passed fixture copy differs from its actual Gradle output');
  const copied=join(directory,'fixture.apk');await copyFile(apk,copied);assert.equal(sha(await boundedRead(copied,64*1024*1024)),sha(binary));report.fixture={passed_report:join(previousDirectory,'result.json'),apk_sha256:sha(binary),sdk_source_sha256:sources,sdk_aar_sha256:aar,api_jar_sha256:api};
  const badging=await run(join(sdk,'build-tools/35.0.0/aapt'),['dump','badging',copied]);assert(badging.startsWith(`package: name='${app}' `),'APK package differs from passed ownership metadata');
  report.system_image='system-images;android-35;default;arm64-v8a';report.system_image_properties_sha256=sha(await boundedRead(join(sdk,'system-images/android-35/default/arm64-v8a/source.properties')));
  report.devices_before=await run(adb,['devices']);for(let port=5582;port>=5554;port-=2){if(report.devices_before.includes('emulator-'+port))continue;if(await portAvailable(port)&&await portAvailable(port+1)){owner.port=port;break;}}assert(owner.port,'No free supported private emulator port pair');serial='emulator-'+owner.port;report.device=serial;const targetEnvironment='adb:'+serial+':user:0';report.environment_id=targetEnvironment;
  await mkdir(profile,{recursive:true,mode:0o700});await mkdir(avdHome,{recursive:true,mode:0o700});await run(join(sdk,'cmdline-tools/latest/bin/avdmanager'),['create','avd','-n',owner.name,'-k',report.system_image,'-p',avdData,'-d','pixel_5'],{input:'no\n',timeout:60000,onSuccess:()=>{avdCreated=true;}});await checkpoint('private-avd-created');
  await run(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'build','--config',join(root,'viewer/vite.config.mjs')],{timeout:60000});
  report.viewer_source_sha256=Object.fromEntries(await Promise.all(['App.jsx','LiveConnection.jsx','collector-client.mjs'].map(async name=>[name,sha(await boundedRead(join(root,'viewer/src',name),1024*1024))])));report.android_adapter_sha256=sha(await boundedRead(join(root,'collector/android-live.mjs'),1024*1024));
  collector=await startCollector({directory:join(directory,'collector'),port:0,activate:false});dbPath=collector.store.path;report.collector={origin:collector.origin,collector_id:collector.store.config.collector_id,started:timestamp()};guardCollector(collector,app,targetEnvironment,report.discovery);
  const status=collector.setAdapterStatus.bind(collector);collector.setAdapterStatus=(name,value)=>{if(name==='android'&&value.devices?.some(d=>d.serial===serial&&d.state==='device')&&!report.device_status_observed)report.device_status_observed={...timestamp(),name,devices:value.devices};status(name,value);};
  const register=collector.store.register.bind(collector.store);collector.store.register=async(token,metadata)=>{const result=await register(token,metadata);if(metadata.app_id===app&&!report.source_registered)report.source_registered={...timestamp(),source_id:result.source_id};return result;};
  context=await chromium.launchPersistentContext(join(directory,'chrome-profile'),{channel:'chrome',headless:true,timeout:30000,viewport:{width:1440,height:1000}});report.chrome={version:context.browser().version(),profile:join(directory,'chrome-profile'),headless:true};context.on('close',()=>{report.chrome.closed_observed=true;});page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));report.chrome.page_errors=pageErrors;
  await page.goto(collector.origin+'/',{timeout:30000});await expect(page.locator('.live-actions strong')).toHaveText('● Live · 0 events');report.chrome.live_before_boot=timestamp();watcher=await watchAndroid({collector,adb});report.watcher_started_before_boot=timestamp();await checkpoint('collector-chrome-and-unfiltered-watcher-ready-before-os');
  const out=await open(join(directory,'emulator.stdout.log'),'wx',0o600),err=await open(join(directory,'emulator.stderr.log'),'wx',0o600);report.os_boot_started=timestamp();
  try{child=spawn(join(sdk,'emulator/emulator'),['-avd',owner.name,'-port',String(owner.port),'-adb-path',adb,'-no-window','-no-snapshot','-no-audio','-no-boot-anim','-camera-back','none','-camera-front','none','-gpu','swiftshader_indirect','-cores','2','-memory','2048'],{env:environment,stdio:['ignore',out.fd,err.fd]});child.once('error',error=>{report.emulator_spawn_error=error.message;});closed=new Promise(ok=>child.once('close',(code,signal)=>{owner.closed=true;ok({code,signal});}));owner.pid=child.pid??null;}finally{await out.close();await err.close();}
  emergencyTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');},8*60*1000);emergencyTimer.unref();await checkpoint('first-owned-os-boot-started',{pid:owner.pid,serial});
  const bootDeadline=performance.now()+120000;while(performance.now()<bootDeadline){alive();let state;try{state=await rawDevice(['get-state'],{timeout:3000});}catch{await delay(500);continue;}if(state.trim()==='device'){assert.equal((await rawDevice(['emu','avd','name'])).split(/\r?\n/)[0].trim(),owner.name,'Emulator is not the run-created private AVD');verified=true;if((await device(['shell','getprop','sys.boot_completed'])).trim()==='1')break;}await delay(500);}assert(verified);assert.equal((await device(['shell','getprop','sys.boot_completed'])).trim(),'1');report.os_boot_completed=timestamp();
  const ownedDeviceCell='.live-panel .device-status[aria-live="polite"] small:has-text("'+serial+' (device)")';await expect(page.locator(ownedDeviceCell)).toHaveCount(1,{timeout:30000});await expect(page.locator(ownedDeviceCell)).toBeVisible();assert(report.device_status_observed,'Production adapter did not report exact authorized owned device');assert.equal(await page.getByText(app,{exact:true}).count(),0);
  report.pre_app_database=databaseSnapshot(dbPath);assert.equal(report.pre_app_database.sources,0);assert.equal(report.pre_app_database.events,0);const deviceRender=await rendered(page,ownedDeviceCell);report.device_dom={...timestamp(),...deviceRender};assert(report.device_dom.visible_document&&report.device_dom.width>0&&report.device_dom.height>0);await page.screenshot({path:join(directory,'device-before-app.png'),fullPage:true});report.checks.chrome_device_before_app_sdk_logging=true;await checkpoint('actual-device-dom-before-app');
  await device(['install',copied],{timeout:60000,onSuccess:()=>{installed=true;}});const route='tcp:'+new URL(collector.origin).port;report.reverse_inventory_before=reverseInventory(await device(['reverse','--list']));await device(['reverse','--no-rebind',route,route],{onSuccess:()=>{report.owned_reverse_route=route;}});const sdkRoot='no_backup/HTTPSequenceLogger';assert.equal(await control(sdkRoot+'/source.json'),null);const ticket=await collector.store.ticket({principal:'owned-cold-boot',scope:{app_id:app,environment_id:targetEnvironment},max_sources:1});const pairing=Buffer.from(JSON.stringify({version:2,endpoint:collector.origin,collector_id:collector.store.config.collector_id,enrollment_token:ticket.enrollment_token,environment_id:targetEnvironment,environment_name:'Owned cold boot '+serial}));
  await device(['shell','-T','run-as',app,'--user','0','sh','-c',"'umask 077; mkdir -p no_backup/HTTPSequenceLogger && test ! -L no_backup/HTTPSequenceLogger && cat > no_backup/HTTPSequenceLogger/pairing.json && sync'"],{input:pairing});assert.equal(await control(sdkRoot+'/source.json'),null);report.checks.private_manual_selection_before_descriptor=true;
  const session='cold-boot-'+randomUUID();report.session_id=session;report.sdk_launch_started=timestamp();await device(['shell','am','start','-S','-n',app+'/dev.networklog.restore.RestoreActivity','--es','stage',session,'--es','mode','initial','--es','sentinel','cold-boot-owned-'+randomUUID()]);
  let marker,source,lines;const stageDeadline=performance.now()+60000;while(performance.now()<stageDeadline){const bytes=await control('files/stage-'+session+'.json');if(bytes){marker=parsePrivateJSON(bytes);assert(!marker.error,'Passed SDK fixture failed: '+marker.error);assert.equal(marker.uploaded,true);source=(await collector.store.sources()).sources.find(s=>s.app_id===app&&s.environment_id===targetEnvironment&&s.installation_id===marker.installation_id);if(source){lines=(await collector.store.page({source_id:source.source_id,after:0,limit:20})).lines;if(lines.length===2)break;}}await delay(100);}assert(source&&lines?.length===2,'Real SDK session was not durably collected');const validation=validateCapture(lines.join('\n')+'\n');assert.equal(validation.valid,true,JSON.stringify(validation.errors));assert.deepEqual(validation.events.map(e=>e.event_type),['session.started','session.ended']);assert(validation.events.every(e=>e.schema_version==='1.2'&&e.session_id===session));report.source_id=source.source_id;report.installation_id=marker.installation_id;report.event_ids=validation.events.map(e=>e.event_id);report.session_name=validation.events[0].data.name;
  await expect(page.locator('.source-navigation').getByText(app,{exact:true})).toBeVisible();await expect(page.locator(`.source-navigation summary[title="${targetEnvironment}"]`)).toBeVisible();await expect(page.locator('.source-navigation .session-row')).toHaveCount(1);await expect(page.locator('.live-actions strong')).toHaveText('● Live · 2 events');
  const responsePromise=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/v2/events'&&url.searchParams.get('source_id')===source.source_id&&url.searchParams.get('session_id')===session;});await page.locator('.source-navigation details details').getByRole('button').click();const browserEvents=await(await responsePromise).json();assert.deepEqual(browserEvents.lines.map(line=>JSON.parse(line).event_id),report.event_ids);
  await expect(page.locator('.session-title h1')).toHaveText(report.session_name);const sessionRender=await rendered(page,'.session-title h1');report.session_dom={...timestamp(),...sessionRender};assert(report.session_dom.visible_document&&report.session_dom.width>0&&report.session_dom.height>0);await page.screenshot({path:join(directory,'app-session.png'),fullPage:true});assert.deepEqual(pageErrors,[]);report.checks.actual_chrome_app_environment_session_rendered=true;report.checks.browser_selected_exact_source_and_session=true;report.checks.current_schema_durable_sdk_events=true;report.browser_response_event_ids=browserEvents.lines.map(line=>JSON.parse(line).event_id);
  report.timings={scope:'Host monotonic observation upper bounds and actual DOM/layout with two frame opportunities; no native SDK latency or hardware paint claim',boot_to_device_dom_ms:report.device_dom.monotonic_ms-report.os_boot_started.monotonic_ms,launch_to_registry_ms:report.source_registered.monotonic_ms-report.sdk_launch_started.monotonic_ms,launch_to_session_dom_ms:report.session_dom.monotonic_ms-report.sdk_launch_started.monotonic_ms};report.passed=true;await checkpoint('checks-passed',report.timings);
 }catch(error){report.passed=false;report.error=error.message;try{await checkpoint('failed',{reason:error.message});}catch(failure){report.evidence_error=failure.message;}}
 finally{
  clearTimeout(emergencyTimer);const errors=[];const clean=(label,action,deadline=15000)=>cleanupRestoreAction(label,action,checkpoint,errors,deadline);report.cleanup={};
  report.cleanup.watcher_closed=await clean('close only owned watcher',async()=>await watcher?.close());
  report.cleanup.reverse_inventory_restored=report.reverse_inventory_before?await clean('restore only run-added reverse route',async()=>{assert(report.cleanup.watcher_closed,'Watcher must close before reverse cleanup');await restoreOwnedReverse(device,report.reverse_inventory_before,report.owned_reverse_route);}):true;
  report.cleanup.chrome_closed=await clean('close only owned Chrome context',async()=>{if(context){await context.close();assert.equal(report.chrome.closed_observed,true);}});report.cleanup.collector_closed=await clean('close only owned collector',async()=>await collector?.close());
  if(report.passed&&report.cleanup.collector_closed)await clean('verify SQLite after collector close',async()=>{report.final_database=databaseSnapshot(dbPath);assert.deepEqual(report.final_database.event_ids,report.event_ids);assert.equal(report.final_database.sources,1);assert.equal(report.final_database.events,2);report.checks.sqlite_after_owner_close=true;});
  report.cleanup.owned_app_removed=installed&&verified&&child?.exitCode===null&&child?.signalCode===null?await clean('uninstall only owned fixture',async()=>assert((await device(['uninstall',app],{timeout:30000})).includes('Success'))):!installed;
  report.cleanup.emulator_closed=await clean('terminate only spawned emulator',async()=>{if(child)await closeOwnedEmulator(child,closed);},10000);
  owner.process_absent=report.cleanup.owned_process_absent=await clean('verify spawned PID absent',async()=>{if(owner.pid){const ps=await runOwnedProcess('/bin/ps',['-p',String(owner.pid),'-o','pid='],{timeout:5000});assert.equal(ps.code,1);}});
  owner.ports_absent=report.cleanup.owned_ports_absent=await clean('verify owned ports absent',async()=>{if(owner.port){assert(await portAvailable(owner.port));assert(await portAvailable(owner.port+1));}});
  report.cleanup.owned_avd_deleted=await clean('delete only run-created private AVD',async()=>{assertSafeAvdDeletion(owner);const entries=await readdir(avdHome).catch(error=>{if(error.code==='ENOENT')return [];throw error;});if(avdCreated||entries.includes(owner.name+'.ini'))await run(join(sdk,'cmdline-tools/latest/bin/avdmanager'),['delete','avd','-n',owner.name],{timeout:30000,onDiagnosticError:error=>errors.push({action:'deletion diagnostic',error:error.message})});await rm(avdData,{recursive:true,force:true});assert(!(await readdir(avdHome).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).includes(owner.name+'.ini'));},40000);
  report.cleanup.existing_device_inventory_preserved=await clean('verify original device inventory',async()=>{let after;const deadline=performance.now()+5000;do{after=await run(adb,['devices']);if(after===report.devices_before)return;await delay(100);}while(performance.now()<deadline);assert.equal(after,report.devices_before);});
  report.cleanup.active_manifest_unchanged=await clean('verify active manifest unchanged',async()=>{report.active_manifest??={before:activeBefore};report.active_manifest.after=await activeSnapshot();assert.deepEqual(report.active_manifest.after,activeBefore);});report.cleanup.errors=errors;if(errors.length)report.passed=false;report.finished_at=new Date().toISOString();await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:report.passed,evidence:join(directory,'result.json'),checks:report.checks,timings:report.timings,cleanup:report.cleanup,error:report.error}));if(!report.passed)process.exitCode=1;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){let options;try{options=parseArguments(process.argv.slice(2));}catch(error){console.error(error.message+'\n'+usage);process.exitCode=2;}if(options?.help)console.log(usage);else if(options)await main(options);}
