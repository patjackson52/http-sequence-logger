#!/usr/bin/env node
// Test runner only: keeps pairing secrets in a gitignored, mode-0600 resource; never prints their contents.
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, copyFileSync, lstatSync, unlinkSync, renameSync, chmodSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const device = option('--device', undefined);
if (!device) throw new Error('Select an installed simulator with --device UDID');
const loopback = JSON.parse(readFileSync(option('--loopback', resolve(root, '../artifacts/transfer/connection-loopback.json')), 'utf8'));
const tls = JSON.parse(readFileSync(option('--tls', resolve(root, '../artifacts/transfer/connection-lan.json')), 'utf8'));
if (loopback.version !== 2 || tls.version !== 2 || !loopback.source_id || !tls.source_id) throw new Error('Test pairing files must use current source-aware transfer v2');
const destination = new URL('/api/v2/events', loopback.endpoint);
if (destination.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname)) throw new Error('Test runner requires loopback HTTP collector');
const runID = randomUUID();
const listen = (server, port = 0) => new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => yes(server.address().port)); });
const redirect = http.createServer((_req, res) => { res.writeHead(307, { Location: destination.href }); res.end(); });
const redirectPort = await listen(redirect);
const oversized = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  // Remain chunked and cross the 2 MiB ACK limit without relying on Content-Length.
  res.write(Buffer.alloc(1024 * 1024, 32)); res.write(Buffer.alloc(1024 * 1024 + 1, 32)); res.end();
});
const ackLimitPort = await listen(oversized);
const reservation = http.createServer();
const reconnectPort = await listen(reservation);
await new Promise(resolve => reservation.close(resolve));
const local = resolve(root, '.local'); mkdirSync(local, { recursive: true });
const output = resolve(option('--output', local)); mkdirSync(output, { recursive: true, mode: 0o700 });
const configPath = resolve(local, 'IntegrationConfig.json');
const previousConfig = existsSync(configPath) ? readFileSync(configPath) : null;
if (previousConfig) { const stat=lstatSync(configPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid() || (stat.mode & 0o077)) throw new Error('Existing IntegrationConfig must be private and owned'); }
let configRestored=false;
function restoreConfig() {
  if (configRestored) return;
  const current=JSON.parse(readFileSync(configPath,'utf8'));
  if(current.run_id!==runID)throw new Error('IntegrationConfig changed during tests; refusing to overwrite another run');
  if(previousConfig) { const temp=configPath+'.restore-'+runID;writeFileSync(temp,previousConfig,{mode:0o600,flag:'wx'});renameSync(temp,configPath); } else unlinkSync(configPath);
  configRestored=true;
}
process.once('exit',()=>{try{restoreConfig();}catch{process.exitCode=1;}});
writeFileSync(configPath, JSON.stringify({ enabled: true, run_id: runID,
  loopback, tls, health_url: new URL('/api/v2/health', loopback.endpoint).href,
  redirect_endpoint: `http://127.0.0.1:${redirectPort}`, reconnect_endpoint: `http://127.0.0.1:${reconnectPort}`,
  ack_limit_endpoint: `http://127.0.0.1:${ackLimitPort}`
}), { mode: 0o600 });
chmodSync(configPath,0o600);
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
const logPath = resolve(output, 'simulator-tests.log');
const resultPath = resolve(output, `SimulatorTests-${runID}.xcresult`);
const log = createWriteStream(logPath);
const build = spawn('xcodebuild', ['test', '-project', 'NetworkLogTransferDemo.xcodeproj', '-scheme', 'NetworkLogTransferDemo',
  '-destination', `platform=iOS Simulator,id=${device}`, '-derivedDataPath', resolve(option('--derived-data', resolve(root, 'DerivedData'))),
  '-resultBundlePath', resultPath, '-only-testing:NetworkLogTransferTests/SimulatorDeliveryTests', '-parallel-testing-enabled', 'NO', 'CODE_SIGNING_ALLOWED=NO'], { cwd: root });
build.stdout.pipe(log,{end:false}); build.stderr.pipe(log,{end:false});
const exitCode = await new Promise(resolve => build.on('close', resolve));
clearInterval(monitor);
redirect.closeAllConnections(); await new Promise(resolve => redirect.close(resolve));
oversized.closeAllConnections(); await new Promise(resolve => oversized.close(resolve));
if (forwarding) { forwarding.closeAllConnections(); await new Promise(resolve => forwarding.close(resolve)); }
await new Promise(resolve=>log.end(resolve));
restoreConfig();
try {
  const container = execFileSync('xcrun', ['simctl', 'get_app_container', device, 'com.example.networklog.demo', 'data'], { encoding: 'utf8' }).trim();
  const records = readFileSync(resolve(container, 'Documents/transfer-evidence.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.run_id === runID);
  const evidence = resolve(output, 'evidence', runID); mkdirSync(evidence, { recursive: true });
  for (const record of records) {
    const localCapture = resolve(evidence, `${record.test}-${record.session_id}-${basename(record.capture)}`);
    copyFileSync(record.capture, localCapture);
    record.capture = localCapture;
  }
  writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ device, run_id: runID, exit_code: exitCode, records, config_restored:configRestored }, null, 2) + '\n',{mode:0o600});
  console.log(`Native capture evidence: ${evidence}`);
} catch { console.log('No native capture evidence available; inspect the test log.'); }
console.log(`Simulator tests ${exitCode === 0 ? 'passed' : 'failed'}. Log: ${logPath}. Results: ${resultPath}`);
process.exitCode = exitCode ?? 1;
