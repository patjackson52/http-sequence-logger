import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { startCollector } from '../collector/server.mjs';
import { buildViewer } from '../collector/runtime.mjs';

const artifact = resolve('artifacts/live-setup'); await mkdir(artifact, { recursive: true });
const privateDir = await mkdtemp(join(tmpdir(), 'live-viewer-'));
const lines = (await readFile('examples/handler-http.ndjson', 'utf8')).trim().split('\n');
let collector, browser, foreign, source;
const enroll = () => collector.enroll({version:2,registration_id:randomUUID(),platform:'android',environment_id:'test-phone',environment_name:'Test phone',app_id:'dev.viewer.test',installation_id:randomUUID()});
try {
  await buildViewer();
  collector = await startCollector({ directory: join(privateDir, 'first'), port: 0 });
  const origin = collector.origin, port = Number(new URL(origin).port);
  browser = await chromium.launch({ channel: process.env.WEB_TEST_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Hold real bootstrap retries so the intermediate UI state can be measured.
  let waitingRetry=false,releaseRetry,allowBootstrap=false;
  await page.route('**/api/v2/bootstrap',async route=>{
    if(allowBootstrap){await route.continue();return;}
    await new Promise(resolve=>{releaseRetry=resolve;waitingRetry=true;});
    waitingRetry=false;await route.fulfill({status:503,body:'Collector temporarily unavailable'});
  });
  await page.goto(origin + '/');
  await expect.poll(()=>waitingRetry).toBe(true);releaseRetry();
  await expect(page.locator('.live-panel')).toContainText('Waiting for the local collector');
  const failedPanel=await page.locator('.live-panel').boundingBox();
  for(let retry=0;retry<2;retry++){
    await expect.poll(()=>waitingRetry).toBe(true);
    await expect(page.locator('.live-actions strong')).toHaveText('◌ Reconnecting · 0 events');
    await expect(page.locator('.live-panel')).toContainText('Waiting for the local collector');
    assert.deepEqual(await page.locator('.live-panel').boundingBox(),failedPanel,'Retry must not change panel geometry');
    releaseRetry();await expect.poll(()=>waitingRetry).toBe(false);
  }
  allowBootstrap=true;await page.unroute('**/api/v2/bootstrap');
  await expect(page.locator('.live-actions strong')).toHaveText('● Live · 0 events');
  assert.equal(new URL(page.url()).hash, '');
  collector.setAdapterStatus('android',{state:'waiting',reason:'Permission required',devices:[{serial:'unauthorized-usb',state:'unauthorized'}]});
  collector.setAdapterStatus('ios-simulator',{state:'waiting',reason:'0 booted simulators'});
  await expect(page.locator('.device-status')).toContainText('unauthorized-usb (unauthorized)');
  await expect(page.locator('.device-status')).toContainText('0 booted simulators');
  const invitationResponse=page.waitForResponse(response=>response.url().endsWith('/api/v2/admin/enrollment')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Pair another device',exact:true}).click();
  assert.equal((await invitationResponse).status(),200);
  await expect(page.getByRole('button',{name:'Copy pairing JSON',exact:true})).toBeVisible();
  await expect(page.locator('.pairing-options')).toContainText('expires in ten minutes');
  await page.getByRole('button',{name:'Close pairing',exact:true}).click();
  source = await enroll();
  await enroll();
  await expect(page.locator('.source-navigation')).toContainText('Installation');
  await expect(page.locator('.source-navigation')).toContainText('Test phone');
  await expect(page.locator('.source-navigation')).toContainText('dev.viewer.test');
  await expect(page.locator('.source-navigation')).toContainText('Ready and waiting for events');
  await collector.ingest(source.source_token, lines.slice(0, 5).join('\n') + '\n');
  await expect(page.getByRole('heading', { name: 'handler-http', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Select exchange/ }).first().click();
  await page.getByRole('searchbox').fill('/todos/1');
  const selected = await page.locator('.nll-seq-target[aria-pressed=true]').first().getAttribute('data-entity-id');
  await collector.ingest(source.source_token, lines.slice(5).join('\n') + '\n');
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
  await page.getByLabel('Follow newest session').uncheck();
  await page.getByRole('button',{name:'Pause live',exact:true}).click();
  await collector.close();
  collector = await startCollector({ directory: join(privateDir, 'second'), port });
  await page.getByRole('button',{name:'Resume live',exact:true}).click();
  await expect(page.getByLabel('Follow newest session')).not.toBeChecked();
  source = await enroll();
  await expect(page.locator('.live-actions strong')).toHaveText('● Live · 0 events', { timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'handler-http', exact: true })).toHaveCount(0);
  await page.getByLabel('Choose NDJSON files', { exact: true }).setInputFiles(resolve('examples/handler-no-http.ndjson'));
  await page.locator('.import-session').getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await expect(page.locator('.live-actions strong')).toHaveText('● Live · 0 events');
  await expect(page.getByRole('heading', { name: 'handler-no-http', exact: true })).toHaveCount(0);
  await collector.ingest(source.source_token, lines.join('\n') + '\n');
  await expect(page.getByRole('heading', { name: 'handler-http', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Pause live', exact: true }).click();
  await expect(page.getByText('Live updates paused', { exact: true })).toBeVisible();
  const extra = await readFile('examples/retry.ndjson', 'utf8'); await collector.ingest(source.source_token, extra);
  await expect(page.locator('.session-nav .session-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await expect(page.locator('.session-nav .session-row')).toHaveCount(2);
  await expect(page.getByLabel('Follow newest session')).not.toBeChecked();
  await collector.ingest(source.source_token,await readFile('examples/redacted-truncated.ndjson','utf8'));
  await expect(page.locator('.session-nav .session-row')).toHaveCount(3);
  await expect(page.getByRole('heading',{name:'retry',exact:true})).toBeVisible();
  await page.getByLabel('Choose NDJSON files', { exact: true }).setInputFiles(resolve('examples/handler-no-http.ndjson'));
  await page.locator('.import-session').getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByText('Live updates paused', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'handler-no-http', exact: true })).toBeVisible();
  await collector.ingest(source.source_token, await readFile('examples/cancelled.ndjson', 'utf8'));
  await expect(page.getByRole('heading', { name: 'handler-no-http', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await expect(page.locator('.session-nav .session-row')).toHaveCount(4);
  await page.getByLabel('Follow newest session').check();
  await expect(page.getByLabel('Follow newest session')).toBeChecked();
  await collector.ingest(source.source_token, await readFile('examples/timeout.ndjson', 'utf8'));
  await expect(page.getByRole('heading', { name: 'timeout', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Select exchange/ }).first().click();
  await expect(page.getByLabel('Follow newest session')).not.toBeChecked();
  await collector.ingest(source.source_token, await readFile('examples/handler-throw.ndjson', 'utf8'));
  await expect(page.locator('.session-nav .session-row')).toHaveCount(6);
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
    try { await fetch(origin + '/api/v2/bootstrap', { headers: { 'X-Network-Log-Viewer': '1' } }); return false; } catch { return true; }
  }, origin);
  assert.equal(blocked, true);
  await page.screenshot({ path: join(artifact, 'automatic-live.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const result = { browser: browser.version(), checks: ['bootstrap retry preserves error and panel geometry until live recovery', 'plain URL automatic connection', 'empty collector waiting state', 'zero-event source registration and device/app navigation', 'adapter diagnostics before events', 'fresh one-installation pairing action', 'multiple installations distinguished', 'incremental events preserve selection and search', 'refresh without token URL or browser storage', 'same-directory restart', 'new collector identity resets rows', 'pause/replacement/resume respects disabled following', 'pause/resume', 'file import stays separate', 'resume to empty collector clears file view', 'follow newest sessions without interrupting inspection', 'localhost alias', 'foreign-origin bootstrap rejected'], errors };
  await writeFile(join(artifact, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS Chrome ${result.browser}: ${result.checks.length} automatic live-setup checks`);
} finally {
  await browser?.close(); await collector?.close();
  if (foreign) await new Promise(ok => { foreign.close(ok); foreign.closeAllConnections(); });
  await rm(privateDir, { recursive: true, force: true });
}
