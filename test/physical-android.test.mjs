import assert from 'node:assert/strict';
import test from 'node:test';
import {assertObservedFlow,assertOwnedPackage,parseArguments,reconcileOwnedInstall} from '../scripts/check-physical-android.mjs';

test('physical fixture CLI requires an explicit physical serial and scopes optional protected PIDs',()=>{
 assert.deepEqual(parseArguments(['--device','PHYSICAL_FIXTURE_01']),{help:false,device:'PHYSICAL_FIXTURE_01',protectPids:[]});
 assert.deepEqual(parseArguments(['--device','PHYSICAL_FIXTURE_01','--protect-pid','42','--protect-pid','84']),{help:false,device:'PHYSICAL_FIXTURE_01',protectPids:[42,84]});
 for(const args of [[],['--device','emulator-5554'],['--device','bad;serial'],['--device'],['--device','physical','--package','dev.networklog.sample'],['--help','--device','physical'],['--device','physical','--device','other']])assert.throws(()=>parseArguments(args));
});
test('physical protected PID options refuse missing, zero, negative, fractional, duplicate and overflowing values',()=>{
 for(const value of ['0','-1','1.2','abc','2147483648','9007199254740993'])assert.throws(()=>parseArguments(['--device','physical','--protect-pid',value]));
 assert.throws(()=>parseArguments(['--device','physical','--protect-pid']));assert.throws(()=>parseArguments(['--device','physical','--protect-pid','42','--protect-pid','42']));
});
test('physical fixture package ownership excludes existing sample/consumer/restore apps',()=>{
 assertOwnedPackage('dev.networklog.physical.p'+'a'.repeat(32));
 for(const app of ['dev.networklog.sample','example.consumer','dev.networklog.restore.p'+'a'.repeat(32),'dev.networklog.physical.pabc','dev.networklog.physical.p'+'a'.repeat(32)+';echo'])assert.throws(()=>assertOwnedPackage(app));
});
test('install timeout after device commit still reconciles and removes only the matching owned APK',async()=>{
 const app='dev.networklog.physical.p'+'a'.repeat(32),hash='b'.repeat(64),path='/data/app/~~owned/'+app+'-owned/base.apk';let present=true;const calls=[];
 const device=async args=>{calls.push(args);if(args[1]==='pm'&&args[2]==='list'){assert.deepEqual(args,['shell','pm','list','packages','--user','0',app]);return present?'package:'+app:'';}if(args[2]==='path'){assert.deepEqual(args,['shell','pm','path','--user','0',app]);return 'package:'+path;}if(args[1]==='sha256sum')return hash+'  '+path;if(args[2]==='uninstall'){assert.deepEqual(args,['shell','pm','uninstall','--user','0',app]);present=false;return 'Success';}assert.fail('Unexpected command');};
 const result=await reconcileOwnedInstall(device,{app,installAttempted:true,sdkLaunchAttempted:false,captureExported:false,expectedAPKHash:hash});assert.equal(result.absence_verified,true);assert.equal(result.present_before,true);assert.equal(calls.filter(args=>args[2]==='uninstall').length,1);
});
test('uncertain install cleanup retains mismatched APK and unexported SDK capture',async()=>{
 const app='dev.networklog.physical.p'+'a'.repeat(32),hash='b'.repeat(64),path='/data/app/~~owned/'+app+'-owned/base.apk';const calls=[];
 const device=async args=>{calls.push(args);if(args[2]==='list')return 'package:'+app;if(args[2]==='path')return 'package:'+path;if(args[1]==='sha256sum')return 'c'.repeat(64)+'  '+path;assert.fail('Uninstall must not occur');};
 await assert.rejects(reconcileOwnedInstall(device,{app,installAttempted:true,sdkLaunchAttempted:false,captureExported:false,expectedAPKHash:hash}),/differs from the owned fixture/);
 await assert.rejects(reconcileOwnedInstall(device,{app,installAttempted:true,sdkLaunchAttempted:true,captureExported:false,expectedAPKHash:hash}),/history export is unproven/);assert(!calls.some(args=>args[2]==='uninstall'));
});
test('owned installed APK reconciliation rejects dot path segments before hashing or removal',async()=>{
 const app='dev.networklog.physical.p'+'a'.repeat(32),hash='b'.repeat(64);
 for(const segment of ['.','..']){
  const calls=[];const device=async args=>{calls.push(args);if(args[2]==='list')return 'package:'+app;if(args[2]==='path')return 'package:/data/app/'+segment+'/owned/base.apk';assert.fail('Unsafe path must not be hashed or removed');};
  await assert.rejects(reconcileOwnedInstall(device,{app,installAttempted:true,sdkLaunchAttempted:false,expectedAPKHash:hash}),/Unsafe dot segment/);assert(!calls.some(args=>args[1]==='sha256sum'||args[2]==='uninstall'));
 }
});
test('uncertain install absence is proven without uninstall, and failed presence probe does not claim cleanup',async()=>{
 const app='dev.networklog.physical.p'+'a'.repeat(32),calls=[];
 const result=await reconcileOwnedInstall(async args=>{calls.push(args);return '';},{app,installAttempted:true});assert.equal(result.absence_verified,true);assert.equal(result.present_before,false);assert.equal(calls.length,1);
 await assert.rejects(reconcileOwnedInstall(async()=>{throw new Error('Device unavailable');},{app,installAttempted:true}),/Device unavailable/);
});
const proof=()=>[
 {event_type:'session.started',data:{}},
 {event_type:'operation.started',context:{span_id:'handler'},data:{invocation:{kind:'handler',dispatch:'synchronous'}}},
 {event_type:'http.request.started',context:{span_id:'request',parent_span_id:'handler'},data:{}},
 {event_type:'http.ended',context:{span_id:'request'},data:{outcome:'success',status_code:200,end_reason:'body_eof'}},
 {event_type:'operation.ended',context:{span_id:'handler'},data:{outcome:'success',completion:'returned'}},
 {event_type:'session.ended',data:{}}
].map(e=>({...e,schema_version:'1.3',session_id:'own'}));
test('physical proof refuses partial HTTP observation and unobserved success',()=>{
 assertObservedFlow(proof(),'own');
 for(const change of [{outcome:'unknown'},{status_code:500},{end_reason:'body_closed'}]){const events=proof();Object.assign(events[3].data,change);assert.throws(()=>assertObservedFlow(events,'own'));}
 assert.throws(()=>assertObservedFlow(proof(),'foreign'));
});
test('physical proof requires the matching completed synchronous handler and nesting',()=>{
 for(const modify of [e=>e[4].context.span_id='unmatched',e=>e[4].data.completion='observation_stopped',e=>e[1].data.invocation.dispatch='awaited',e=>e[2].context.parent_span_id='foreign']){const events=proof();modify(events);assert.throws(()=>assertObservedFlow(events,'own'));}
});
