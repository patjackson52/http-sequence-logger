import assert from 'node:assert/strict';
import { firefox, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateCapture } from '../shared/validate.mjs';

const directory = await mkdtemp(join(tmpdir(), 'web-storage-denied-'));
const artifacts = resolve('artifacts/web-storage-denied'); await mkdir(artifacts, { recursive: true });
const previous = process.env.NETWORK_LOG_CONNECTION;
process.env.NETWORK_LOG_CONNECTION = join(directory, 'absent-active.json');
const evidence = { kind: 'Actual Firefox browser storage disabled by browser preferences; app business flow and sanitized memory export', errors: [] };
let browser, server;
try {
  server = await createServer({ configFile: resolve('web-sample/vite.config.mjs'), logLevel: 'error' }); await server.listen();
  browser = await firefox.launch({ headless: true, firefoxUserPrefs: { 'dom.storage.enabled': false, 'network.cookie.cookieBehavior': 2 } });
  evidence.browser = browser.version();
  const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.goto('http://127.0.0.1:4180');
  evidence.storage = await page.evaluate(async () => {
    const out = {};
    try { sessionStorage.setItem('storage-denial-probe', 'test'); out.sessionStorage = 'available'; } catch (error) { out.sessionStorage = error.name; }
    try { await new Promise((ok, fail) => { const request = indexedDB.open('storage-denial-probe'); request.onsuccess = () => { request.result.close(); ok(); }; request.onerror = () => fail(request.error); }); out.indexedDB = 'available'; } catch (error) { out.indexedDB = error.name; }
    return out;
  });
  assert.notEqual(evidence.storage.sessionStorage, 'available');
  assert.notEqual(evidence.storage.indexedDB, 'available');
  await expect(page.locator('#capture-status')).toContainText('Memory fallback', { timeout: 5000 });
  await page.locator('#run').click();
  await expect(page.locator('#result')).toContainText('Demo Person', { timeout: 15000 });
  await expect(page.locator('#run')).toBeEnabled();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#download').click();
  const download = await downloadPromise, capturePath = join(artifacts, 'memory.ndjson'); await download.saveAs(capturePath);
  const capture = await readFile(capturePath, 'utf8'), validated = validateCapture(capture);
  assert.deepEqual(validated.errors, []); assert.deepEqual(validated.warnings, []);
  assert.equal(validated.summary.requests, 6); assert.equal(validated.summary.handler_calls, 1);
  for (const secret of ['SAMPLE_PASSWORD_SENTINEL', 'SAMPLE_REFRESH_SENTINEL', 'DEMO_TOKEN_DO_NOT_SHIP']) assert.ok(!capture.includes(secret));
  assert.deepEqual(evidence.errors, []);
  evidence.events = validated.summary.events;
  evidence.passed = true;
  await page.screenshot({ path: join(artifacts, 'memory-fallback.png'), fullPage: true });
} catch (error) {
  evidence.passed = false; evidence.error = error.message; throw error;
} finally {
  await browser?.close(); await server?.close();
  if (previous === undefined) delete process.env.NETWORK_LOG_CONNECTION; else process.env.NETWORK_LOG_CONNECTION = previous;
  await rm(directory, { recursive: true, force: true });
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
