#!/usr/bin/env node
// Build both variants and inspect the actual unsigned iOS archive, including its dependency graph.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(root, '.local', 'release-isolation');
const derivedData = join(evidence, 'DerivedData');
const archive = join(evidence, 'Production.xcarchive');
mkdirSync(evidence, { recursive: true });
rmSync(join(evidence, 'result.json'), { force: true });
execFileSync('xcodegen', ['generate'], { cwd: root, stdio: 'inherit' });

async function build(name, args, expectedError) {
  const logPath = join(evidence, `${name}.log`);
  const output = createWriteStream(logPath);
  const child = spawn('xcodebuild', [
    ...args, '-project', 'NetworkLogTransferDemo.xcodeproj',
    '-derivedDataPath', derivedData, 'CODE_SIGNING_ALLOWED=NO',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const code = await new Promise((yes, no) => { child.once('close', yes); child.once('error', no); });
  await new Promise(resolve => output.end(resolve));
  const log = readFileSync(logPath, 'utf8');
  if (expectedError) {
    assert.notEqual(code, 0, `${name} unexpectedly succeeded`);
    assert.match(log, expectedError, `${name} failed for an unexpected reason; inspect ${logPath}`);
  } else assert.equal(code, 0, `${name} failed; inspect ${logPath}`);
  return log;
}

await build('debug', ['build', '-scheme', 'NetworkLogTransferDemo', '-configuration', 'Debug',
  '-destination', 'generic/platform=iOS Simulator']);
const releaseLog = await build('release', ['archive', '-scheme', 'NetworkLogProductionApp',
  '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-archivePath', archive]);
assert.match(releaseLog, /Target dependency graph \(1 target\)/, 'Production must build exactly one app target');
assert.doesNotMatch(releaseLog, /Target 'NetworkLogTransfer(?:Demo|Tests)?' in project/,
  'Development package/demo/test target entered the production build graph');
await build('development-release-rejected', ['build', '-scheme', 'NetworkLogTransferDemo',
  '-configuration', 'Release', '-destination', 'generic/platform=iOS'],
  /error: The capture demo is development-only/);

const debugApp = join(derivedData, 'Build/Products/Debug-iphonesimulator/NetworkLogTransferDemo.app');
const releaseApp = join(archive, 'Products/Applications/NetworkLogProductionApp.app');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const markers = [
  'NDJSONTransferSink', 'CollectorTransport', 'DurableSpool', 'TransferConnection', 'ManualCaptureDemo',
  'api/v1/events', 'certificate_sha256', 'events.ndjson', 'cursor.json', 'httpbin.org', 'Collector pairing',
];
// DEBUG dylibs are part of the app on recent Xcode versions, so inspect the entire bundle.
const debugBytes = files(debugApp).map(path => readFileSync(path));
for (const marker of ['NDJSONTransferSink', 'CollectorTransport', 'api/v1/events']) {
  assert.ok(debugBytes.some(bytes => bytes.includes(Buffer.from(marker))), `Debug positive control missing ${marker}`);
}
const releaseFiles = files(releaseApp);
for (const path of releaseFiles) {
  assert.doesNotMatch(path.slice(releaseApp.length), /IntegrationConfig|Fixtures|localhost\.der|\.ndjson$|NetworkLogTransfer/,
    `Development resource found: ${path}`);
  const bytes = readFileSync(path);
  for (const marker of markers) assert.ok(!bytes.includes(Buffer.from(marker)), `Development marker ${marker} found in ${path}`);
}
const binary = join(releaseApp, 'NetworkLogProductionApp');
const symbols = execFileSync('xcrun', ['nm', binary], { encoding: 'utf8' });
const linkedLibraries = execFileSync('xcrun', ['otool', '-L', binary], { encoding: 'utf8' });
assert.doesNotMatch(symbols, /NetworkLogTransfer|NDJSONTransfer|CollectorTransport|DurableSpool|ManualCaptureDemo/);
assert.doesNotMatch(linkedLibraries, /NetworkLogTransfer|CryptoKit|Security\.framework|CFNetwork/,
  'Development transfer dependency linked into production');
const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(releaseApp, 'Info.plist')], { encoding: 'utf8' }));
assert.equal(info.NSLocalNetworkUsageDescription, undefined, 'Production includes a development local-network prompt');
assert.equal(info.NSAppTransportSecurity, undefined, 'Production includes development ATS exceptions');
writeFileSync(join(evidence, 'result.json'), JSON.stringify({
  passed: true, production_app: releaseApp, debug_positive_control: debugApp,
  production_target_count: 1, development_release_rejected: true,
  checked_files: releaseFiles.length, forbidden_markers: markers,
  linked_libraries: linkedLibraries.trim().split('\n').slice(1).map(line => line.trim()),
}, null, 2) + '\n');
console.log(`Release isolation verified: ${releaseApp}`);
console.log(`Build logs and result: ${evidence}`);
