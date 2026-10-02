import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {assertBackupSucceeded,assertOwnedInstance,assertRestoreSucceeded,assertSafeAvdDeletion,cleanupRestoreAction,closeOwnedEmulator,manualSelectionWriteArguments,parseArguments,persistClosedCommand,restoreSetToken} from '../scripts/check-native-os-restore.mjs';

test('OS restore preflight refuses existing targets and arbitrary ports; ownership checks exact private AVD',()=>{
 assert.deepEqual(parseArguments(['--owned-avd']),{help:false,image:'default'});
 for(const argv of [[],['--device','emulator-5556'],['--owned-avd','--avd','user-avd'],['--owned-avd','--port','5556'],['--owned-avd','--system-image','foreign'],['--owned-avd','--owned-avd']])assert.throws(()=>parseArguments(argv));
 const owner={name:'networklog_restore_'+randomUUID().replaceAll('-',''),port:5582};
 assertOwnedInstance(owner,'emulator-5582',owner.name);
 assert.throws(()=>assertOwnedInstance(owner,'emulator-5556',owner.name),/not the created emulator/);
 assert.throws(()=>assertOwnedInstance(owner,'emulator-5582','foreign-avd'),/differs from the created/);
 assert.throws(()=>assertOwnedInstance({...owner,port:5583},'emulator-5583',owner.name),/Invalid owned/);
});

test('restore proof requires exact owned-package backup, one real set and completed successful restore',()=>{
 const app='dev.networklog.restore.p123abcd';
 assertBackupSucceeded(`Running incremental backup for 1 requested packages.\nPackage ${app} with result: Success\nBackup finished with result: Success\n`,app);
 for(const output of ['Success',`Package foreign.app with result: Success\nBackup finished with result: Success`, `Package ${app} with result: Success\nBackup finished with result: Transport error`,`Permission denied\nBackup finished with result: Success`])assert.throws(()=>assertBackupSucceeded(output,app));
 assert.equal(restoreSetToken('  1 : Local disk image\n'),'1');
 assert.throws(()=>restoreSetToken('No restore sets'));
 assert.throws(()=>restoreSetToken(' 1 : local\n 2 : other'));
 assertRestoreSucceeded('restoreStarting: 1 packages\nrestoreFinished: 0\n');
 for(const output of ['Scheduling restore: 1','restoreFinished: -1','Permission denied'])assert.throws(()=>assertRestoreSucceeded(output));
});

test('manual selection writer uses shell-v2 EOF with a quoted command and refuses package interpolation',()=>{
 const args=manualSelectionWriteArguments('dev.networklog.restore.p123abc');assert.deepEqual(args.slice(0,4),['shell','-T','run-as','dev.networklog.restore.p123abc']);
 assert.match(args.at(-1),/^'umask 077; .*cat > no_backup\/HTTPSequenceLogger\/pairing\.json && sync'$/);
 for(const app of ['foreign.app','dev.networklog.restore.p123;echo bad','dev.networklog.restore.p123\nrm'])assert.throws(()=>manualSelectionWriteArguments(app));
});

test('persistent evidence failure cannot skip actual owned cleanup or erase original failure',async()=>{
 const errors=[],primary=new Error('backup failed'),actions=[];
 const evidence=async()=>{throw new Error('disk unavailable');};
 assert.equal(await cleanupRestoreAction('close emulator',async()=>{actions.push('close');},evidence,errors),true);
 assert.equal(await cleanupRestoreAction('delete AVD',async()=>{actions.push('delete');throw new Error('refusing live image deletion');},evidence,errors),false);
 assert.deepEqual(actions,['close','delete']);assert.equal(primary.message,'backup failed');
 assert(errors.some(e=>e.error==='refusing live image deletion'));assert.equal(errors.filter(e=>e.error==='disk unavailable').length,4);
});

test('successful resource effects are registered before diagnostic failure; live images cannot be deleted',async()=>{
 const owner={pid:123,closed:false};let registered=false;
 await assert.rejects(persistClosedCommand({code:0},()=>{registered=true;},async()=>{assert(registered);throw new Error('log write failed');}),/log write failed/);
 assert(registered);assert.throws(()=>assertSafeAvdDeletion(owner),/Refusing deletion/);
 owner.closed=true;assert.throws(()=>assertSafeAvdDeletion(owner),/absence is unproven/);
 owner.process_absent=true;owner.ports_absent=false;assert.throws(()=>assertSafeAvdDeletion(owner),/absence is unproven/);
 owner.ports_absent=true;assertSafeAvdDeletion(owner);assertSafeAvdDeletion({pid:null,closed:false});
 let failedRegistered=false;await persistClosedCommand({code:1},()=>{failedRegistered=true;},async()=>{});assert.equal(failedRegistered,false);
});

test('owned child ignoring TERM is killed and close is observed before cleanup returns',async()=>{
 const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000);'],{stdio:['ignore','pipe','pipe']});
 const closed=new Promise((ok,fail)=>{child.once('error',fail);child.once('close',(code,signal)=>ok({code,signal}));});
 try{await once(child.stdout,'data');await closeOwnedEmulator(child,closed,25);const result=await closed;assert.equal(result.signal,'SIGKILL');assert.equal(child.signalCode,'SIGKILL');}
 finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
});
