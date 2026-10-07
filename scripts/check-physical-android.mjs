#!/usr/bin/env node
// One freshly installed debug fixture on an explicitly selected physical Android device.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import Database from 'better-sqlite3';
import {chromium,expect} from '@playwright/test';
import {adbPath,decodeAndroidControl,watchAndroid} from '../collector/android-live.mjs';
import {activeManifestPath,parsePrivateJSON} from '../collector/registry.mjs';
import {startCollector} from '../collector/server.mjs';
import {validateCapture} from '../shared/validate.mjs';
import {runOwnedProcess} from './lib/instrumentation-process.mjs';
import {boundedRead,delay,timestamp} from './lib/native-lifecycle-timeline.mjs';
import {cleanupRestoreAction,persistClosedCommand} from './check-native-os-restore.mjs';
import {guardCollector,rendered,restoreOwnedReverse} from './check-native-cold-boot.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function assertPhysicalDevice(serial){assert(typeof serial==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serial)&&!serial.startsWith('emulator-'),'Select an explicit physical USB serial');}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function parseArguments(args){
 if(args.length===1&&args[0]==='--help')return {help:true};
 let device;const protectPids=[];
 for(let i=0;i<args.length;i++){
  const key=args[i],value=args[++i];assert(value&&!value.startsWith('--'),'Missing option value');
  if(key==='--device'){assert(!device,'Duplicate --device');assertPhysicalDevice(value);device=value;}
  else if(key==='--protect-pid'){assert(/^[1-9][0-9]*$/.test(value),'Protected PID must be positive');const pid=Number(value);assert(Number.isSafeInteger(pid)&&pid<=2147483647,'Invalid protected PID');assert(protectPids.length<8&&!protectPids.includes(pid),'Duplicate/excess protected PID');protectPids.push(pid);}
  else assert.fail('Unknown option: '+key);
 }
 assert(device,'An explicit --device SERIAL is required');return {help:false,device,protectPids};
}
export function assertOwnedPackage(app){assert.match(app,/^dev\.networklog\.physical\.p[a-f0-9]{32}$/,'Refusing a non-fixture package');}
export async function reconcileOwnedInstall(device,{app,installAttempted,sdkLaunchAttempted,captureExported,expectedAPKHash}){
 assertOwnedPackage(app);if(!installAttempted)return {attempted:false};
 const installed=(await device(['shell','pm','list','packages','--user','0',app])).trim().split(/\r?\n/).filter(Boolean);
 if(!installed.length)return {attempted:true,present_before:false,absence_verified:true};
 assert.deepEqual(installed,['package:'+app],'Exact owned package identity is unproven');
 assert(!sdkLaunchAttempted||captureExported,'Retaining owned fixture because canonical history export is unproven');
 assert.match(expectedAPKHash,/^[a-f0-9]{64}$/);
 const paths=(await device(['shell','pm','path','--user','0',app])).trim().split(/\r?\n/).filter(Boolean);assert.equal(paths.length,1,'Expected one owned base APK');
 assert.match(paths[0],/^package:\/data\/app\/[A-Za-z0-9._~+=/-]+\/base\.apk$/,'Unsafe owned APK path');const path=paths[0].slice('package:'.length);assert(!path.split('/').some(segment=>segment==='.'||segment==='..'),'Unsafe dot segment in owned APK path');
 const checksum=(await device(['shell','sha256sum',path])).trim();assert.equal(checksum.split(/\s+/)[0],expectedAPKHash,'Retaining package whose installed APK differs from the owned fixture');
 assert((await device(['shell','pm','uninstall','--user','0',app],{timeout:30000})).includes('Success'),'Owned fixture uninstall did not report success');
 assert.equal((await device(['shell','pm','list','packages','--user','0',app])).trim(),'','Owned fixture absence after uninstall is unproven');
 return {attempted:true,present_before:true,installed_apk_sha256:expectedAPKHash,absence_verified:true};
}
export function assertObservedFlow(events,session){
 assert(events.every(e=>e.schema_version==='1.3'&&e.session_id===session));
 assert.equal(events.filter(e=>e.event_type==='session.started').length,1);assert.equal(events.filter(e=>e.event_type==='session.ended').length,1);
 const ended=events.filter(e=>e.event_type==='http.ended');assert.equal(ended.length,1);assert.equal(ended[0].data.outcome,'success');assert.equal(ended[0].data.status_code,200);assert.equal(ended[0].data.end_reason,'body_eof');
 const handlers=events.filter(e=>e.event_type==='operation.started'&&e.data.invocation?.kind==='handler');assert.equal(handlers.length,1);assert.equal(handlers[0].data.invocation.dispatch,'synchronous');
 const end=events.find(e=>e.event_type==='operation.ended'&&e.context?.span_id===handlers[0].context.span_id);assert.equal(end?.data.outcome,'success');assert.equal(end?.data.completion,'returned');
 const request=events.find(e=>e.event_type==='http.request.started');assert.equal(request?.context.parent_span_id,handlers[0].context.span_id);
}
async function sources(){const entries=[];async function visit(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())await visit(path);else if(item.isFile()&&item.name.endsWith('.kt'))entries.push([path.slice(root.length+1),sha(await boundedRead(path,1024*1024))]);}}for(const name of ['logger','logger-api'])await visit(join(root,'android',name,'src/main'));return Object.fromEntries(entries.sort(([a],[b])=>a.localeCompare(b)));}
async function activeSnapshot(){try{return sha(await boundedRead(activeManifestPath()));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function sqlite(path){const db=new Database(path,{readonly:true});try{return {sources:db.prepare('select count(*) n from sources').get().n,event_ids:db.prepare('select event_id from events order by position').all().map(r=>r.event_id)};}finally{db.close();}}

async function main(options){
 await mkdir(join(root,'artifacts'),{recursive:true});const directory=await mkdtemp(join(root,'artifacts/physical-android-'));await chmod(directory,0o700);
 const app='dev.networklog.physical.p'+randomUUID().replaceAll('-',''),serial=options.device,environmentID='adb:'+serial+':user:0';assertOwnedPackage(app);assertPhysicalDevice(serial);
 const adb=adbPath(),sdk=dirname(dirname(adb)),project=join(directory,'fixture'),env={...process.env,JAVA_HOME:process.env.JAVA_HOME||'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',ANDROID_HOME:sdk};
 const report={directory,started_at:new Date().toISOString(),device:serial,application_id:app,environment_id:environmentID,activation:false,phases:[],checks:{},discovery:{device_filter:serial,package_filter:app,foreign_refused:0},limitations:['Physical Android with targetSDK35 over explicitly scoped USB ADB reverse. No LAN reachability, target37 local-network permission, trusted browser HTTPS, or power-loss claim.','Synthetic fixture business flow uses the real current SDK and a real loopback HTTP response consumed to EOF; headers and bodies are marked unavailable.','Installed desktop Chrome DOM/layout plus two animation-frame opportunities; no phone browser or hardware paint claim.']};
 let collector,watcher,context,verified=false,route,baseline,manifestBefore,dbPath,source,eventIDs;
 async function checkpoint(name,data={}){report.phases.push({name,...timestamp(),...data});await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({phase:name,directory,...data}));}
 async function run(command,args,{timeout=15000,input,encoding='utf8',onSuccess,...config}={}){
  let result;try{result=await runOwnedProcess(command,args,{timeout,input,env,outputLimit:8*1024*1024,...config});}catch(e){report.failed_command={command,args,timeout_ms:timeout,input_omitted:input!==undefined};throw e;}
  await persistClosedCommand(result,onSuccess,async()=>await writeFile(join(directory,'command-'+randomUUID()+'.log'),Buffer.concat([result.stdout,result.stderr]),{mode:0o600}));
  assert.equal(result.code,0,'Owned command failed with code '+result.code);return encoding==='buffer'?result.stdout:result.stdout.toString('utf8');
 }
 const device=(args,config={})=>{assertPhysicalDevice(serial);assert(verified,'Physical identity not verified');return run(adb,['-s',serial,...args],config);};
 async function control(path,limit=16384){assert(/^[a-zA-Z0-9._/-]+$/.test(path));return decodeAndroidControl(await device(['exec-out','run-as',app,'--user','0','sh','-c',`test ! -L no_backup && test ! -L ${path} && if [ ! -e ${path} ];then printf N;elif [ ! -f ${path} ];then printf U;else printf F;head -c ${limit+1} ${path};fi`],{encoding:'buffer'}));}
 async function aliveProtected(){for(const pid of options.protectPids){process.kill(pid,0);}return options.protectPids;}
 try{
  assert.equal((await run(adb,['-s',serial,'get-state'])).trim(),'device');assert.equal((await run(adb,['-s',serial,'shell','getprop','ro.serialno'])).trim(),serial);verified=true;
  report.device_metadata={model:(await device(['shell','getprop','ro.product.model'])).trim(),android_release:(await device(['shell','getprop','ro.build.version.release'])).trim(),api:(await device(['shell','getprop','ro.build.version.sdk'])).trim(),abi:(await device(['shell','getprop','ro.product.cpu.abi'])).trim()};assert.equal(report.device_metadata.abi,'arm64-v8a');report.limitations[0]=`Physical Android ${report.device_metadata.android_release}/API ${report.device_metadata.api} with targetSDK35 over explicitly scoped USB ADB reverse. No LAN reachability, target37 local-network permission, trusted browser HTTPS, or power-loss claim.`;
  assert.equal((await device(['shell','pm','list','packages','--user','0',app])).trim(),'','Fresh owned package already exists');report.package_absence_verified=true;
  baseline=(await device(['reverse','--list'])).trim().split(/\r?\n/).filter(Boolean).sort();report.reverse_inventory_before=baseline;manifestBefore=await activeSnapshot();report.active_manifest_before=manifestBefore;report.protected_pids_before=await aliveProtected();report.harness_sha256=sha(await boundedRead(fileURLToPath(import.meta.url),1024*1024));
  await checkpoint('physical-preflight');
  await run(join(root,'android/gradlew'),['-p',join(root,'android'),':logger:bundleDebugAar',':logger-api:jar','--console=plain'],{timeout:180000});report.sdk_source_sha256=await sources();report.sdk_aar_sha256=sha(await readFile(join(root,'android/logger/build/outputs/aar/logger-debug.aar')));report.api_jar_sha256=sha(await readFile(join(root,'android/logger-api/build/libs/logger-api.jar')));report.android_adapter_sha256=sha(await boundedRead(join(root,'collector/android-live.mjs'),1024*1024));
  collector=await startCollector({directory:join(directory,'collector'),port:0,activate:false});dbPath=collector.store.path;report.collector_id=collector.store.config.collector_id;report.origin=collector.origin;guardCollector(collector,app,environmentID,report.discovery);
  const ticket=await collector.store.ticket({principal:'physical-owned-fixture',scope:{platform:'android',app_id:app,environment_id:environmentID},max_sources:1});
  const connection={version:2,endpoint:collector.origin,collector_id:collector.store.config.collector_id,enrollment_token:ticket.enrollment_token,environment_id:environmentID,environment_name:'Owned physical Pixel fixture'};
  await mkdir(join(project,'src/main/kotlin/dev/networklog/physical'),{recursive:true,mode:0o700});await mkdir(join(project,'src/main/res/xml'),{recursive:true});await mkdir(join(project,'src/main/assets'),{recursive:true});
  await writeFile(join(project,'src/main/assets/private-pairing.json'),JSON.stringify(connection),{mode:0o600});
  await writeFile(join(project,'settings.gradle.kts'),'pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name="OwnedPhysicalFixture"\n');
  await writeFile(join(project,'build.gradle.kts'),`plugins { id("com.android.application") version "8.13.2";id("org.jetbrains.kotlin.android") version "2.2.20" }\nandroid { namespace="dev.networklog.physical";compileSdk=35;defaultConfig { applicationId="${app}";minSdk=26;targetSdk=35;versionCode=1;versionName="fixture" };compileOptions { sourceCompatibility=JavaVersion.VERSION_17;targetCompatibility=JavaVersion.VERSION_17 } }\nkotlin { jvmToolchain(17) }\ndependencies { implementation(files(${JSON.stringify(join(root,'android/logger/build/outputs/aar/logger-debug.aar'))}));implementation(files(${JSON.stringify(join(root,'android/logger-api/build/libs/logger-api.jar'))})) }\n`);
  await writeFile(join(project,'local.properties'),'sdk.dir='+sdk+'\n');await writeFile(join(project,'src/main/res/xml/network_security.xml'),'<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain>127.0.0.1</domain></domain-config></network-security-config>');
  await writeFile(join(project,'src/main/AndroidManifest.xml'),'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET"/><application android:allowBackup="false" android:label="Owned physical SDK fixture" android:networkSecurityConfig="@xml/network_security"><activity android:name="dev.networklog.physical.PhysicalActivity" android:exported="true"/></application></manifest>');
  await writeFile(join(project,'src/main/kotlin/dev/networklog/physical/PhysicalActivity.kt'),`package dev.networklog.physical
import android.app.Activity
import android.os.Bundle
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import dev.networklog.logger.*
class PhysicalActivity:Activity() { override fun onCreate(state:Bundle?) { super.onCreate(state);val stage=intent.getStringExtra("stage")?:return;Thread {
 val marker=JSONObject();try {
  val root=DebugTransfer.directory(applicationContext);require(!File(root,"source.json").exists());root.mkdirs();val selected=assets.open("private-pairing.json").use{it.readBytes()};FileOutputStream(File(root,"pairing.json")).use{it.write(selected);it.fd.sync()};val endpoint=JSONObject(String(selected,Charsets.UTF_8)).getString("endpoint");marker.put("manual_selection_before_descriptor",!File(root,"source.json").exists());
  DebugTransfer.open(applicationContext).use { sink -> marker.put("journal_id",sink.file.parentFile!!.name);val session=NetworkLog(sink,packageName,namespace=packageName+"/development").startSession("Owned physical USB HTTP flow",stage);val actor=Actor("sdk","PhysicalFixture","run");val operation=session.startOperation("physical fixture",actor);session.invokeHandler("business handler",actor,Actor("integrator","FixtureHandler","fetch"),operation.context) { parent -> val url=endpoint+"/api/v2/health";val request=session.startRequest("GET",url,parent,actor,actor);val http=URL(url).openConnection() as HttpURLConnection;http.connectTimeout=5000;http.readTimeout=5000;try { val status=http.responseCode;val body=http.inputStream.use{it.readBytes()};require(status==200&&body.isNotEmpty());request.completeResponse(status);marker.put("http_status",status);marker.put("body_eof",true) }finally { http.disconnect() } };operation.complete();session.end();sink.flush().get();marker.put("uploaded",sink.awaitUploaded(30000));marker.put("installation_id",JSONObject(File(root,"source.json").readText()).getString("installation_id")) }
 }catch(error:Throwable){marker.put("error",error.javaClass.simpleName)};File(filesDir,"stage-"+stage+".json").writeText(marker.toString()) }.start() } }
`);
  report.fixture_source_sha256=sha(await boundedRead(join(project,'src/main/kotlin/dev/networklog/physical/PhysicalActivity.kt'),1024*1024));await run(join(root,'android/gradlew'),['-p',project,'assembleDebug','--console=plain'],{timeout:180000});const apks=(await readdir(join(project,'build/outputs/apk/debug'))).filter(n=>n.endsWith('.apk'));assert.equal(apks.length,1);const apk=join(project,'build/outputs/apk/debug',apks[0]);report.apk_sha256=sha(await readFile(apk));
  const badging=await run(join(sdk,'build-tools/35.0.0/aapt'),['dump','badging',apk]);assert(badging.startsWith(`package: name='${app}' `));assert(badging.includes('application-debuggable'));assert.equal((await device(['shell','pm','list','packages','--user','0',app])).trim(),'');await checkpoint('fresh-private-fixture-built');
  report.install_attempted=true;await device(['install','--user','0',apk],{timeout:60000});assert.equal(await control('no_backup/HTTPSequenceLogger/source.json'),null);await device(['exec-out','run-as',app,'--user','0','id']);report.checks.fresh_debug_app_run_as=true;
  const wanted='tcp:'+new URL(collector.origin).port;assert(!baseline.some(line=>line.split(/\s+/).slice(-2)[0]===wanted));await device(['reverse','--no-rebind',wanted,wanted],{onSuccess:()=>{route=wanted;report.owned_reverse_route=route;}});
  watcher=await watchAndroid({collector,adb,device:serial,packageName:app});
  context=await chromium.launchPersistentContext(join(directory,'chrome-profile'),{channel:'chrome',headless:true,timeout:30000,viewport:{width:1440,height:1000}});report.chrome={version:context.browser().version()};context.on('close',()=>{report.chrome.closed_observed=true;});const page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(30000);await page.goto(collector.origin+'/',{timeout:30000});await page.getByLabel('Follow newest session').uncheck();await expect(page.getByLabel('Follow newest session')).not.toBeChecked();
  const cell='.live-panel .device-status[aria-live="polite"] small:has-text("'+serial+' (device)")';await expect(page.locator(cell)).toBeVisible();report.device_dom={...await rendered(page,cell),...timestamp()};assert.equal((await collector.store.sources()).sources.length,0);assert.equal(await control('no_backup/HTTPSequenceLogger/source.json'),null);report.checks.device_before_sdk_descriptor=true;
  const session='physical-'+randomUUID();report.session_id=session;await checkpoint('owned-viewer-ready-before-sdk');report.sdk_launch_attempted=true;await device(['shell','am','start','--user','0','-n',app+'/dev.networklog.physical.PhysicalActivity','--es','stage',session]);
  let marker,lines;const deadline=performance.now()+60000;while(performance.now()<deadline){const bytes=await control('files/stage-'+session+'.json');if(bytes){marker=parsePrivateJSON(bytes);assert(!marker.error,'Actual SDK fixture failed: '+marker.error);assert.equal(marker.uploaded,true);assert.equal(marker.http_status,200);assert.equal(marker.body_eof,true);assert.equal(marker.manual_selection_before_descriptor,true);report.checks.private_manual_selection_before_descriptor=true;source=(await collector.store.sources()).sources.find(s=>s.app_id===app&&s.environment_id===environmentID&&s.installation_id===marker.installation_id);if(source){lines=(await collector.store.page({source_id:source.source_id,after:0,limit:100})).lines;if(lines.some(line=>JSON.parse(line).event_type==='session.ended'))break;}}await delay(100);}assert(source&&lines?.length,'Physical SDK capture absent');const validation=validateCapture(lines.join('\n')+'\n');assert.equal(validation.valid,true,JSON.stringify(validation.errors));assertObservedFlow(validation.events,session);eventIDs=validation.events.map(e=>e.event_id);report.source_id=source.source_id;report.event_ids=eventIDs;report.event_count=eventIDs.length;report.installation_id=marker.installation_id;
  assert.match(marker.journal_id,/^[a-f0-9-]{36}$/);const canonical=await control('no_backup/HTTPSequenceLogger/journals/'+marker.journal_id+'/capture.ndjson');assert(canonical);const local=validateCapture(canonical.toString());assert.equal(local.valid,true);assert.deepEqual(local.events.map(e=>e.event_id),eventIDs);await writeFile(join(directory,'capture.ndjson'),canonical,{mode:0o600});report.checks.actual_sdk_http_eof_handler_and_private_ack=true;report.checks.canonical_capture_exported=true;
  await expect(page.locator('.source-navigation').getByText(app,{exact:true})).toBeVisible();await expect(page.locator(`.source-navigation summary[title="${environmentID}"]`)).toBeVisible();await expect(page.locator('.source-navigation .session-row')).toHaveCount(1);const response=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/v2/events'&&u.searchParams.get('source_id')===source.source_id&&u.searchParams.get('session_id')===session;},{timeout:30000});await page.locator('.source-navigation details details').getByRole('button').click();const selected=await(await response).json();report.browser_response_event_ids=selected.lines.map(line=>JSON.parse(line).event_id);assert.deepEqual(report.browser_response_event_ids,eventIDs);await expect(page.locator('.session-title h1')).toHaveText('Owned physical USB HTTP flow');report.session_dom={...await rendered(page,'.session-title h1'),...timestamp()};const diagram='.diagram-host:not([hidden]) .nll-sequence svg[aria-label="Request and local invocation sequence"]';await expect(page.locator(diagram)).toBeVisible();report.diagram_entity_ids=validation.events.filter(e=>e.event_type==='http.request.started'||e.event_type==='operation.started'&&e.data.invocation?.kind==='handler').map(e=>e.context.trace_id+'/'+e.context.span_id);for(const id of report.diagram_entity_ids)await expect(page.locator(diagram+' [data-entity-id="'+id+'"]').first()).toBeVisible();report.diagram_dom={...await rendered(page,diagram),...timestamp()};report.checks.exact_request_and_handler_svg_rendered=true;await page.screenshot({path:join(directory,'physical-app-session.png'),fullPage:true});report.checks.actual_viewer_physical_environment_app_session=true;report.passed=true;await checkpoint('checks-passed');
 }catch(error){report.passed=false;report.error=error.message;try{await checkpoint('failed',{reason:error.message});}catch(e){report.evidence_error=e.message;}}
 finally{
  const errors=[];report.cleanup={};const clean=(label,action,deadline=15000)=>cleanupRestoreAction(label,action,checkpoint,errors,deadline);
  report.cleanup.watcher_closed=await clean('close only owned physical watcher',async()=>await watcher?.close());
  report.cleanup.reverse_inventory_restored=baseline?await clean('restore exact physical reverse baseline',async()=>{assert(report.cleanup.watcher_closed);await restoreOwnedReverse(device,baseline,route);}):true;
  report.cleanup.chrome_closed=await clean('close only private Chrome',async()=>{if(context){await context.close();assert.equal(report.chrome.closed_observed,true);}});report.cleanup.collector_closed=await clean('close only private collector',async()=>await collector?.close());
  if(report.passed&&report.cleanup.collector_closed)report.cleanup.sqlite_after_owner_close=await clean('verify physical durable IDs after collector close',async()=>{report.final_database=sqlite(dbPath);assert.equal(report.final_database.sources,1);assert.deepEqual(report.final_database.event_ids,eventIDs);report.checks.sqlite_after_owner_close=true;});
  report.cleanup.owned_app_uninstalled=await clean('reconcile and remove only fresh physical fixture',async()=>{report.install_reconciliation=await reconcileOwnedInstall(device,{app,installAttempted:report.install_attempted===true,sdkLaunchAttempted:report.sdk_launch_attempted===true,captureExported:report.checks.canonical_capture_exported===true,expectedAPKHash:report.apk_sha256});},40000);
  report.cleanup.active_manifest_unchanged=await clean('preserve user active manifest',async()=>{report.active_manifest_after=await activeSnapshot();assert.equal(report.active_manifest_after,manifestBefore);});report.cleanup.protected_pids_alive=await clean('preserve unrelated owner processes',async()=>{report.protected_pids_after=await aliveProtected();});
  report.cleanup.errors=errors;if(errors.length)report.passed=false;report.finished_at=new Date().toISOString();await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:report.passed,evidence:join(directory,'result.json'),event_count:report.event_count,checks:report.checks,cleanup:report.cleanup,error:report.error}));if(!report.passed)process.exitCode=1;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){let options;try{options=parseArguments(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=2;}if(options?.help)console.log('node scripts/check-physical-android.mjs --device SERIAL [--protect-pid PID ...]');else if(options)await main(options);}
