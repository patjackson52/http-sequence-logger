import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startCollector} from '../collector/server.mjs';
import {assertFixtureProvenance,guardCollector,parseArguments,rendered,restoreOwnedReverse} from '../scripts/check-native-cold-boot.mjs';

test('reverse cleanup removes only its exact added route and refuses changed or original routes',async()=>{
 const baseline=['emulator-5582 tcp:9999 tcp:9999'];let routes=[...baseline,'emulator-5582 tcp:12345 tcp:12345'];const calls=[];
 const device=async args=>{calls.push(args);if(args[1]==='--list')return routes.join('\n');assert.deepEqual(args,['reverse','--remove','tcp:12345']);routes=baseline;};
 await restoreOwnedReverse(device,baseline,'tcp:12345');assert.equal(calls.filter(args=>args[1]==='--remove').length,1);
 calls.length=0;routes=[...baseline,'emulator-5582 tcp:12345 tcp:54321'];await assert.rejects(restoreOwnedReverse(device,baseline,'tcp:12345'),/foreign reverse route/);assert(!calls.some(args=>args[1]==='--remove'));
 calls.length=0;routes=[...baseline];await assert.rejects(restoreOwnedReverse(device,baseline,'tcp:9999'),/original reverse inventory/);assert(!calls.some(args=>args[1]==='--remove'));
});

test('cold boot preflight requires explicit passed fixture and refuses existing OS/device/port targets',()=>{
 assert.deepEqual(parseArguments(['--owned-avd','--fixture-apk','/private/owned-fixture.apk']),{help:false,apk:'/private/owned-fixture.apk'});
 for(const args of [[],['--owned-avd'],['--owned-avd','--fixture-apk','relative.apk'],['--owned-avd','--device','emulator-5556'],['--owned-avd','--avd','user'],['--owned-avd','--port','5556'],['--help','--owned-avd']])assert.throws(()=>parseArguments(args));
});

test('fixture reuse refuses failed gate, unproven cleanup and changed SDK source/binary provenance',()=>{
 const sources={'android/logger/src/main/Fixture.kt':'current'};
 const previous={passed:true,application_id:'dev.networklog.restore.p123abc',checks:{actual_os_business_state_restored:true,sdk_identity_journals_pairing_cursor_excluded:true,fresh_sdk_identity_source_after_restore:true,old_collector_history_retained:true},cleanup:{owned_avd_deleted:true},sdk_source_sha256:sources,sdk_aar_sha256:'aar',api_jar_sha256:'api'};
 assertFixtureProvenance(previous,sources,'aar','api');
 for(const changed of [{...previous,passed:false},{...previous,cleanup:{owned_avd_deleted:false}},{...previous,sdk_source_sha256:{changed:'old'}},{...previous,sdk_aar_sha256:'old'},{...previous,api_jar_sha256:'old'},{...previous,application_id:'foreign.app'}])assert.throws(()=>assertFixtureProvenance(changed,sources,'aar','api'));
});

test('stalled browser frame observation reaches a host deadline so owned cleanup can proceed',async()=>{
 let cleanup=false;try{await assert.rejects(rendered({evaluate:()=>new Promise(()=>{})},'owned-device',20),/observation deadline exceeded/);}finally{cleanup=true;}assert.equal(cleanup,true);
});

test('real SQLite enrollment and local binding guards reject both foreign app and foreign environment before mutations',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'networklog-cold-guard-'));let collector;
 try{
  collector=await startCollector({directory,port:0,activate:false});const app='dev.networklog.restore.p123abc',environment='adb:emulator-5582:user:0',observations={foreign_refused:0};guardCollector(collector,app,environment,observations);
  const own={version:2,platform:'android',app_id:app,environment_id:environment,installation_id:randomUUID(),journal_id:randomUUID(),registration_id:randomUUID()};
  for(const foreign of [{...own,app_id:'foreign.app'},{...own,environment_id:'adb:emulator-5556:user:0'}]){
   await assert.rejects(collector.enroll(foreign),/before mutation/);await assert.rejects(collector.store.bindLocal('unowned-token',foreign),/before mutation/);
  }
  assert.equal((await collector.store.sources()).sources.length,0);assert.equal(collector.store.cursor,0);assert.equal(observations.foreign_refused,4);
  const enrolled=await collector.enroll(own);await collector.store.bindLocal(enrolled.source_token,own);assert.equal((await collector.store.sources()).sources.length,1);
 }finally{await collector?.close();await rm(directory,{recursive:true,force:true});}
});
