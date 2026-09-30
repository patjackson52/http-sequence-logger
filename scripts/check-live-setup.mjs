import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { startCollector } from '../collector/server.mjs';
import { buildViewer } from '../collector/runtime.mjs';

const artifact = resolve('artifacts/live-setup'); await mkdir(artifact, { recursive: true });
const privateDir = await mkdtemp(join(tmpdir(), 'live-viewer-'));
const lines = (await readFile('examples/handler-http.ndjson', 'utf8')).trim().split('\n');
let collector, browser, foreign;
try {
  await buildViewer();
  collector = await startCollector({ directory: join(privateDir, 'first'), port: 0 });
  const origin = collector.origin, port = Number(new URL(origin).port);
  browser = await chromium.launch({ channel: process.env.WEB_TEST_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/');
  await expect(page.locator('.live-actions strong')).toHaveText('● Live · 0 events');
  assert.equal(new URL(page.url()).hash, '');
  collector.setDeviceStatus({ state: 'connected', label: 'Test phone', message: 'USB connected · paired automatically' });
  await expect(page.locator('.device-status')).toContainText('Test phone');
  collector.ingest(lines.slice(0, 5).join('\n') + '\n');
  await expect(page.getByRole('heading', { name: 'handler-http', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Select exchange/ }).first().click();
  await page.getByRole('searchbox').fill('/todos/1');
  const selected = await page.locator('.nll-seq-target[aria-pressed=true]').first().getAttribute('data-entity-id');
  collector.ingest(lines.slice(5).join('\n') + '\n');
  await expect(page.locator('.live-actions strong')).toHaveText(`● Live · ${lines.length} events`);
  await expect(page.getByRole('searchbox')).toHaveValue('/todos/1');
  await expect(page.locator('.nll-seq-target[aria-pressed=true]').first()).toHaveAttribute('data-entity-id', selected);
  await page.reload();
  await expect(page.locator('.live-actions strong')).toHaveText(`● Live · ${lines.length} events`);
  assert.equal(new URL(page.url()).hash, '');
  assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);

  await collector.close();
  await expect(page.locator('.live-actions strong')).toContainText('Reconnecting');
  collector = await startCollector({ directory: join(privateDir, 'first'), port });
  await expect(page.locator('.live-actions strong')).toHaveText(`● Live · ${lines.length} events`, { timeout: 20000 });
  await collector.close();
  collector = await startCollector({ directory: join(privateDir, 'second'), port });
  await expect(page.locator('.live-actions strong')).toHaveText('● Live · 0 events', { timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'handler-http', exact: true })).toHaveCount(0);
  await page.getByLabel('Choose NDJSON files', { exact: true }).setInputFiles(resolve('examples/handler-no-http.ndjson'));
  await page.locator('.import-session').getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await expect(page.locator('.live-actions strong')).toHaveText('● Live · 0 events');
  await expect(page.getByRole('heading', { name: 'handler-no-http', exact: true })).toHaveCount(0);
  collector.ingest(lines.join('\n') + '\n');
  await expect(page.getByRole('heading', { name: 'handler-http', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Pause live', exact: true }).click();
  await expect(page.getByText('Live updates paused', { exact: true })).toBeVisible();
  const extra = await readFile('examples/retry.ndjson', 'utf8'); collector.ingest(extra);
  await expect(page.locator('.session-nav .session-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await expect(page.locator('.session-nav .session-row')).toHaveCount(2);
  await page.getByLabel('Choose NDJSON files', { exact: true }).setInputFiles(resolve('examples/handler-no-http.ndjson'));
  await page.locator('.import-session').getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByText('Live updates paused', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'handler-no-http', exact: true })).toBeVisible();
  collector.ingest(await readFile('examples/cancelled.ndjson', 'utf8'));
  await expect(page.getByRole('heading', { name: 'handler-no-http', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await expect(page.locator('.session-nav .session-row')).toHaveCount(3);
  await page.goto('about:blank');
  await page.goto(origin + '/#collector=stale-link');
  await expect(page.locator('.live-actions strong')).toContainText('● Live');
  assert.equal(new URL(page.url()).hash, '');

  await expect(page.getByLabel('Follow newest session')).toBeChecked();
  collector.ingest(await readFile('examples/timeout.ndjson', 'utf8'));
  await expect(page.getByRole('heading', { name: 'timeout', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Select exchange/ }).first().click();
  await expect(page.getByLabel('Follow newest session')).not.toBeChecked();
  collector.ingest(await readFile('examples/handler-throw.ndjson', 'utf8'));
  await expect(page.locator('.session-nav .session-row')).toHaveCount(5);
  await expect(page.getByRole('heading', { name: 'timeout', exact: true })).toBeVisible();
  await page.getByLabel('Follow newest session').check();
  await expect(page.getByRole('heading', { name: 'handler-throw', exact: true })).toBeVisible();

  const localhost = await context.newPage();
  await localhost.goto(`http://localhost:${port}/`);
  await expect(localhost.locator('.live-actions strong')).toContainText('● Live');
  await localhost.close();
  // An unrelated website must not acquire the browser credential, even on loopback.
  foreign = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Foreign origin</title>'); });
  await new Promise(ok => foreign.listen(0, '127.0.0.1', ok));
  const hostile = await context.newPage();
  await hostile.goto(`http://127.0.0.1:${foreign.address().port}/`);
  const blocked = await hostile.evaluate(async origin => {
    try { await fetch(origin + '/api/v1/viewer-session', { headers: { 'X-Network-Log-Viewer': '1' } }); return false; } catch { return true; }
  }, origin);
  assert.equal(blocked, true);
  await page.screenshot({ path: join(artifact, 'automatic-live.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const result = { browser: browser.version(), checks: ['plain URL automatic connection', 'empty collector waiting state', 'device status updates', 'incremental events preserve selection and search', 'refresh without token URL or browser storage', 'same-directory restart', 'new collector identity resets rows', 'pause/resume', 'file import stays separate', 'resume to empty collector clears file view', 'follow newest sessions without interrupting inspection', 'legacy link recovery', 'localhost alias', 'foreign-origin bootstrap rejected'], errors };
  await writeFile(join(artifact, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS Chrome ${result.browser}: ${result.checks.length} automatic live-setup checks`);
} finally {
  await browser?.close(); await collector?.close();
  if (foreign) await new Promise(ok => { foreign.close(ok); foreign.closeAllConnections(); });
  await rm(privateDir, { recursive: true, force: true });
}
