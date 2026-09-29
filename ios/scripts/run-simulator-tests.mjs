#!/usr/bin/env node
// Test runner only: keeps pairing secrets in a gitignored, mode-0600 resource; never prints their contents.
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, copyFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const device = option('--device', '7FB095F2-D1D6-4CF4-850E-1AF25FCB6CFD');
const loopback = JSON.parse(readFileSync(option('--loopback', resolve(root, '../artifacts/transfer/connection-loopback.json')), 'utf8'));
const tls = JSON.parse(readFileSync(option('--tls', resolve(root, '../artifacts/transfer/connection-lan.json')), 'utf8'));
const destination = new URL('/api/v1/events', loopback.endpoint);
if (destination.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname)) throw new Error('Test runner requires loopback HTTP collector');
const runID = randomUUID();
const listen = (server, port = 0) => new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => yes(server.address().port)); });
const redirect = http.createServer((_req, res) => { res.writeHead(307, { Location: destination.href }); res.end(); });
const redirectPort = await listen(redirect);
const oversized = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write(Buffer.alloc(300000, 32)); res.write(Buffer.alloc(300000, 32)); res.end();
});
const ackLimitPort = await listen(oversized);
const reservation = http.createServer();
const reconnectPort = await listen(reservation);
await new Promise(resolve => reservation.close(resolve));
const local = resolve(root, '.local'); mkdirSync(local, { recursive: true });
writeFileSync(resolve(local, 'IntegrationConfig.json'), JSON.stringify({ enabled: true, run_id: runID,
  loopback, tls, health_url: new URL('/api/v1/health', loopback.endpoint).href,
  redirect_endpoint: `http://127.0.0.1:${redirectPort}`, reconnect_endpoint: `http://127.0.0.1:${reconnectPort}`,
  ack_limit_endpoint: `http://127.0.0.1:${ackLimitPort}`
}), { mode: 0o600 });
execFileSync('xcodegen', ['generate'], { cwd: root, stdio: 'inherit' });
let forwarding;
let starting = false;
const monitor = setInterval(() => {
  if (starting) return;
  try {
    const container = execFileSync('xcrun', ['simctl', 'get_app_container', device, 'com.example.networklog.demo', 'data'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!existsSync(resolve(container, 'Documents', `reconnect-ready-${runID}`))) return;
    starting = true;
    forwarding = http.createServer((req, res) => {
      const outgoing = http.request(destination, { method: req.method, headers: { ...req.headers, host: destination.host } }, incoming => {
        res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
      });
      outgoing.on('error', () => { res.writeHead(503); res.end(); });
      req.pipe(outgoing);
    });
    forwarding.listen(reconnectPort, '127.0.0.1');
  } catch { /* Application installation has not completed yet. */ }
}, 500);
const logPath = resolve(local, 'simulator-tests.log');
const resultPath = resolve(local, `SimulatorTests-${runID}.xcresult`);
const log = createWriteStream(logPath);
const build = spawn('xcodebuild', ['test', '-project', 'NetworkLogTransferDemo.xcodeproj', '-scheme', 'NetworkLogTransferDemo',
  '-destination', `platform=iOS Simulator,id=${device}`, '-derivedDataPath', resolve(root, 'DerivedData'),
  '-resultBundlePath', resultPath, '-parallel-testing-enabled', 'NO', 'CODE_SIGNING_ALLOWED=NO'], { cwd: root });
build.stdout.pipe(log); build.stderr.pipe(log);
const exitCode = await new Promise(resolve => build.on('close', resolve));
clearInterval(monitor);
redirect.closeAllConnections(); await new Promise(resolve => redirect.close(resolve));
oversized.closeAllConnections(); await new Promise(resolve => oversized.close(resolve));
if (forwarding) { forwarding.closeAllConnections(); await new Promise(resolve => forwarding.close(resolve)); }
log.end();
try {
  const container = execFileSync('xcrun', ['simctl', 'get_app_container', device, 'com.example.networklog.demo', 'data'], { encoding: 'utf8' }).trim();
  const records = readFileSync(resolve(container, 'Documents/transfer-evidence.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.run_id === runID);
  const evidence = resolve(local, 'evidence', runID); mkdirSync(evidence, { recursive: true });
  for (const record of records) {
    const localCapture = resolve(evidence, basename(record.capture));
    copyFileSync(record.capture, localCapture);
    record.capture = localCapture;
  }
  writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ device, run_id: runID, exit_code: exitCode, records }, null, 2) + '\n');
  console.log(`Native capture evidence: ${evidence}`);
} catch { console.log('No native capture evidence available; inspect the test log.'); }
console.log(`Simulator tests ${exitCode === 0 ? 'passed' : 'failed'}. Log: ${logPath}. Results: ${resultPath}`);
process.exitCode = exitCode ?? 1;
