import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { androidBridge } from './adb.mjs';

const execute = promisify(execFile);
export const SAMPLE_PACKAGE = 'dev.networklog.sample';
export function adbPath(explicit) {
  if (explicit) return explicit;
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library/Android/sdk'), join(homedir(), 'Android/Sdk'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android/Sdk')].filter(Boolean);
  return roots.map(root => join(root, 'platform-tools', executable)).find(existsSync) || executable;
}
export function parseDevices(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(\S+)\s+(device|offline|unauthorized)\b(.*)$/);
    if (!match) return [];
    return [{ serial: match[1], state: match[2], emulator: match[1].startsWith('emulator-'),
      label: (match[3].match(/\bmodel:(\S+)/)?.[1] || match[1]).replaceAll('_', ' ') }];
  });
}
export function selectDevice(devices, serial) {
  if (serial) {
    const selected = devices.find(device => device.serial === serial);
    if (selected?.state === 'device') return selected;
    throw new Error(selected?.state === 'unauthorized' ? 'Unlock the device and allow USB debugging.' : 'Waiting for the selected device. Connect USB and enable USB debugging.');
  }
  const phones = devices.filter(device => !device.emulator);
  const candidates = phones.length ? phones : devices;
  if (candidates.length > 1) throw new Error(`Multiple devices found. Choose one with --device SERIAL: ${candidates.map(device => device.serial).join(', ')}`);
  if (!candidates.length) throw new Error('Connect an Android device with USB debugging enabled, or start an emulator.');
  return selectDevice(devices, candidates[0].serial);
}
export async function connectedDevices(adb = adbPath()) {
  return parseDevices((await execute(adb, ['devices', '-l'], { timeout: 10000 })).stdout);
}

/** Recheck routing and private pairing after reconnect or reinstall. Never switch phones mid-run. */
export async function watchAndroid({ collector, packageName = SAMPLE_PACKAGE, device, adb = adbPath(), interval = 2000 }) {
  let selected, bridge, timer, stopped = false, running;
  const status = value => { if (!stopped) collector.setDeviceStatus(value); };
  async function tick() {
    try {
      const devices = await connectedDevices(adb);
      const found = selectDevice(devices, selected?.serial || device);
      if (!selected) {
        selected = found;
        bridge = androidBridge({ packageName, device: selected.serial, adb });
      }
      try {
        await bridge.pair(collector.connections[0]);
        if (stopped) return;
        await bridge.poll(text => { if (!stopped) collector.ingest(text); });
        status({ state: 'connected', label: selected.label, message: 'USB connected · paired automatically · ready for live events' });
      } catch (error) {
        status({ state: 'waiting', label: selected.label, message: error.status
          ? `Collector could not retain events (HTTP ${error.status}). Export the capture and start a fresh collector directory.`
          : `Waiting for the debug app ${packageName}. Run npm run android:live to build and install the sample. USB reconnects are retried automatically.` });
      }
    } catch (error) {
      status({ state: 'waiting', label: selected?.label, message: error.code === 'ENOENT'
        ? 'Android platform-tools not found. Install the Android SDK to connect a device.' : error.message });
    } finally {
      if (!stopped) timer = setTimeout(() => { running = tick(); }, interval);
    }
  }
  await (running = tick());
  return { async close() { stopped = true; clearTimeout(timer); await running; } };
}
