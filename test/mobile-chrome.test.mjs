import assert from 'node:assert/strict';
import test from 'node:test';
import {assertCaptureContinuity,assertReadOnlyChromeSource,chromeCodePaths,parseArguments} from '../scripts/check-mobile-chrome.mjs';
import {createLogger,MemoryJournal} from '../web-sdk/src/index.mjs';
const directory='/data/app/~~owned==/com.android.chrome-owned==/';
const names=['base.apk','split_chrome.apk','split_config.en.apk','split_dev_ui.apk','split_on_demand.apk','split_stack_unwinder.apk'];
const paths=names.map(name=>directory+name),text=paths.map(path=>'package:'+path).join('\n');
test('mobile Chrome requires an explicit read-only APK source and never accepts an existing execution target',()=>{
 assert.deepEqual(parseArguments(['--owned-avd','--chrome-apk-device','emulator-5554']),{help:false,source:'emulator-5554'});
 for(const args of [[],['--owned-avd'],['--owned-avd','--device','emulator-5554'],['--owned-avd','--avd','user'],['--owned-avd','--chrome-apk-device','emulator-5554;reboot'],['--help','--owned-avd']])assert.throws(()=>parseArguments(args));
});
test('code-only package inventory requires six distinct expected splits in one safe installed directory',()=>{
 assert.deepEqual(chromeCodePaths(text),paths);
 for(const bad of [text.replace('split_chrome.apk','base.apk'),text.replace('split_chrome.apk','../../data.xml'),text.replace('split_chrome.apk','other.apk'),text.replace(paths[0],'/data/user/0/com.android.chrome/profile/base.apk'),text.replace('package:'+paths[0],'package:'+paths[0]+';echo secret'),text+'\npackage:'+paths[0]])assert.throws(()=>chromeCodePaths(bad));
 assert.throws(()=>chromeCodePaths(text.replace(paths[0],'/data/user/0/com.android.chrome/base.apk')));
});
test('source device guard accepts only package metadata and APK code reads, refusing settings, launch, user data and package mutations',()=>{
 for(const args of [['shell','pm','path','com.android.chrome'],['shell','dumpsys','package','com.android.chrome'],['shell','getprop','ro.product.cpu.abi'],['shell','sha256sum',paths[0]],['pull',paths[0],'/private/base.apk']])assertReadOnlyChromeSource(args);
 for(const args of [['shell','pm','clear','com.android.chrome'],['shell','am','force-stop','com.android.chrome'],['shell','settings','put','global','debug_app','com.android.chrome'],['shell','getprop','anything'],['pull','/data/user/0/com.android.chrome/Preferences','/private/file'],['root']])assert.throws(()=>assertReadOnlyChromeSource(args));
});
test('real SDK canonical history proof rejects lost prefix, omitted durable IDs and duplicate retained records',async()=>{
 const journal=new MemoryJournal(),logger=createLogger({namespace:'fixture.mobile.proof',appId:'mobile-proof',sink:journal});logger.startSession({name:'Before offline',sessionId:'first'}).end();const before=await journal.exportNDJSON();logger.startSession({name:'Offline retained',sessionId:'second'}).end();const after=await journal.exportNDJSON(),ids=after.trim().split('\n').map(line=>JSON.parse(line).event_id);
 assert.equal(assertCaptureContinuity(before,after,ids).summary.sessions,2);assert.throws(()=>assertCaptureContinuity(before,after,ids.slice(1)));assert.throws(()=>assertCaptureContinuity(before,after.replace(before,''),ids));assert.throws(()=>assertCaptureContinuity(before,after+before,[...ids,...ids.slice(0,2)]));
});
