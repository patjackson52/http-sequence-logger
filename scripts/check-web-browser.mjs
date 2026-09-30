// Isolated browser integration test; never attaches to a user's Chrome profile.
import { chromium } from '@playwright/test';
import { createServer, preview } from 'vite';
import { startCollector } from '../collector/server.mjs';
import { startFixtures } from '../web-sample/fixture-server.mjs';
import { validateCapture } from '../shared/validate.mjs';
import { mkdir, mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const artifact = resolve('artifacts/web-browser'); await mkdir(artifact, { recursive: true });
const privateDir = await mkdtemp(join(tmpdir(), 'network-log-browser-'));
let collector, server, browser, production, closeFixtures;
const configFile = resolve('web-sample/vite.config.mjs');
try {
  collector = await startCollector({ directory: privateDir, port: 0 });
  const port = Number(new URL(collector.origin).port);
  const connectionFile = join(privateDir, 'connection.json');
  await writeFile(connectionFile, JSON.stringify(collector.connections[0]), { mode: 0o600 });
  process.env.NETWORK_LOG_CONNECTION = connectionFile;
  server = await createServer({ configFile, logLevel: 'error' }); await server.listen();
  browser = await chromium.launch({ channel: process.env.WEB_TEST_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4180');
  await page.locator('#capture-status').waitFor();
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('Demo Person') && !document.querySelector('#run').disabled);
  async function exportCapture(path) {
    const downloadPromise = page.waitForEvent('download'); await page.locator('#download').click(); const download = await downloadPromise; await download.saveAs(path); return readFile(path, 'utf8');
  }
  const authPath = join(artifact, 'browser-auth-recovery.ndjson'), auth = await exportCapture(authPath);
  const authResult = validateCapture(auth); assert.deepEqual(authResult.errors, []); assert.deepEqual(authResult.warnings, []);
  assert.equal(authResult.summary.requests, 6); assert.equal(authResult.summary.failed_requests, 1); assert.equal(authResult.summary.handler_calls, 1); assert.equal(authResult.summary.origins.length, 2);
  for (const secret of ['SAMPLE_PASSWORD_SENTINEL', 'SAMPLE_REFRESH_SENTINEL', 'DEMO_TOKEN_DO_NOT_SHIP']) assert.ok(!auth.includes(secret));
  await page.locator('#checks').click();
  await page.waitForFunction(() => /PASS IndexedDB reload|FAIL/.test(document.querySelector('#check-status').textContent));
  const checkText = await page.locator('#check-status').innerText(); assert.ok(!checkText.includes('FAIL'), checkText);
  await page.waitForFunction(() => !document.querySelector('#checks').disabled);
  const fullPath = join(artifact, 'browser-multi-session.ndjson'), full = await exportCapture(fullPath);
  assert.deepEqual(validateCapture(full).errors, []);
  await page.reload(); await page.locator('#capture-status').waitFor();
  assert.equal(await exportCapture(join(artifact, 'reloaded.ndjson')), full);
  await page.locator('#upload').click();
  await page.waitForFunction(() => document.querySelector('#capture-status').textContent.startsWith('Delivered'));
  const count = collector.store.cursor; assert.equal(count, validateCapture(full).summary.events);
  await page.locator('#upload').click(); await page.waitForFunction(() => !document.querySelector('#upload').disabled);
  assert.equal(collector.store.cursor, count);
  await collector.close(); collector = null;
  await page.locator('#upload').click(); await page.waitForFunction(() => document.querySelector('#capture-status').textContent.startsWith('Action failed'));
  collector = await startCollector({ directory: privateDir, port });
  await page.locator('#upload').click(); await page.waitForFunction(() => document.querySelector('#capture-status').textContent.startsWith('Delivered'));
  assert.equal(collector.store.cursor, count);
  const viewer = await context.newPage(); await viewer.goto(collector.viewerURL);
  // Live viewing follows the newest session; select the auth flow for this inspection.
  await viewer.locator('.session-nav .session-row').filter({ hasText: 'Browser SDK auth with recovery' }).click();
  await viewer.getByRole('heading', { name: 'Browser SDK auth with recovery', exact: true }).waitFor();
  await viewer.getByText('Client', { exact: true }).waitFor();
  await viewer.screenshot({ path: join(artifact, 'viewer.png'), fullPage: true });
  await viewer.getByRole('button', { name: /Local call from SDK/ }).first().click();
  await viewer.getByText(/^Awaited handler invocation\./).waitFor();
  await viewer.screenshot({ path: join(artifact, 'inspector.png'), fullPage: true });
  await page.screenshot({ path: join(artifact, 'sample.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await server.close(); server = null;
  closeFixtures = await startFixtures();
  production = await preview({ configFile, mode: 'production', preview: { host: '127.0.0.1', port: 4180, strictPort: true }, logLevel: 'error' });
  await page.goto('http://127.0.0.1:4180'); assert.equal(await page.locator('#capture-status').count(), 0);
  await page.locator('#run').click(); await page.waitForFunction(() => document.querySelector('#result').textContent.includes('Demo Person'));
  assert.equal(collector.store.cursor, count); assert.deepEqual(errors, []);
  const evidence = { browser: await browser.version(), date: new Date().toISOString(), auth: authResult.summary, combined: validateCapture(full).summary, checks: ['native Fetch/XHR and awaited handler', 'manual custom HTTP', 'opaque response', 'AbortError', 'parse failure after HTTP EOF', 'unread response', 'IndexedDB close/reopen and page reload', 'NDJSON download', 'relay upload, duplicate replay, offline recovery', 'live viewer import', 'production no-op sign-in succeeds'], browserChecks: checkText.split('\n') };
  await writeFile(join(artifact, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (process.env.UPDATE_WEB_SAMPLES === '1') {
    await mkdir('samples/web', { recursive: true });
    await copyFile(authPath, 'samples/web/browser-auth-recovery.ndjson'); await copyFile(fullPath, 'samples/web/browser-multi-session.ndjson');
    await writeFile('samples/web/manifest.json', JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(`PASS Chrome ${evidence.browser}: ${count} events, native browser capture/persistence/transfer/viewer and production no-op flow`);
} finally {
  delete process.env.NETWORK_LOG_CONNECTION;
  await browser?.close(); await server?.close(); closeFixtures?.();
  if (production) await new Promise(resolve => { production.httpServer.close(resolve); production.httpServer.closeAllConnections(); });
  await collector?.close(); await rm(privateDir, { recursive: true, force: true });
}
