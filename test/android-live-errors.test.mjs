import assert from 'node:assert/strict';
import test from 'node:test';
import {adbFailureReason,DEVICE_UNREACHABLE} from '../collector/android-live.mjs';

test('failed adb process collapses to one short line',()=>{
 const error=Object.assign(new Error('Command failed: adb devices -l\nadb: server error\nline 3\nline 4'),{cmd:'adb devices -l',stderr:'adb: server error\n'});
 assert.equal(adbFailureReason(error),DEVICE_UNREACHABLE);
 assert.equal(adbFailureReason(Object.assign(new Error('x'),{killed:true})),DEVICE_UNREACHABLE);
});
test('non-process errors keep their message',()=>{
 assert.equal(adbFailureReason(new Error('Pairing write failed')),'Pairing write failed');
});
