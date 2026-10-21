import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startCollector } from '../collector/server.mjs';
import { buildViewer } from '../collector/runtime.mjs';

// Sidebar log explorer acceptance in installed Chrome. showDirectoryPicker is stubbed to an
// origin-private (OPFS) directory so the real File System Access handle/IndexedDB paths run.
const artifact = resolve(process.env.LOG_EXPLORER_ARTIFACTS || 'artifacts/log-explorer'); await mkdir(artifact, { recursive: true });
const privateDir = await mkdtemp(join(tmpdir(), 'log-explorer-'));
const example = name => readFile(`examples/${name}.ndjson`, 'utf8');
// Distinct session start times make newest-first ordering observable.
const startAt = (text, timestamp, name) => { const [first, ...rest] = text.split('\n'), event = JSON.parse(first); return [JSON.stringify({ ...event, timestamp, data: { ...event.data, name: name ?? event.data.name } }), ...rest].join('\n'); };
const longName = 'Checkout with saved card, address change and a very long descriptive session name';
const fixtures = { 'logs/checkout.ndjson': startAt(await example('success'), '2026-09-28T10:00:00.000Z'), 'logs/multi.ndjson': await example('multi-session'), 'logs/retry.ndjson': startAt(await example('retry'), '2026-09-28T12:00:00.000Z'), 'logs/long-name.ndjson': startAt(await example('http-error'), '2026-09-27T08:00:00.000Z', longName), 'logs/notes.txt': 'not a log', 'logs/sub/timeout.ndjson': await example('timeout'), 'logs/sub/deeper/level3/deep.ndjson': startAt(await example('success'), '2026-09-26T08:00:00.000Z', 'deep-success'), 'logs/empty/readme.txt': 'no logs here', 'logs/empty/inner/notes.txt': 'still none' };
const machine = hostname().split('.')[0];
let collector, browser;
try {
  await buildViewer();
  collector = await startCollector({ directory: join(privateDir, 'collector'), port: 0, activate: false });
  const source = await collector.enroll({ version: 2, registration_id: randomUUID(), platform: 'android', environment_id: 'explorer-phone', environment_name: 'Explorer phone', app_id: 'dev.explorer.test', installation_id: randomUUID() });
  await collector.ingest(source.source_token, await example('handler-http'));
  browser = await chromium.launch({ channel: process.env.WEB_TEST_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('logs');
    // A sessionStorage flag simulates a restored handle whose read permission must be re-confirmed.
    const query = FileSystemHandle.prototype.queryPermission;
    FileSystemHandle.prototype.queryPermission = async function (options) { if (sessionStorage.getItem('explorer-permission') === 'prompt') return 'prompt'; return query ? query.call(this, options) : 'granted'; };
    FileSystemHandle.prototype.requestPermission = async function () { window.__permissionRequests = (window.__permissionRequests || 0) + 1; sessionStorage.removeItem('explorer-permission'); return 'granted'; };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(collector.origin + '/');
  await page.evaluate(async files => {
    const root = await navigator.storage.getDirectory();
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split('/'); let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable(); await writable.write(text); await writable.close();
    }
  }, fixtures);
  await expect(page.locator('.live-actions strong')).toContainText('● Live');
  await expect(page.getByRole('heading', { name: 'handler-http', exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Logs and sessions' });
  const machineNode = nav.locator('.tree-machine');
  const machineButton = machineNode.locator('.tree-section-head button');
  await expect(machineButton).toHaveText(`This machine · ${machine}`);
  await expect(machineButton).toHaveAttribute('title', hostname());
  await expect(nav.getByRole('heading', { level: 3, name: `This machine · ${machine}` })).toBeVisible();
  const liveRow = nav.locator('.live-session');
  await expect(liveRow).toHaveCount(1);
  await expect(liveRow.locator('.label')).toHaveText('handler-http');
  await expect(liveRow.locator('time')).toHaveText(/started \d\d:\d\d|started \w{3} \d\d:\d\d|started \w{3} \d+|started \d{4}-\d\d-\d\d/);
  await expect(liveRow).toHaveAttribute('aria-current', 'true');

  // Sections collapse and expand; the state is shared with the sheet instance.
  const sessionsSummary = nav.locator('.tree-section-head button').filter({ hasText: 'Sessions' });
  await expect(sessionsSummary).toHaveAttribute('aria-expanded', 'true');
  await sessionsSummary.click();
  await expect(sessionsSummary).toHaveAttribute('aria-expanded', 'false');
  await expect(liveRow).toHaveCount(0);
  await sessionsSummary.click();
  await expect(liveRow).toHaveCount(1);
  const devicesSummary = nav.locator('.tree-section-head button').filter({ hasText: 'Devices and environments' });
  await devicesSummary.click();
  await expect(nav.locator('.source-row')).toHaveCount(0);
  await devicesSummary.click();
  await expect(nav.locator('.source-row')).toHaveCount(1);

  await nav.getByRole('button', { name: 'Add folder…' }).click();
  const folder = machineNode.locator('.tree-root-folder');
  await expect(folder).toHaveCount(1);
  await expect(folder.locator('> summary .name')).toHaveText('logs/');
  await expect(folder.locator('> summary')).toBeFocused();
  const rows = folder.locator(':scope > .log-row');
  await expect(rows).toHaveCount(4);
  assert.deepEqual(await rows.locator('.label').allTextContents(), ['multi-android', 'retry', 'success', longName], 'newest session start first');
  // 236px navigator: long names ellipsize while the time stays fully visible inside the row.
  const long = rows.filter({ hasText: 'Checkout with saved card' });
  assert.ok(await long.locator('.label').evaluate(node => node.scrollWidth > node.clientWidth), 'long name is truncated');
  const [rowBox, timeBox] = [await long.boundingBox(), await long.locator('time').boundingBox()];
  assert.ok(timeBox.width > 20 && timeBox.x + timeBox.width <= rowBox.x + rowBox.width + 0.5, 'time is not clipped');
  assert.equal(await nav.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'navigator has no horizontal overflow');
  for (const row of await rows.all()) await expect(row.locator('time')).toHaveText(/^started .+/);
  await expect(folder.locator('.log-row').filter({ hasText: 'multi-android' }).locator('.count')).toHaveText('+1');
  await expect(rows.first()).toHaveAttribute('title', /\.ndjson/);
  await expect(folder).not.toContainText('notes.txt');
  // The whole tree is scanned on add: nested logs are visible without expanding anything; empty folders are hidden.
  const sub = folder.locator('details.tree-folder').filter({ has: page.locator('summary', { hasText: 'sub/' }) });
  await expect(sub).toHaveCount(1);
  assert.equal(await sub.evaluate(node => node.open), true, 'subfolders with logs start open');
  await expect(sub.locator(':scope > .log-row .label')).toHaveText('timeout');
  const deep = sub.locator('details.tree-folder').filter({ has: page.locator('summary', { hasText: 'level3/' }) });
  await expect(deep.locator('.log-row .label')).toHaveText('deep-success');
  await expect(deep.locator('.log-row')).toBeVisible();
  await expect(folder.locator('.log-row')).toHaveCount(6);
  await expect(folder).not.toContainText('empty/');
  await expect(folder.locator('details.tree-folder > summary .name')).toHaveText(['sub/', 'deeper/', 'level3/']);
  await expect(folder.locator('> summary small')).toHaveText('6');
  // Collapsing a nested folder is user state; − and ↻ stay reachable on the collapsed root row.
  await sub.locator('> summary').click();
  await expect(sub.locator('.log-row')).toHaveCount(0);
  await sub.locator('> summary').click();
  await expect(deep.locator('.log-row')).toBeVisible();
  await folder.locator('> summary').click();
  await expect(nav.getByRole('button', { name: 'Remove folder logs' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Refresh folder logs' })).toBeVisible();
  const [summaryBox, removeBox] = [await folder.locator('> summary').boundingBox(), await nav.getByRole('button', { name: 'Remove folder logs' }).boundingBox()];
  assert.ok(removeBox.y >= summaryBox.y - 1 && removeBox.y + removeBox.height <= summaryBox.y + summaryBox.height + 1 && removeBox.x + removeBox.width <= summaryBox.x + summaryBox.width + 1, 'remove sits on the folder row');
  await folder.locator('> summary').click();
  await expect(rows).toHaveCount(4);
  await nav.getByRole('button', { name: 'Refresh folder logs' }).click();
  await expect(folder.locator('.log-row')).toHaveCount(6);
  await expect(folder.locator('> [role=status]')).toHaveCount(0);
  await page.mouse.move(700, 900);
  await page.screenshot({ path: join(artifact, 'explorer-desktop.png') });
  await nav.screenshot({ path: join(artifact, 'explorer-sidebar.png') });

  await rows.filter({ hasText: 'retry' }).click();
  await expect(page.getByRole('heading', { name: 'retry', exact: true })).toBeVisible();
  await expect(page.getByText('Live updates paused', { exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: 'retry' })).toHaveAttribute('aria-current', 'true');
  assert.equal(await nav.locator('[aria-current="true"]').count(), 1);
  assert.equal(await sub.evaluate(node => node.open), true, 'opening a log keeps tree expansion');
  await expect(nav.locator('.tree-section').first()).toContainText('Explorer phone');
  await expect(nav.locator('.source-row')).toHaveCount(1);
  await expect(liveRow).toHaveCount(1);
  await expect(nav.locator('h3').first()).toContainText('Paused');
  await expect(nav.locator('.tree-section-head > .tree-resume')).toHaveText('Resume live');
  // Resume live stays reachable on the header line when Devices is collapsed.
  await devicesSummary.click();
  await expect(nav.locator('.source-row')).toHaveCount(0);
  await expect(nav.locator('.tree-resume')).toBeVisible();
  await devicesSummary.click();

  await folder.locator('.log-row').filter({ hasText: 'multi-android' }).click();
  await expect(page.getByRole('heading', { name: 'multi-android', exact: true })).toBeVisible();
  const split = folder.locator('.tree-children .log-session');
  assert.ok(await split.count() > 1, 'opened multi-session file lists its sessions');
  await split.nth(1).click();
  await expect(split.nth(1)).toHaveAttribute('aria-current', 'true');

  await liveRow.click();
  await expect(page.locator('.live-actions strong')).toContainText('● Live');
  await expect(page.getByRole('heading', { name: 'handler-http', exact: true })).toBeVisible();
  await expect(liveRow).toHaveAttribute('aria-current', 'true');
  await expect(page.getByLabel('Follow newest session')).not.toBeChecked();

  await page.evaluate(() => sessionStorage.setItem('explorer-permission', 'prompt'));
  await page.reload();
  await expect(page.locator('.live-actions strong')).toContainText('● Live');
  const restored = page.getByRole('navigation', { name: 'Logs and sessions' }).locator('.tree-root-folder');
  await expect(restored).toHaveCount(1);
  await expect(restored.locator('> summary .name')).toHaveText('logs/');
  await expect(restored.locator('> summary small')).toHaveText('· access needed');
  await expect(restored.locator(':scope > .log-row')).toHaveCount(0);
  await restored.getByRole('button', { name: 'Reconnect', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__permissionRequests), 1);
  await expect(restored.locator(':scope > .log-row')).toHaveCount(4);
  await expect(restored.locator('.log-row')).toHaveCount(6);
  await expect(restored.locator('> summary small')).toHaveText('6');
  await restored.locator(':scope > .log-row').filter({ hasText: 'success' }).click();
  await expect(page.getByRole('heading', { name: 'success', exact: true })).toBeVisible();
  await expect(page.getByText('Live updates paused', { exact: true })).toBeVisible();
  await collector.ingest(source.source_token, await example('cancelled'));
  await page.locator('.session-nav .tree-resume').click();
  await expect(page.locator('.live-actions strong')).toContainText('● Live');
  await expect(page.locator('.session-nav .live-session')).toHaveCount(2);

  // Narrow layout uses the same tree inside the session sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.mobile-bar > button').first().click();
  const sheet = page.getByRole('dialog', { name: 'Open log or session' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.tree-root-folder > summary')).toBeVisible();
  // Expansion state is shared with the desktop navigator, so the folder is already open.
  assert.equal(await sheet.locator('.tree-root-folder').evaluate(node => node.open), true);
  await expect(sheet.locator('.tree-root-folder > .log-row')).toHaveCount(4);
  await expect(sheet.locator('.tree-root-folder .log-row')).toHaveCount(6);
  await expect(sheet.getByRole('button', { name: 'Remove folder logs' })).toBeVisible();
  await sheet.locator('.tree-section-head button').filter({ hasText: 'Sessions' }).click();
  await expect(sheet.locator('.live-session')).toHaveCount(0);
  await sheet.locator('.tree-section-head button').filter({ hasText: 'Sessions' }).click();
  await expect(sheet.locator('.live-session')).toHaveCount(2);
  await page.screenshot({ path: join(artifact, 'explorer-mobile-sheet.png') });
  const overflow = await sheet.evaluate(node => [...node.querySelectorAll('.tree-row,summary,.tree-section-head button')].filter(el => el.scrollWidth > el.clientWidth + 1 && !el.closest('.name')).length);
  assert.equal(overflow, 0, 'sheet rows do not overflow horizontally');
  await sheet.locator('.tree-root-folder .log-row').filter({ hasText: 'retry' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.mobile-bar strong')).toHaveText('retry');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.locator('.session-nav').getByRole('button', { name: 'Remove folder logs' }).click();
  await expect(page.locator('.session-nav .tree-root-folder')).toHaveCount(0);
  await expect(page.locator('.session-nav .tree-add')).toBeFocused();
  await page.reload();
  await expect(page.locator('.live-actions strong')).toContainText('● Live');
  await expect(page.locator('.tree-machine .tree-add')).toBeVisible();
  await expect(page.locator('.tree-root-folder')).toHaveCount(0);

  // Browsers without showDirectoryPicker fall back to a one-visit webkitdirectory snapshot.
  const snapshot = join(privateDir, 'snapshot', 'captures');
  await mkdir(join(snapshot, 'nested', 'two'), { recursive: true });
  await mkdir(join(snapshot, 'nothing'), { recursive: true });
  await writeFile(join(snapshot, 'nothing', 'readme.md'), '#');
  await writeFile(join(snapshot, 'nested', 'two', 'deep.ndjson'), fixtures['logs/sub/deeper/level3/deep.ndjson']);
  await writeFile(join(snapshot, 'retry.ndjson'), fixtures['logs/retry.ndjson']);
  await writeFile(join(snapshot, 'nested', 'timeout.ndjson'), fixtures['logs/sub/timeout.ndjson']);
  const fallbackContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await fallbackContext.addInitScript(() => { window.showDirectoryPicker = undefined; });
  const fallback = await fallbackContext.newPage();
  fallback.on('pageerror', error => errors.push(error.message));
  await fallback.goto(collector.origin + '/');
  await expect(fallback.locator('.live-actions strong')).toContainText('● Live');
  await expect(fallback.locator('.session-nav .tree-add')).toHaveText(/Add folder \(this visit only\)/);
  await fallback.locator('.session-nav input[webkitdirectory]').setInputFiles(snapshot);
  const snap = fallback.locator('.session-nav .tree-root-folder');
  await expect(snap.locator('> summary')).toContainText('captures/');
  await expect(snap.locator('> summary')).toContainText('this visit');
  await expect(snap.locator(':scope > .log-row .label')).toHaveText('retry');
  await expect(snap.locator('details.tree-folder > summary .name')).toHaveText(['nested/', 'two/']);
  await expect(snap.locator('details.tree-folder .log-row .label')).toHaveText(['deep-success', 'timeout']);
  await snap.locator(':scope > .log-row').click();
  await expect(fallback.getByRole('heading', { name: 'retry', exact: true })).toBeVisible();
  await fallback.reload();
  await expect(fallback.locator('.live-actions strong')).toContainText('● Live');
  await expect(fallback.locator('.session-nav .tree-root-folder')).toHaveCount(0);
  await fallbackContext.close();

  assert.deepEqual(errors, []);
  const result = { browser: browser.version(), checks: ['machine name label', 'live session name + time row', 'add folder via picker handle', 'folder rows labeled by session name + time, newest first', 'non-ndjson ignored', 'multi-session +N badge', 'recursive scan shows nested logs without expanding', 'empty folders hidden', 'nested collapse toggles', 'sections collapse (nav + sheet)', 'remove/refresh on collapsed folder row', 'refresh rescans tree', 'open log → workspace with aria-current', 'devices listed while paused', 'multi-session file lists sessions after open', 'live session click resumes live', 'reload restores folder from IndexedDB', 'prompt permission after reload → Reconnect grants and lists', 'explorer Resume live', 'mobile sheet tree', '− removes folder, focus moves, survives reload', 'webkitdirectory fallback snapshot nested + not persisted'], errors };
  await writeFile(join(artifact, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS Chrome ${result.browser}: ${result.checks.length} log explorer checks`);
} finally {
  await browser?.close(); await collector?.close();
  await rm(privateDir, { recursive: true, force: true });
}

