// Isolated browser integration test; never attaches to a user's Chrome profile.
import { chromium, firefox, webkit } from '@playwright/test';
import http from 'node:http';
import {createNetworkLogRelay} from '../web-sdk/dev-relay.mjs';
import { createServer, preview } from 'vite';
import { startCollector } from '../collector/server.mjs';
import { startFixtures } from '../web-sample/fixture-server.mjs';
import { validateCapture } from '../shared/validate.mjs';
import { mkdir, mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const artifact = resolve('artifacts/web-browser',process.env.WEB_TEST_ENGINE||'chrome'); await mkdir(artifact, { recursive: true });
const privateDir = await mkdtemp(join(tmpdir(), 'network-log-browser-'));
let collector, server, browser, production, closeFixtures, otherFrontend;
const configFile = resolve('web-sample/vite.config.mjs');
try {
  collector = await startCollector({ directory: privateDir, port: 0 });
  const port = Number(new URL(collector.origin).port);
  const connectionFile = join(privateDir, 'active.json');
  const ticket = await collector.store.ticket({principal:'web-test'});
  await writeFile(connectionFile, JSON.stringify({version:2,collector_id:collector.store.config.collector_id,endpoint:collector.origin,enrollment_token:ticket.enrollment_token}), {mode:0o600});
  process.env.NETWORK_LOG_CONNECTION = connectionFile;
  server = await createServer({ configFile, logLevel: 'error' }); await server.listen();
  const engine = process.env.WEB_TEST_ENGINE || 'chromium';
  const browserType = {chromium,firefox,webkit}[engine];
  browser = await browserType.launch({...(engine==='chromium'?{channel:process.env.WEB_TEST_CHANNEL||'chrome'}:{}), headless:true});
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4180');
  await page.locator('#capture-status').waitFor();
  await page.waitForFunction(()=>document.querySelector('#capture-status').textContent.startsWith('Ready and waiting'));
  assert.equal((await collector.store.sources()).sources.length,1);
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
  await page.waitForFunction(()=>document.querySelector('#capture-status').textContent.includes('persistedEvents'));
  assert.equal(await exportCapture(join(artifact, 'reloaded.ndjson')), full);
  await page.locator('#upload').click();
  await page.waitForFunction(() => document.querySelector('#capture-status').textContent.startsWith('Delivered'));
  let count = collector.store.cursor; assert.equal(count, validateCapture(full).summary.events);
  await page.locator('#upload').click(); await page.waitForFunction(() => !document.querySelector('#upload').disabled);
  assert.equal(collector.store.cursor, count);
  await collector.close(); collector = null;
  await page.locator('#upload').click(); await page.waitForFunction(() => document.querySelector('#capture-status').textContent.startsWith('Action failed'));
  collector = await startCollector({ directory: privateDir, port });
  const renewed = await collector.store.ticket({principal:'web-test'});
  await writeFile(connectionFile,JSON.stringify({version:2,collector_id:collector.store.config.collector_id,endpoint:collector.origin,enrollment_token:renewed.enrollment_token}),{mode:0o600});
  await page.locator('#upload').click(); await page.waitForFunction(() => document.querySelector('#capture-status').textContent.startsWith('Delivered'));
  assert.equal(collector.store.cursor, count);
  // A concurrent zero-event tab and a second origin/app share the same collector.
  const popupPromise=page.waitForEvent('popup');await page.evaluate(()=>window.open(location.href));const secondTab=await popupPromise;await secondTab.waitForLoadState();
  await secondTab.waitForFunction(()=>document.querySelector('#capture-status').textContent.startsWith('Ready and waiting'));
  assert.equal((await collector.store.sources()).sources.length,2);
  const otherOrigin='http://127.0.0.1:4183';
  const otherRelay=createNetworkLogRelay({origin:otherOrigin,connectionFile});
  otherFrontend=http.createServer((req,res)=>otherRelay(req,res,async()=>{
    if(req.url==='/') {res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Other debug app</title><body>Ready</body>');return;}
    if(/^\/web-sdk\/src\/[a-z-]+\.mjs$/.test(req.url)){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(resolve('.'+req.url)));return;}
    res.writeHead(404);res.end();
  }));
  await new Promise(resolve=>otherFrontend.listen(4183,'127.0.0.1',resolve));
  const otherPage=await context.newPage();await otherPage.goto(otherOrigin);
  await otherPage.evaluate(async()=>{
    const {IndexedDBJournal,createLogger,uploadJournal}=await import('/web-sdk/src/index.mjs');
    const journal=await IndexedDBJournal.open({databaseName:'other-debug-app-v2',journalId:crypto.randomUUID()});
    const logger=createLogger({namespace:'other.web.app',appId:'other-web-app',sink:journal});
    const session=logger.startSession({name:'Second origin session'});session.end();await journal.flush();
    await uploadJournal(journal,{appId:'other-web-app'});await journal.close();
  });
  const sources=(await collector.store.sources()).sources;assert.equal(sources.length,3);assert.equal(new Set(sources.map(s=>s.origin)).size,2);
  count=collector.store.cursor;await secondTab.close();await otherPage.close();
  const viewer = await context.newPage(); viewer.on('pageerror',error=>errors.push(error.message)); await viewer.goto(collector.viewerURL);
  // Live viewing follows the newest session; select the auth flow for this inspection.
  await viewer.locator('.source-navigation .session-row').filter({ hasText: 'Browser SDK auth with recovery' }).click();
  await viewer.getByRole('heading', {name:'Browser SDK auth with recovery',exact:true}).waitFor();
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
  const evidence = { browser: await browser.version(), date: new Date().toISOString(), auth: authResult.summary, combined: validateCapture(full).summary, checks: ['native Fetch/XHR and awaited handler', 'manual custom HTTP', 'opaque response', 'AbortError', 'parse failure after HTTP EOF', 'unread response', 'IndexedDB close/reopen and page reload', 'NDJSON download', 'incremental continuous delivery, cursor replay, offline recovery', 'concurrent zero-event tabs and two frontend origins/apps', 'live viewer import', 'production no-op sign-in succeeds'], browserChecks: checkText.split('\n') };
  await writeFile(join(artifact, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (process.env.UPDATE_WEB_SAMPLES === '1') {
    await mkdir('samples/web', { recursive: true });
    await copyFile(authPath, 'samples/web/browser-auth-recovery.ndjson'); await copyFile(fullPath, 'samples/web/browser-multi-session.ndjson');
    await writeFile('samples/web/manifest.json', JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(`PASS ${process.env.WEB_TEST_ENGINE || "Chrome"} ${evidence.browser}: ${count} events, native browser capture/persistence/transfer/viewer and production no-op flow`);
} finally {
  delete process.env.NETWORK_LOG_CONNECTION;
  await browser?.close(); await server?.close(); closeFixtures?.();
  if (production) await new Promise(resolve => { production.httpServer.close(resolve); production.httpServer.closeAllConnections(); });
  if(otherFrontend)await new Promise(resolve=>{otherFrontend.close(resolve);otherFrontend.closeAllConnections();});
  await collector?.close(); await rm(privateDir, { recursive: true, force: true });
}
