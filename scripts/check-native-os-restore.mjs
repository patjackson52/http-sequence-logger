#!/usr/bin/env node
// Actual Android Backup Manager restore, exclusively on an AVD created by this invocation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,copyFile,mkdir,mkdtemp,open,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {adbPath,decodeAndroidControl} from '../collector/android-live.mjs';
import {activeManifestPath,parsePrivateJSON} from '../collector/registry.mjs';
import {startCollector} from '../collector/server.mjs';
import {runOwnedProcess} from './lib/instrumentation-process.mjs';
import {boundedRead,delay,timestamp} from './lib/native-lifecycle-timeline.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const usage='Usage: node scripts/check-native-os-restore.mjs --owned-avd [--system-image default|aosp_atd]\n       node scripts/check-native-os-restore.mjs --help\nCreates and deletes a private Android35 arm64 AVD. No existing device, AVD or port is accepted.\n';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function parseArguments(argv){
 const options=new Map();for(let i=0;i<argv.length;i++){
  const key=argv[i];assert(['--owned-avd','--system-image','--help'].includes(key),'Unknown argument: '+key);assert(!options.has(key),'Duplicate option: '+key);
  if(key!=='--system-image'){options.set(key,true);continue;}
  const value=argv[++i];assert(['default','aosp_atd'].includes(value),'Select an installed Android35 default or aosp_atd image');options.set(key,value);
 }
 if(options.has('--help')){assert.equal(argv.length,1,'--help must be used alone');return {help:true};}
 assert(options.has('--owned-avd'),'--owned-avd is required; existing installations are never accepted');
 return {help:false,image:options.get('--system-image')??'default'};
}
export function assertOwnedInstance(owner,serial,avdName){
 assert(owner&&Number.isInteger(owner.port)&&owner.port>=5554&&owner.port<=5584&&owner.port%2===0,'Invalid owned emulator port');
 assert.equal(serial,'emulator-'+owner.port,'Device target is not the created emulator');
 assert.match(owner.name,/^networklog_restore_[a-f0-9]{32}$/);
 assert.equal(avdName,owner.name,'Emulator identity differs from the created private AVD');
}
export function assertBackupSucceeded(text,app){
 assert.match(app,/^dev\.networklog\.restore\.p[a-z0-9]+$/);
 assert(text.split(/\r?\n/).some(line=>line.trim()===`Package ${app} with result: Success`),'Backup Manager did not report exact owned-package success');
 assert(text.split(/\r?\n/).some(line=>line.trim()==='Backup finished with result: Success'),'Backup Manager overall backup did not succeed');
}
export function restoreSetToken(text){
 const tokens=[...text.matchAll(/^\s*([a-fA-F0-9]+)\s+:\s+.+$/gm)].map(match=>match[1]);
 assert.equal(tokens.length,1,'Expected exactly one restore set on the newly created local transport');return tokens[0];
}
export function assertRestoreSucceeded(text){
 assert(/^restoreFinished:\s*0\s*$/m.test(text),'Backup Manager restore did not finish successfully');
}
export function manualSelectionWriteArguments(app){
 assert.match(app,/^dev\.networklog\.restore\.p[a-z0-9]+$/);
 const command='umask 077; mkdir -p no_backup/HTTPSequenceLogger && test ! -L no_backup/HTTPSequenceLogger && cat > no_backup/HTTPSequenceLogger/pairing.json && sync';
 // shell-v2 propagates stdin EOF to cat. exec-out's raw protocol does not.
 return ['shell','-T','run-as',app,'--user','0','sh','-c',"'"+command+"'"];
}
export async function portAvailable(port){
 const server=createServer();try{await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok);});return true;}
 catch(error){if(error.code==='EADDRINUSE')return false;throw error;}
 finally{if(server.listening)await new Promise(ok=>server.close(ok));}
}
export async function closeOwnedEmulator(child,closed,grace=2000){
 if(child.exitCode!==null||child.signalCode!==null){await closed;return;}
 child.kill('SIGTERM');let timer;
 const settled=()=>Promise.race([closed.then(()=>true),new Promise(ok=>{timer=setTimeout(()=>ok(false),grace);})]).finally(()=>clearTimeout(timer));
 if(await settled())return;child.kill('SIGKILL');assert(await settled(),'Owned emulator did not close after SIGKILL');
}
export async function persistClosedCommand(result,onSuccess,persist){
 if(result.code===0)onSuccess?.(); // Closed command effects belong to us even if its diagnostic write fails.
 await persist();
}
export function assertSafeAvdDeletion(owner){
 if(owner.pid===null)return;
 assert(owner.closed===true,'Refusing deletion of an unclosed owned emulator image');
 assert(owner.process_absent===true&&owner.ports_absent===true,'Refusing image deletion while owned PID or console/ADB port absence is unproven');
}
export async function cleanupRestoreAction(label,action,note,errors,deadline=15000){
 const record=async(phase,data)=>{try{await note(phase,data);}catch(error){errors.push({action:'evidence '+label,error:error.message});}};
 await record('cleanup-start',{action:label});let timer;
 try{await Promise.race([Promise.resolve().then(action),new Promise((_,fail)=>{timer=setTimeout(()=>fail(new Error(label+' deadline exceeded; graceful release unproven')),deadline);})]);await record('cleanup-complete',{action:label});return true;}
 catch(error){errors.push({action:label,error:error.message});await record('cleanup-failed',{action:label,reason:error.message});return false;}
 finally{clearTimeout(timer);}
}
async function activeSnapshot(){try{const bytes=await boundedRead(activeManifestPath());return {sha256:sha(bytes),pid:parsePrivateJSON(bytes).pid??null};}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function sdkSourceHashes(){
 const entries=[];
 async function visit(directory){for(const item of await readdir(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())await visit(path);else if(item.isFile()&&item.name.endsWith('.kt'))entries.push([path.slice(root.length+1),sha(await boundedRead(path,1024*1024))]);}}
 for(const module of ['logger','logger-api'])await visit(join(root,'android',module,'src/main'));return Object.fromEntries(entries.sort(([a],[b])=>a.localeCompare(b)));
}

async function main(options){
 await mkdir(join(root,'artifacts'),{recursive:true});
 const directory=await mkdtemp(join(root,'artifacts/native-os-restore-'));await chmod(directory,0o700);
 const adb=adbPath(),sdk=dirname(dirname(adb));
 const owner={name:'networklog_restore_'+randomUUID().replaceAll('-',''),port:null,pid:null,closed:false};
 const app='dev.networklog.restore.p'+Date.now()+randomUUID().replaceAll('-','').slice(0,6),sentinel='owned-business-state-'+randomUUID();
 const project=join(directory,'android-fixture'),avdHome=join(directory,'avds'),avdData=join(directory,'avd-data'),profile=join(directory,'android-profile');
 const environment={...process.env,JAVA_HOME:process.env.JAVA_HOME||'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',ANDROID_HOME:sdk,ANDROID_AVD_HOME:avdHome,ANDROID_EMULATOR_HOME:profile,ANDROID_USER_HOME:profile};
 const report={directory,started_at:new Date().toISOString(),scope:'Actual same-device Android35 LocalTransport backupnow, pm clear and bmgr restore on a newly created private AVD; business sentinel restored, SDK no_backup state excluded',application_id:app,activation:false,owner,phases:[],checks:{},limitations:['Local unencrypted same-device OS restore only; no Google cloud, D2D, cross-device or physical-device claim.','Synthetic complete sessions use the real unchanged SDK and native HTTP uploader; no rendered UI or discovery latency claim.','Private manual collector selection is written before every SDK descriptor publication; no existing application, emulator or backup setting is changed.']};
 let collector,child,closed,emergencyTimer,installed=false,avdCreated=false,verified=false,serial,activeBefore;
 async function checkpoint(name,data={}){report.phases.push({name,...timestamp(),...data});await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({phase:name,directory,...data}));}
 async function run(command,args,{timeout=15000,input,encoding='utf8',onSuccess,onDiagnosticError,...config}={}){
  let result;try{result=await runOwnedProcess(command,args,{timeout,input,env:environment,outputLimit:8*1024*1024,...config});}
  catch(error){report.failed_command={command,args,timeout_ms:timeout,input_omitted:input!==undefined};try{await writeFile(join(directory,'failed-command-output.log'),Buffer.concat([Buffer.isBuffer(error.stdout)?error.stdout:Buffer.alloc(0),Buffer.isBuffer(error.stderr)?error.stderr:Buffer.alloc(0)]),{mode:0o600});}catch(persistence){report.failed_command.diagnostic_error=persistence.message;}throw error;}
  const log=join(directory,'command-'+String(report.phases.length).padStart(3,'0')+'-'+randomUUID()+'.log');
  await persistClosedCommand(result,onSuccess,async()=>{try{await writeFile(log,Buffer.concat([result.stdout,result.stderr]),{mode:0o600});}catch(error){if(onDiagnosticError)onDiagnosticError(error);else throw error;}});
  assert.equal(result.code,0,`${command} failed (${result.code}, ${result.signal??'no signal'}); diagnostic ${log}`);
  return encoding==='buffer'?result.stdout:result.stdout.toString('utf8');
 }
 const rawDevice=(args,config={})=>run(adb,['-s',serial,...args],config);
 function alive(){assert(child&&child.exitCode===null&&child.signalCode===null,'Owned emulator process is no longer alive');}
 const device=(args,config={})=>{alive();assert(verified,'Refusing device operation before private AVD identity verification');assertOwnedInstance(owner,serial,owner.name);return rawDevice(args,config);};
 const sdkRoot='no_backup/HTTPSequenceLogger';
 async function readControl(path){assert(/^[a-zA-Z0-9._/-]+$/.test(path));return decodeAndroidControl(await device(['exec-out','run-as',app,'--user','0','sh','-c',`test ! -L no_backup && test ! -L ${path} && if [ ! -e ${path} ];then printf N;elif [ ! -f ${path} ];then printf U;else printf F;head -c 16385 ${path};fi`],{encoding:'buffer'}));}
 async function sdkAbsent(){return (await device(['exec-out','run-as',app,'--user','0','sh','-c',`test ! -L no_backup && if [ ! -e ${sdkRoot} ];then printf N;else printf F;fi`])).trim()==='N';}
 async function configure(){
  assert.equal(await readControl(sdkRoot+'/source.json'),null,'Private selection must precede actual SDK descriptor publication');
  const ticket=await collector.store.ticket({principal:'owned-os-restore',scope:{app_id:app,environment_id:`adb:${serial}:user:0`},max_sources:1});
  const bytes=Buffer.from(JSON.stringify({version:2,endpoint:collector.origin,collector_id:collector.store.config.collector_id,enrollment_token:ticket.enrollment_token,environment_id:`adb:${serial}:user:0`,environment_name:'Owned OS restore fixture'}));
  await device(manualSelectionWriteArguments(app),{input:bytes});
  assert.equal(await readControl(sdkRoot+'/source.json'),null);report.manual_selection_before_sdk=true;
 }
 async function inventory(){
  const lines=(await device(['exec-out','run-as',app,'--user','0','sh','-c',`find ${sdkRoot} -type f -exec sha256sum {} \\;`])).trim().split(/\r?\n/);assert(lines.length<=512,'Owned fixture inventory exceeds expected bound');
  const entries={};for(const line of lines){const m=line.match(/^([a-f0-9]{64})\s+([a-zA-Z0-9._/-]+)$/);assert(m,'Malformed owned inventory');assert(m[2].startsWith(sdkRoot+'/'));entries[m[2].slice(sdkRoot.length+1)]=m[1];}return entries;
 }
 async function stage(name){
  const session='os-restore-'+name+'-'+randomUUID();await device(['shell','am','start','-S','-n',app+'/dev.networklog.restore.RestoreActivity','--es','stage',session,'--es','mode',name,'--es','sentinel',sentinel]);
  let marker,source,events;const deadline=performance.now()+60000;
  while(performance.now()<deadline){const bytes=await readControl('files/stage-'+session+'.json');if(bytes){marker=JSON.parse(bytes);assert(!marker.error,'SDK fixture failed: '+marker.error);assert.equal(marker.sentinel,sentinel);assert.equal(marker.uploaded,true,'Native uploader did not observe durable ACK');source=(await collector.store.sources()).sources.find(s=>s.app_id===app&&s.installation_id===marker.installation_id);if(source){events=(await collector.store.page({source_id:source.source_id,after:0,limit:20})).lines.map(JSON.parse).filter(e=>e.session_id===session);if(events.length===2)break;}}await delay(100);}
  assert(source&&events?.length===2,'Actual native stage not collected');assert.deepEqual(events.map(e=>e.event_type),['session.started','session.ended']);
  const entry={name,session_id:session,installation_id:marker.installation_id,source_id:source.source_id,event_ids:events.map(e=>e.event_id),sdk_inventory_sha256:await inventory()};
  await writeFile(join(directory,'stage-'+name+'.json'),JSON.stringify(entry,null,2)+'\n',{mode:0o600,flag:'wx'});await checkpoint('sdk-'+name,entry);return entry;
 }
 try{
  activeBefore=await activeSnapshot();report.active_manifest={before:activeBefore};
  report.harness_sha256=sha(await boundedRead(fileURLToPath(import.meta.url),1024*1024));report.sdk_source_sha256=await sdkSourceHashes();
  await run(join(root,'android/gradlew'),['-p',join(root,'android'),':logger:bundleDebugAar',':logger-api:jar','--console=plain'],{timeout:180000});assert.deepEqual(await sdkSourceHashes(),report.sdk_source_sha256,'SDK sources changed during the fixture artifact build');
  report.sdk_aar_sha256=sha(await readFile(join(root,'android/logger/build/outputs/aar/logger-debug.aar')));
  report.api_jar_sha256=sha(await readFile(join(root,'android/logger-api/build/libs/logger-api.jar')));
  await checkpoint('current-sdk-artifacts-built',{sdk_aar_sha256:report.sdk_aar_sha256,api_jar_sha256:report.api_jar_sha256});
  const image='system-images;android-35;'+options.image+';arm64-v8a';report.system_image=image;report.system_image_properties_sha256=sha(await boundedRead(join(sdk,'system-images/android-35',options.image,'arm64-v8a/source.properties')));
  const initialDevices=await run(adb,['devices']);report.devices_before=initialDevices;
  for(let port=5582;port>=5554;port-=2){if(initialDevices.includes('emulator-'+port))continue;if(await portAvailable(port)&&await portAvailable(port+1)){owner.port=port;break;}}assert(owner.port,'No unused supported emulator port pair');serial='emulator-'+owner.port;report.device=serial;
  await mkdir(avdHome,{recursive:true,mode:0o700});await mkdir(profile,{recursive:true,mode:0o700});
  await run(join(sdk,'cmdline-tools/latest/bin/avdmanager'),['create','avd','-n',owner.name,'-k',image,'-p',avdData,'-d','pixel_5'],{input:'no\n',timeout:60000,onSuccess:()=>{avdCreated=true;}});
  await checkpoint('private-avd-created',{port:owner.port,private_avd_home:avdHome});
  const out=await open(join(directory,'emulator.stdout.log'),'wx',0o600),err=await open(join(directory,'emulator.stderr.log'),'wx',0o600);
  try{child=spawn(join(sdk,'emulator/emulator'),['-avd',owner.name,'-port',String(owner.port),'-adb-path',adb,'-no-window','-no-snapshot','-no-audio','-no-boot-anim','-camera-back','none','-camera-front','none','-gpu','swiftshader_indirect','-cores','2','-memory','2048'],{env:environment,stdio:['ignore',out.fd,err.fd]});
   child.once('error',error=>{report.emulator_spawn_error=error.message;});closed=new Promise(ok=>{child.once('close',(code,signal)=>{owner.closed=true;ok({code,signal});});});owner.pid=child.pid??null;
  }finally{await out.close();await err.close();}
  emergencyTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');},8*60*1000);emergencyTimer.unref();
  await checkpoint('owned-emulator-started',{pid:owner.pid});
  const bootDeadline=performance.now()+120000;
  while(performance.now()<bootDeadline){alive();let state;try{state=await rawDevice(['get-state'],{timeout:3000});}catch{await delay(500);continue;}if(state.trim()==='device'){const name=(await rawDevice(['emu','avd','name'],{timeout:3000})).split(/\r?\n/)[0].trim();assertOwnedInstance(owner,serial,name);verified=true;if((await device(['shell','getprop','sys.boot_completed'])).trim()==='1')break;}await delay(500);}
  assert(verified,'Owned AVD did not become available');assert.equal((await device(['shell','getprop','sys.boot_completed'])).trim(),'1','Owned AVD did not finish booting');await checkpoint('owned-emulator-booted');
  await mkdir(join(project,'src/main/kotlin/dev/networklog/restore'),{recursive:true});await mkdir(join(project,'src/main/res/xml'),{recursive:true});
  await writeFile(join(project,'settings.gradle.kts'),'pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name="OwnedOSRestoreFixture"\n');
  await writeFile(join(project,'build.gradle.kts'),`plugins { id("com.android.application") version "8.13.2";id("org.jetbrains.kotlin.android") version "2.2.20" }\nandroid { namespace="dev.networklog.restore";compileSdk=35;defaultConfig { applicationId="${app}";minSdk=26;targetSdk=35;versionCode=1;versionName="fixture" };compileOptions { sourceCompatibility=JavaVersion.VERSION_17;targetCompatibility=JavaVersion.VERSION_17 } }\nkotlin { jvmToolchain(17) }\ndependencies { implementation(files(${JSON.stringify(join(root,'android/logger/build/outputs/aar/logger-debug.aar'))}));implementation(files(${JSON.stringify(join(root,'android/logger-api/build/libs/logger-api.jar'))})) }\n`);
  await writeFile(join(project,'local.properties'),'sdk.dir='+sdk+'\n');
  await writeFile(join(project,'src/main/AndroidManifest.xml'),'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET"/><application android:allowBackup="true" android:label="Owned OS restore fixture" android:networkSecurityConfig="@xml/network_security"><activity android:name="dev.networklog.restore.RestoreActivity" android:exported="true"/></application></manifest>');
  await writeFile(join(project,'src/main/res/xml/network_security.xml'),'<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain>127.0.0.1</domain></domain-config></network-security-config>');
  await writeFile(join(project,'src/main/kotlin/dev/networklog/restore/RestoreActivity.kt'),`package dev.networklog.restore\nimport android.app.Activity\nimport android.os.Bundle\nimport java.io.File\nimport org.json.JSONObject\nimport dev.networklog.logger.DebugTransfer\nimport dev.networklog.logger.NetworkLog\nclass RestoreActivity:Activity() { override fun onCreate(state:Bundle?) { super.onCreate(state);val stage=intent.getStringExtra("stage")?:return;val mode=intent.getStringExtra("mode")!!;val sentinel=intent.getStringExtra("sentinel")!!;Thread { val marker=JSONObject();try { val business=File(filesDir,"business-sentinel.txt");if(mode=="initial")business.writeText(sentinel) else require(mode=="restored"&&business.isFile&&business.readText()==sentinel);DebugTransfer.open(applicationContext).use { sink -> val session=NetworkLog(sink,packageName,namespace=packageName+"/development").startSession("Owned OS restore "+mode,stage);session.end();sink.flush().get();marker.put("uploaded",sink.awaitUploaded(30000));marker.put("installation_id",JSONObject(File(DebugTransfer.directory(applicationContext),"source.json").readText()).getString("installation_id")) };marker.put("sentinel",business.readText()) }catch(error:Throwable){marker.put("error",error.toString())};File(filesDir,"stage-"+stage+".json").writeText(marker.toString()) }.start() } }\n`);
  await run(join(root,'android/gradlew'),['-p',project,'assembleDebug','--console=plain'],{timeout:180000});
  const apkDirectory=join(project,'build/outputs/apk/debug'),apk=join(directory,'owned-fixture.apk');await copyFile(join(apkDirectory,(await readdir(apkDirectory)).find(n=>n.endsWith('.apk'))),apk);
  collector=await startCollector({directory:join(directory,'collector'),port:0,activate:false});report.collector_id=collector.store.config.collector_id;report.origin=collector.origin;
  await device(['install',apk],{timeout:60000,onSuccess:()=>{installed=true;}});assert(await sdkAbsent());
  const route='tcp:'+new URL(collector.origin).port;await device(['reverse','--no-rebind',route,route]);
  await configure();const initial=await stage('initial');report.initial=initial;
  assert(initial.sdk_inventory_sha256['installation-id']);assert(initial.sdk_inventory_sha256['pairing.json']);assert(Object.keys(initial.sdk_inventory_sha256).some(name=>name.endsWith('/capture.ndjson')));assert(Object.keys(initial.sdk_inventory_sha256).some(name=>name.endsWith('/capture.ndjson.cursor.json')),'ACKed sender cursor fixture was not present');
  // stage() observes the fixture marker only after its SDK owners close. Keep the
  // package launched: Android's backup eligibility rejects force-stopped apps.
  const setup=(await device(['shell','settings','get','secure','user_setup_complete'])).trim();if(setup!=='1')await device(['shell','settings','put','secure','user_setup_complete','1']);
  await device(['shell','bmgr','enable','true']);
  const transport='com.android.localtransport/.LocalTransport',selected=await device(['shell','bmgr','transport',transport]);assert(selected.includes('Selected transport'),'LocalTransport unavailable on owned image');
  const transports=await device(['shell','bmgr','list','transports']);assert(transports.split(/\r?\n/).some(line=>line.trim()==='* '+transport),'Owned transport selection not confirmed');
  const encryption=(await device(['shell','settings','get','secure','backup_local_transport_parameters'])).trim();assert(!/is_encrypted\s*=\s*true/.test(encryption),'Encrypted backup cannot be used for this bmgr restore test');
  await checkpoint('owned-local-transport-selected',{transport,parameters:encryption});
  const backup=await device(['shell','bmgr','backupnow',app],{timeout:120000,outputLimit:65536});report.backup_manager_output=backup;assertBackupSucceeded(backup,app);
  const sets=await device(['shell','bmgr','list','sets'],{timeout:30000});const token=restoreSetToken(sets);report.restore_set_token=token;await checkpoint('os-backup-complete',{restore_set_token:token});
  assert.equal((await device(['shell','pm','clear','--user','0',app])).trim(),'Success');assert.equal(await readControl('files/business-sentinel.txt'),null);assert(await sdkAbsent());await checkpoint('actual-app-clear-confirmed',{business_state_absent:true,sdk_state_absent:true});
  const restoredOutput=await device(['shell','bmgr','restore',token,app],{timeout:120000,outputLimit:65536});report.restore_manager_output=restoredOutput;assertRestoreSucceeded(restoredOutput);
  const restoredSentinel=await readControl('files/business-sentinel.txt');assert.equal(restoredSentinel?.toString('utf8'),sentinel,'OS restore did not return the business sentinel');assert(await sdkAbsent(),'OS restore unexpectedly restored SDK no_backup identity/journals/pairing');
  report.checks.actual_os_business_state_restored=true;report.checks.sdk_identity_journals_pairing_cursor_excluded=true;report.restored_sentinel_sha256=sha(restoredSentinel);await checkpoint('os-restore-exclusions-verified',{business_sentinel_sha256:sha(restoredSentinel),sdk_directory_absent:true});
  await configure();const restored=await stage('restored');report.restored=restored;assert.notEqual(restored.installation_id,initial.installation_id);assert.notEqual(restored.source_id,initial.source_id);
  const old=(await collector.store.page({source_id:initial.source_id,after:0,limit:20})).lines.map(JSON.parse);assert.deepEqual(old.map(e=>e.event_id),initial.event_ids);assert.equal((await collector.store.sources()).sources.length,2);assert.equal(collector.store.cursor,4);
  report.checks.fresh_sdk_identity_source_after_restore=true;report.checks.old_collector_history_retained=true;report.passed=true;await checkpoint('checks-passed');
 }catch(error){report.passed=false;report.error=error.message;try{await checkpoint('failed',{reason:error.message});}catch(failure){report.evidence_error=failure.message;console.error(failure.message);}}
 finally{
  clearTimeout(emergencyTimer);const errors=[];const clean=(label,action,deadline=15000)=>cleanupRestoreAction(label,action,checkpoint,errors,deadline);report.cleanup={};
  report.cleanup.collector_closed=await clean('close owned collector',async()=>await collector?.close());
  report.cleanup.owned_app_removed=installed&&verified&&child?.exitCode===null&&child?.signalCode===null?await clean('uninstall only owned fixture',async()=>assert((await device(['uninstall',app],{timeout:30000})).includes('Success'))):!installed;
  report.cleanup.emulator_closed=await clean('terminate only spawned emulator',async()=>{if(child)await closeOwnedEmulator(child,closed);},10000);
  report.cleanup.owned_process_absent=await clean('verify spawned emulator PID absent',async()=>{if(owner.pid){const ps=await runOwnedProcess('/bin/ps',['-p',String(owner.pid),'-o','pid='],{timeout:5000});assert.equal(ps.code,1,'Owned emulator PID remains present');}});
  owner.process_absent=report.cleanup.owned_process_absent;
  report.cleanup.owned_ports_absent=await clean('verify owned console/ADB ports absent',async()=>{if(owner.port){assert(await portAvailable(owner.port),'Owned console port remains busy');assert(await portAvailable(owner.port+1),'Owned ADB port remains busy');}});
  owner.ports_absent=report.cleanup.owned_ports_absent;
  report.cleanup.owned_avd_deleted=await clean('delete only run-created private AVD',async()=>{assertSafeAvdDeletion(owner);const entries=await readdir(avdHome).catch(error=>{if(error.code==='ENOENT')return [];throw error;});if(avdCreated||entries.includes(owner.name+'.ini'))await run(join(sdk,'cmdline-tools/latest/bin/avdmanager'),['delete','avd','-n',owner.name],{timeout:30000,onDiagnosticError:error=>errors.push({action:'AVD deletion diagnostic',error:error.message})});await rm(avdData,{recursive:true,force:true});assert(!(await readdir(avdHome).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).includes(owner.name+'.ini'),'Private AVD registration remains');},40000);
  report.cleanup.device_inventory_preserved=await clean('verify original device inventory',async()=>{let after;const deadline=performance.now()+5000;do{after=await run(adb,['devices']);if(after===report.devices_before)return;await delay(100);}while(performance.now()<deadline);assert.equal(after,report.devices_before,'Existing device inventory changed');});
  report.cleanup.active_manifest_unchanged=await clean('verify active manifest unchanged',async()=>{const after=await activeSnapshot();report.active_manifest??={before:activeBefore};report.active_manifest.after=after;assert.deepEqual(after,activeBefore);});
  report.cleanup.errors=errors;report.cleanup.existing_devices_settings_untouched=true;if(errors.length)report.passed=false;report.finished_at=new Date().toISOString();
  await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:report.passed,evidence:join(directory,'result.json'),checks:report.checks,cleanup:report.cleanup,error:report.error}));if(!report.passed)process.exitCode=1;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let options;try{options=parseArguments(process.argv.slice(2));}catch(error){console.error(error.message+'\n'+usage);process.exitCode=2;}
 if(options?.help)console.log(usage);else if(options)await main(options);
}
