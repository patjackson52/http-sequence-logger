// Production-viewer acceptance over a real loopback HTTP capture and SQLite collector.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startCollector } from '../collector/server.mjs';
import { buildViewer } from '../collector/runtime.mjs';
import { createLogger, createFetchClient, MemoryJournal } from '../web-sdk/src/index.mjs';
import { validateCapture } from '../shared/validate.mjs';
import { diffSequences, sequencesFromCapture } from '../sequence-diff/index.mjs';

if (process.argv[2] === '--help') {
  console.log(`Base64 production-viewer browser acceptance\nUsage: node scripts/check-base64.mjs\nRequires Node 24.13.x, npm ci, installed Chrome. Builds the viewer and starts isolated\nloopback HTTP and temporary non-activated SQLite collector services. Exercises real\nSDK request capture, query/header/nested JSON detection, fixture-observed form/raw/\ntransport bodies, negatives, keyboard/mobile, comparison and original exports.\nWrites ignored evidence/screenshots under artifacts/base64; BASE64_ARTIFACTS and\nWEB_TEST_CHANNEL override artifact directory and installed browser channel.`);
  process.exit(0);
}

const artifacts = resolve(process.env.BASE64_ARTIFACTS || 'artifacts/base64');
const privateDir = await mkdtemp(join(tmpdir(), 'network-log-base64-'));
await mkdir(artifacts, { recursive: true });
const encoded = text => Buffer.from(text).toString('base64');
const queryText = 'decoded query parameter';
const headerText = 'decoded header value';
const nestedText = 'nested decoded message';
const unicodeText = 'Unicode café ✓ decoded';
const hostileText = '<img src=x onerror=alert(1)>';
const rawText = 'Decoded complete raw request body';
const transportText = '{"message":"transport decoded text"}';
const formText = 'decoded form value';
const requests = [
  { path: '/json', media: 'application/json', body: JSON.stringify({ nested: { message: encoded(nestedText), unicode: encoded(unicodeText), html: encoded(hostileText) }, plain: 'ordinary text', hex: '0123456789abcdef', short: 'test', invalid: 'SGVsbG8===', binary: Buffer.from([0, 255, 1, 254, 2, 253]).toString('base64') }), query: new URLSearchParams([['encoded', encoded(queryText)], ['plain', 'ordinary'], ['short', 'test'], ['padded', 'MQ=='], ['invalidpad', 'Zh=='], ['repeat', encoded('first repeated value')], ['repeat', encoded('second repeated value')]]).toString(), headers: { 'x-encoded': encoded(headerText), 'x-basic': 'Basic ' + encoded('fixture:user credential'), 'x-plain': 'ordinary', authorization: encoded('synthetic redacted authorization') } },
  { path: '/form', media: 'application/x-www-form-urlencoded', body: new URLSearchParams([['payload', encoded(formText)], ['payload', encoded('second repeated form value')], ['plain', 'ordinary text']]).toString() },
  { path: '/raw', media: 'text/plain', body: encoded(rawText) },
  { path: '/transport', media: 'application/json', body: transportText, storageEncoding: 'base64' },
  { path: '/plain', media: 'application/json', body: JSON.stringify({ text: 'ordinary text', short: 'test', uuid: 'a6dcd563-56df-42f1-8ee6-83194f640412', hex: '0123456789abcdef', invalid: 'SGVsbG8===' }) },
  { path: '/redacted', media: 'application/json', body: JSON.stringify({ message: encoded(nestedText), password: encoded('synthetic redacted value') }) },
  { path: '/truncated', media: 'application/json', body: JSON.stringify({ message: encoded(nestedText) }), truncated: true },
  { path: '/partial', media: 'application/json', body: JSON.stringify({ message: encoded(nestedText) }), partial: true },
  { path: '/binary', media: 'application/octet-stream', body: Buffer.from([0, 255, 1, 254, 2, 253]), storageEncoding: 'base64' },
];
const evidence = { kind: 'Real SDK fetch capture against loopback HTTP fixture; synthetic fixture-observed non-JSON/storage bodies populated into canonical events because SDK policy withholds non-JSON. Production viewer in installed Chrome and retained SQLite collector. No native device execution.', scenarios: [], errors: [], screenshots: [] };
let fixture, collector, browser;
try {
  const observed = [];
  fixture = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    observed.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const journal = new MemoryJournal();
  const logger = createLogger({ namespace: 'base64/acceptance', appId: 'dev.base64.fixture', sink: journal });
  const session = logger.startSession({ name: 'Base64 acceptance', sessionId: 'primary' });
  const client = createFetchClient(session, { origin: { initiator: { owner: 'integrator', component: 'Fixture', method: 'run' }, executor: { owner: 'integrator', component: 'Fixture', method: 'run' } } });
  for (const spec of requests) {
    const response = await client.fetch(origin + spec.path + (spec.query ? '?' + spec.query : ''), { method: 'POST', headers: { 'content-type': spec.media, ...spec.headers }, body: spec.body });
    assert.deepEqual(await client.readJson(response), { ok: true });
  }
  session.end(); await journal.flush();
  assert.equal(observed.length, requests.length);
  observed.forEach((request, index) => assert.deepEqual(request.body, Buffer.from(requests[index].body)));
  assert.equal(observed[0].headers['x-encoded'], encoded(headerText));
  const events = journal.exportNDJSON().trim().split('\n').map(JSON.parse);
  const starts = events.filter(event => event.event_type === 'http.request.started');
  for (let index = 0; index < starts.length; index++) {
    const spec = requests[index], bodyEvent = events.find(event => event.event_type === 'http.body.captured' && event.data.direction === 'request' && event.context.span_id === starts[index].context.span_id);
    // Supported JSON uses the actual SDK observation, including its redaction.
    if (spec.truncated) { bodyEvent.data.body.truncated = true; bodyEvent.data.body.reason = 'body_limit'; }
    if (spec.partial) { bodyEvent.data.body.reason = 'partial_read'; }
    if (spec.media === 'application/json' && !spec.storageEncoding) continue;
    const bytes = observed[index].body;
    Object.assign(bodyEvent.data.body, { availability: 'captured', representation: 'application', media_type: spec.media, charset: spec.path === '/binary' ? null : 'utf-8', observed_bytes: bytes.length, total_bytes: bytes.length, stored_bytes: bytes.length, redacted: false, truncated: false, reason: null, content: { encoding: spec.storageEncoding || 'utf-8', data: spec.storageEncoding === 'base64' ? bytes.toString('base64') : bytes.toString('utf8') } });
  }
  const primaryText = events.map(JSON.stringify).join('\n') + '\n';
  assert.deepEqual(validateCapture(primaryText).errors, []);
  const primary = sequencesFromCapture(events)[0];
  await writeFile(join(artifacts, 'capture.ndjson'), primaryText);
  await buildViewer();
  collector = await startCollector({ directory: join(privateDir, 'collector'), port: 0, activate: false });
  const source = await collector.enroll({ version: 2, registration_id: randomUUID(), platform: 'web', environment_id: randomUUID(), environment_name: 'Base64 fixture', app_id: 'dev.base64.fixture', installation_id: randomUUID(), journal_id: journal.identity.journal_id, instance_id: journal.identity.instance_id, origin });
  await collector.ingest(source.source_token, primaryText);
  browser = await chromium.launch({ channel: process.env.WEB_TEST_CHANNEL || 'chrome', headless: true });
  evidence.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); page.on('pageerror', error => evidence.errors.push(error.message));
  let dialogs = 0; page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
  async function screenshot(name) { await page.screenshot({ path: join(artifacts, name + '.png'), fullPage: true }); evidence.screenshots.push(name + '.png'); }
  async function openRequest(path) {
    const close = page.getByRole('button', { name: 'Close inspector', exact: true }); if (await close.count()) await close.click();
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await page.locator('.list-row').filter({ has: page.locator('strong', { hasText: 'POST ' + path }) }).click();
    await expect(page.getByRole('region', { name: 'Details inspector', exact: true })).toBeVisible();
  }
  const inspector = page.getByRole('region', { name: 'Details inspector', exact: true });
  const body = () => inspector.locator('section.payload').filter({ has: page.getByRole('heading', { name: /Request body/ }) });
  async function decodeIn(scope, decodedText) {
    await expect(scope).toContainText('Base64');
    const control = scope.getByRole('button', { name: 'Decode', exact: true });
    await expect(control).toBeVisible(); await control.click();
    await expect(scope).toContainText(decodedText);
    await expect(scope.getByRole('button', { name: 'Encoded', exact: true })).toBeVisible();
    await scope.getByRole('button', { name: 'Encoded', exact: true }).click();
  }
  await page.goto(collector.origin); await expect(page.locator('.view-controls')).toContainText('9 of 9 requests');
  await openRequest('/json');
  const query = inspector.locator('tr').filter({ has: page.locator('th', { hasText: /^encoded$/ }) });
  await decodeIn(query, queryText); await expect(query).toContainText(encoded(queryText));
  const repeated = inspector.locator('tr').filter({ has: page.locator('th', { hasText: /^repeat$/ }) });
  await expect(repeated).toHaveCount(2);
  await decodeIn(repeated.nth(0), 'first repeated value'); await decodeIn(repeated.nth(1), 'second repeated value');
  await decodeIn(inspector.locator('tr').filter({ has: page.locator('th', { hasText: /^padded$/ }) }), '1');
  const header = inspector.locator('tr').filter({ has: page.locator('th', { hasText: /^x-encoded$/ }) });
  await decodeIn(header, headerText); await expect(header).toContainText(encoded(headerText));
  await decodeIn(inspector.locator('tr').filter({ has: page.locator('th', { hasText: /^x-basic$/ }) }), 'Basic fixture:user credential');
  for (const name of ['plain', 'short', 'invalidpad', 'x-plain', 'authorization']) {
    const row = inspector.locator('tr').filter({ has: page.locator('th', { hasText: new RegExp('^' + name + '$') }) });
    await expect(row.getByRole('button', { name: 'Decode', exact: true })).toHaveCount(0);
  }
  await decodeIn(body(), nestedText);
  await body().getByRole('button', { name: 'Decode', exact: true }).click();
  await body().getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(body()).toContainText(unicodeText); await expect(body()).toContainText(hostileText);
  assert.equal(await body().locator('img').count(), 0); assert.equal(dialogs, 0);
  await screenshot('desktop-json-decoded');
  await body().getByRole('button', { name: 'Copy', exact: true }).click();
  const storedBody = events.find(event => event.event_type === 'http.body.captured' && event.data.direction === 'request').data.body.content.data;
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), storedBody);
  await inspector.getByRole('tab', { name: 'Raw events', exact: true }).click();
  await expect(inspector.getByRole('button', { name: 'Decode', exact: true })).toHaveCount(0);
  await expect(inspector).toContainText(encoded(nestedText));
  evidence.scenarios.push('Actual SDK encoded/repeated/short-padded query/header and nested JSON values; plain/short/redacted negatives; UTF-8 and inert HTML; raw body/URL Copy and Raw events preserve capture; selecting another request resets preview.');
  for (const [path, decoded] of [['/form', formText], ['/raw', rawText], ['/transport', 'transport decoded text']]) {
    await openRequest(path); await decodeIn(body(), decoded);
    if (path === '/form') {
      await body().getByRole('button', { name: 'Decode', exact: true }).click();
      await body().getByRole('button', { name: 'Expand', exact: true }).click();
      await expect(body()).toContainText('second repeated form value');
      const previewText = await body().locator('pre').textContent(); assert.ok(previewText.indexOf(formText) < previewText.indexOf('second repeated form value'));
    }
    await screenshot(path.slice(1));
  }
  for (const path of ['/plain', '/binary', '/redacted', '/truncated', '/partial']) { await openRequest(path); await expect(inspector.getByRole('button', { name: 'Decode', exact: true })).toHaveCount(0); await expect(inspector.locator('.base64-control')).toHaveCount(0); }
  evidence.scenarios.push('Fixture-observed form, whole raw and explicit Base64 UTF-8 transport bodies; ordinary/UUID/hex/malformed/binary/redacted/truncated/partial values expose no decode controls.');
  await openRequest('/json'); await expect(query.getByRole('button', { name: 'Decode', exact: true })).toBeVisible(); await expect(query).toContainText(encoded(queryText)); await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog', { name: 'Request and invocation details', exact: true })).toBeVisible();
  const mobileControl = query.getByRole('button', { name: 'Decode', exact: true }); await mobileControl.focus(); await mobileControl.press('Enter');
  await expect(query).toContainText(queryText); await expect(query.getByRole('button', { name: 'Encoded', exact: true })).toBeFocused();
  await inspector.getByRole('button', { name: 'Copy URL', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), starts[0].data.request.url);
  await screenshot('mobile-query-decoded');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await inspector.getByRole('button', { name: 'Close inspector', exact: true }).click(); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'HTTP requests', exact: true }).click();
  const preview = page.getByLabel('HTTP request file', { exact: true }); const exportText = await preview.textContent();
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .http', exact: true }).click(); const download = await pending; const exportPath = join(artifacts, 'original.http'); await download.saveAs(exportPath);
  assert.equal(await readFile(exportPath, 'utf8'), exportText); assert.ok(exportText.includes(encoded(nestedText))); assert.ok(!exportText.includes(nestedText));
  evidence.scenarios.push('390px keyboard decode toggle and original HTTP preview/download preservation.');

  const secondaryEvents = structuredClone(events);
  for (const event of secondaryEvents) { event.session_id = 'secondary'; event.recording_id = 'secondary:' + event.recording_id; event.event_id = 'secondary:' + event.event_id; }
  const secondary = sequencesFromCapture(secondaryEvents)[0], expected = diffSequences(primary, secondary);
  await page.getByRole('button', { name: 'Compare with…', exact: true }).click();
  await page.getByLabel('Import secondary files', { exact: true }).setInputFiles({ name: 'secondary.ndjson', mimeType: 'application/x-ndjson', buffer: Buffer.from(secondaryEvents.map(JSON.stringify).join('\n') + '\n') });
  await page.locator('.comparison-session-option').filter({ hasText: 'base64/acceptance / secondary' }).click();
  await expect(page.getByLabel('Comparison summary')).toContainText(expected.result === 'equal' ? 'Equal within scope' : 'Inconclusive');
  const pair = expected.pairs.find(item => item.primary?.label.endsWith('/json'));
  assert.ok(pair);
  await page.locator(`.nll-cmp-layouts [data-pair-id="${pair.id}"]`).first().click();
  await page.getByRole('tab', { name: 'Request', exact: true }).click();
  const paired = page.locator('.pair-inspector-content');
  await expect(paired.getByRole('button', { name: 'Decode', exact: true }).first()).toBeVisible();
  const metadata = paired.locator('.paired-field').filter({ hasText: 'Request metadata, URL, repeated headers' }).locator('.paired-value.primary');
  await metadata.getByRole('button', { name: 'Decode', exact: true }).click();
  await expect(metadata).toContainText('decoded_query_parameters'); await expect(metadata).toContainText(queryText); await expect(metadata).toContainText(headerText);
  await expect(metadata).toContainText(starts[0].data.request.url);
  const pairedBody = paired.locator('.paired-field').filter({ hasText: 'Request body capture' }).locator('.paired-value.primary');
  await decodeIn(pairedBody, nestedText);
  await screenshot('comparison-request');
  await page.getByRole('tab', { name: 'Evidence', exact: true }).click();
  await expect(paired.getByRole('button', { name: 'Decode', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close paired inspector', exact: true }).click();
  const diffPending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export JSON', exact: true }).click(); const diffDownload = await diffPending; const diffPath = join(artifacts, 'comparison.diff.json'); await diffDownload.saveAs(diffPath);
  assert.deepEqual(JSON.parse(await readFile(diffPath, 'utf8')), expected);
  const snapshotsPending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export snapshots', exact: true }).click(); const snapshotsDownload = await snapshotsPending; const snapshotsPath = join(artifacts, 'comparison.snapshots.json'); await snapshotsDownload.saveAs(snapshotsPath);
  assert.deepEqual(JSON.parse(await readFile(snapshotsPath, 'utf8')), { primary, secondary });
  evidence.scenarios.push('Paired Request inspection detects and decodes captured values while evidence and exported diff/snapshots remain unchanged.');
  assert.deepEqual(evidence.errors, []); evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = error.stack; throw error; }
finally {
  await browser?.close(); await collector?.close();
  if (fixture) await new Promise(resolve => { fixture.close(resolve); fixture.closeAllConnections(); });
  await rm(privateDir, { recursive: true, force: true });
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
