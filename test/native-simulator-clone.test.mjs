import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArguments,assertOwnedMetadata,boundedFile,cleanupOwnedAction,trackCreatedSimulator,runCloneTool} from '../scripts/check-native-simulator-clone.mjs';

test('clone harness refuses arbitrary device targets and malformed options',()=>{
 for(const args of [[],['--simulator','pre-existing'],['--device','emulator-5556'],['--fixture-app'],['--unknown'],['--help','--fixture-app','app'],['--fixture-app','app','--fixture-app','other']])assert.throws(()=>parseArguments(args));
 assert.equal(parseArguments(['--help']).help,true);assert.equal(parseArguments(['--fixture-app','/owned/app']).fixture,'/owned/app');
});
test('enrollment and binding guard runs before mutations and permits only owned app/environments',()=>{
 const own=new Set(['simulator:original','simulator:clone']);let mutations=0;
 const mutate=metadata=>{assertOwnedMetadata(metadata,own,'owned.app');mutations++;};
 for(const metadata of [{app_id:'foreign.app',environment_id:'simulator:original'},{app_id:'owned.app',environment_id:'simulator:existing'},null])assert.throws(()=>mutate(metadata),e=>e.status===403);
 assert.equal(mutations,0);mutate({app_id:'owned.app',environment_id:'simulator:original'});mutate({app_id:'owned.app',environment_id:'simulator:clone'});assert.equal(mutations,2);
});
test('fixture reads reject oversized files and directories',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'owned-clone-file-'));try{const file=join(dir,'data');await writeFile(file,'small');assert.equal((await boundedFile(file,5)).toString(),'small');await assert.rejects(boundedFile(file,4));await mkdir(join(dir,'folder'));await assert.rejects(boundedFile(join(dir,'folder')));}finally{await rm(dir,{recursive:true,force:true});}
});

test('failed evidence writes cannot skip owned cleanup or replace original failure',async()=>{
 const report={error:'original bind failure',errors:[]},attempted=[];
 const checkpoint=async()=>{throw new Error('injected evidence writer failure');};
 for(const label of ['watcher','collector','clone simulator','original simulator'])assert.equal(await cleanupOwnedAction(label,async()=>attempted.push(label),checkpoint,report.errors),true);
 assert.deepEqual(attempted,['watcher','collector','clone simulator','original simulator']);assert.equal(report.error,'original bind failure');assert.equal(report.errors.length,8);assert(report.errors.every(e=>e.error==='injected evidence writer failure'));
});
test('cleanup deadlines preserve error and allow following owned cleanup',async()=>{
 const errors=[],phases=[],attempted=[];
 assert.equal(await cleanupOwnedAction('stalled watcher',()=>new Promise(()=>{}),async name=>phases.push(name),errors,5),false);
 assert.equal(await cleanupOwnedAction('collector',async()=>attempted.push('collector'),async name=>phases.push(name),errors,100),true);
 assert.deepEqual(attempted,['collector']);assert.match(errors[0].error,/deadline exceeded/);assert(phases.includes('cleanup-failed'));
});

test('persistent evidence failures still execute and observe cleanup command close',async()=>{
 const errors=[];const out=await runCloneTool(process.execPath,['-e','process.stdout.write("cleanup-executed")'],{checkpoint:async()=>{throw new Error('disk unavailable');},cleanup:true,onEvidenceError:e=>errors.push(e.message),timeout:3000,outputLimit:1024});
 assert.equal(out.code,0);assert.equal(out.stdout.toString(),'cleanup-executed');assert.deepEqual(errors,['disk unavailable','disk unavailable']);
});
test('successful create ownership survives failed post-effect evidence and remains available for cleanup',async()=>{
 const udid=randomUUID(),owned=new Set(),environments=new Set(),primary=new Error('evidence failed after create');let writes=0;
 await assert.rejects(runCloneTool(process.execPath,['-e','process.stdout.write('+JSON.stringify(udid)+')'],{checkpoint:async()=>{if(++writes>1)throw primary;},onClosed:out=>trackCreatedSimulator('xcrun',['simctl','create','Owned fixture'],out.stdout,owned,environments),timeout:3000,outputLimit:1024}),e=>e===primary);
 assert(owned.has(udid));assert(environments.has('simulator:'+udid));assert.throws(()=>trackCreatedSimulator('xcrun',['simctl','clone','foreign-origin','name'],Buffer.from(randomUUID()),owned,environments));
 const cleaned=[];await cleanupOwnedAction('delete remembered owned simulator',async()=>cleaned.push(...owned),async()=>{throw new Error('persistent disk failure');},[]);assert.deepEqual(cleaned,[udid]);
});
