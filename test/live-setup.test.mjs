import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCollector } from '../collector/server.mjs';
import { parseDevices, selectDevice } from '../collector/android-live.mjs';
import { androidBridge } from '../collector/adb.mjs';
import { CollectorClient } from '../viewer/src/collector-client.mjs';

const headers = { 'X-Network-Log-Viewer': '1', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin' };
const fixture = readFileSync(new URL('../examples/success.ndjson', import.meta.url), 'utf8').trim().split('\n');
function directory(t) { const path = mkdtempSync(join(tmpdir(), 'live-setup-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
async function until(condition) { const end = Date.now() + 5000; while (!condition()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(ok => setTimeout(ok, 10)); } }
function request(url, requestHeaders = {}, method = 'GET') {
  return new Promise((ok, fail) => {
    const req = http.request(url, { method, headers: requestHeaders }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text }));
    }); req.on('error', fail); req.end();
  });
}
test('automatic viewer credentials require same-origin browser context and never replace upload auth', async t => {
  const c = await startCollector({ directory: directory(t), port: 0 }); t.after(() => c.close());
  assert.equal(c.viewerURL, c.origin + '/');
  const url = c.origin + '/api/v1/viewer-session';
  const allowed = await request(url, headers), session = JSON.parse(allowed.text);
  assert.equal(allowed.status, 200); assert.equal(session.token, c.browserToken);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(allowed.headers['access-control-allow-origin'], undefined);
  assert.equal(allowed.headers['cross-origin-resource-policy'], 'same-origin');
  for (const denied of [{}, { ...headers, 'X-Network-Log-Viewer': '' },
    ...['cross-site', 'same-site', 'none', ''].map(site => ({ ...headers, 'Sec-Fetch-Site': site })),
    { ...headers, 'Sec-Fetch-Mode': 'navigate' }, { ...headers, Origin: 'https://foreign.example' },
    { ...headers, Host: 'rebound.example' }]) {
    const response = await request(url, denied); assert.equal(response.status, 403); assert.ok(!response.text.includes(c.browserToken));
  }
  assert.notEqual((await request(url, headers, 'POST')).status, 200);
  assert.notEqual((await request(url, headers, 'OPTIONS')).status, 200);
  assert.equal((await request(c.origin + '/api/v1/events')).status, 401);
  assert.equal((await request(c.origin + '/api/v1/events', { ...headers, Authorization: `Bearer ${session.token}` }, 'POST')).status, 401);
  const alias = new URL(c.origin); alias.hostname = 'localhost';
  const local = await request(url, { ...headers, Host: alias.host, Origin: alias.origin });
  assert.equal(local.status, 200);
  assert.equal(JSON.parse((await request(c.origin + '/api/v1/health')).text).automatic_viewer, true);
});
test('automatic client refreshes credentials and clears old rows when a different collector takes the same address', async t => {
  let c = await startCollector({ directory: directory(t), port: 0 });
  const origin = c.origin, port = Number(new URL(origin).port), captures = [], statuses = [], devices = []; let resets = 0;
  const client = new CollectorClient({ automatic: true, retryMs: 10,
    fetcher: (path, options) => fetch(origin + path, { ...options, headers: { ...options.headers, 'Sec-Fetch-Site': 'same-origin' } }),
    onCapture: (text, count) => captures.push({ text, count }), onReset: () => { resets++; },
    onStatus: state => statuses.push(state), onDevice: device => devices.push(device) });
  t.after(async () => { client.stop(); await c.close(); });
  const run = client.run();
  c.ingest(fixture.slice(0, 3).join('\n') + '\n');
  await until(() => statuses.at(-1)?.state === 'live');
  c.setDeviceStatus({ state: 'connected', label: 'Test phone', message: 'USB paired' });
  await until(() => devices.at(-1)?.state === 'connected');
  await c.close(); await until(() => statuses.at(-1)?.state === 'reconnecting');
  c = await startCollector({ directory: directory(t), port });
  c.ingest(fixture[0] + '\n');
  await until(() => resets === 1 && captures.at(-1)?.count === 1 && statuses.at(-1)?.state === 'live');
  assert.equal(captures.at(-1).text, fixture[0] + '\n');
  client.stop(); await run;
});
test('stopping automatic connection before its response prevents stale live callbacks', async () => {
  let reply, statuses = [], resets = 0;
  const client = new CollectorClient({ automatic: true, onStatus: status => statuses.push(status), onReset: () => resets++, fetcher: () => new Promise(ok => { reply = ok; }) });
  const run = client.run(); client.stop();
  reply(Response.json({ version: 1, collector_id: 'new', token: 'x'.repeat(32) }));
  await run; assert.equal(resets, 0); assert.ok(statuses.every(status => status.state !== 'live'));
});
test('Android selection favors the single phone without silently switching among phones or ignoring USB authorization', () => {
  const devices = parseDevices('List of devices attached\nemulator-5554 device model:Android_Emulator\nemulator-5556 device\nphone device usb:2-2 model:Pixel_10_Pro\n');
  assert.equal(selectDevice(devices).serial, 'phone'); assert.equal(selectDevice(devices).label, 'Pixel 10 Pro');
  assert.equal(selectDevice(devices, 'emulator-5556').serial, 'emulator-5556');
  assert.throws(() => selectDevice(devices, 'missing'), /selected device/);
  assert.throws(() => selectDevice([...devices, { serial: 'second', state: 'device' }]), /Multiple devices/);
  assert.throws(() => selectDevice(parseDevices('phone unauthorized\nemulator-5554 device')), /allow USB debugging/);
  assert.throws(() => selectDevice([]), /Connect an Android/);
  assert.throws(() => selectDevice(devices.filter(device => device.emulator)), /Multiple devices/);
});
test('Android rechecks pairing without rebinding an active route or rewriting matching private configuration', async () => {
  const connection = { endpoint: 'http://127.0.0.1:4319', token: 'private', collector_id: 'test' };
  const calls = []; let routes = 'UsbFfs tcp:4319 tcp:4319\n';
  const bridge = androidBridge({ packageName: 'dev.sample', device: 'phone', run: async (_command, args) => {
    calls.push(args.slice(2)); return { stdout: Buffer.from(args.includes('--list') ? routes : JSON.stringify(connection)) };
  } });
  await bridge.pair(connection);
  assert.ok(!calls.some(args => args[0] === 'reverse' && args[1] !== '--list'));
  routes = ''; calls.length = 0; await bridge.pair(connection);
  assert.deepEqual(calls.find(args => args[0] === 'reverse' && args[1] !== '--list'), ['reverse', 'tcp:4319', 'tcp:4319']);
});
