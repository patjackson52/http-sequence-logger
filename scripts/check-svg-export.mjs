// Real downloads from the production viewer, then standalone/offline image rendering.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = root + 'artifacts/svg-export/';
const configFile = root + 'viewer/vite.config.mjs';
await mkdir(output, { recursive: true });
await build({ configFile, logLevel: 'error' });
const server = await preview({ configFile, preview: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.WEB_TEST_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function open(file, buffer) {
    await page.goto(origin);
    await page.getByLabel('Choose NDJSON files', { exact: true }).setInputFiles(buffer ? { name: 'input.ndjson', mimeType: 'application/x-ndjson', buffer } : root + file);
    await page.locator('.import-session').first().getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByText('Client', { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
  }
  async function download(name) {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
    const downloaded = await pending;
    assert.match(downloaded.suggestedFilename(), /\.svg$/);
    const path = output + name + '.svg';
    await downloaded.saveAs(path);
    const svg = await readFile(path, 'utf8');
    const parsed = await page.evaluate(svg => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      return { error: doc.querySelector('parsererror')?.textContent,
        title: doc.querySelector('title')?.textContent,
        text: doc.documentElement.textContent,
        textLabels: [...doc.querySelectorAll('text')].map(node => node.textContent),
        width: +doc.documentElement.getAttribute('width'), height: +doc.documentElement.getAttribute('height'),
        unsafe: [...doc.querySelectorAll('*')].some(node => ['script', 'foreignObject', 'image', 'style', 'button', 'a'].includes(node.localName) || [...node.attributes].some(attr => /^on|href$|tabindex$/i.test(attr.name)) || node.getAttribute('role') === 'button') };
    }, svg);
    assert.equal(parsed.error, undefined); assert.equal(parsed.unsafe, false);
    assert.ok(parsed.textLabels.includes('CLIENT'));
    assert.ok(parsed.width > 0 && parsed.height > 0);
    for (const heading of await page.locator('.nll-seq-lane').evaluateAll(nodes => nodes.map(node => node.title))) assert.ok(parsed.text.includes(heading), `Missing lane: ${heading}`);
    results.push({ name, filename: downloaded.suggestedFilename(), width: parsed.width, height: parsed.height });
    console.log(`Checked download: ${name}`);
    return { ...parsed, svg, path };
  }

  await open('examples/handler-http.ndjson');
  await page.getByRole('button', { name: /Local call from SDK/ }).first().click();
  await page.getByRole('button', { name: 'Expand App code components', exact: true }).click();
  await page.getByRole('button', { name: 'Expand SDK components', exact: true }).click();
  await page.locator('.diagram-host').evaluate(node => { node.scrollTop = node.scrollHeight; node.scrollLeft = node.scrollWidth; });
  const handler = await download('selected-handler');
  assert.match(handler.svg, /stroke="#1b6f8f"/); assert.match(handler.text, /GET \/todos\/1/); assert.match(handler.text, /↩ returned/);
  assert.ok(handler.height > await page.locator('.diagram-host').evaluate(node => node.clientHeight));
  await page.screenshot({ path: output + 'viewer-selected-handler.png' });
  await page.getByRole('button', { name: 'List', exact: true }).click();
  assert.equal((await download('list-view')).svg, handler.svg);
  await page.getByRole('button', { name: 'Sequence', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse loadTask()', exact: true }).click();
  const collapsed = await download('collapsed-handler');
  assert.match(collapsed.text, /1 requests · 0 calls hidden/); assert.doesNotMatch(collapsed.text, /GET \/todos\/1|↩ returned/);
  await page.getByRole('button', { name: 'Expand loadTask()', exact: true }).click();
  await page.getByRole('group', { name: 'Kind filter', exact: true }).getByRole('button', { name: 'HTTP only', exact: true }).click();
  const http = await download('http-only');
  assert.match(http.text, /↦ inside/); assert.doesNotMatch(http.text, /↩ returned/);

  await open('samples/live/multi-session.ndjson');
  const multi = await download('multi-server');
  assert.match(multi.text, /jsonplaceholder.typicode.com/);
  await page.getByRole('searchbox', { name: 'Search paths and component names' }).fill('/todos/1');
  const filtered = await download('filtered');
  assert.ok(filtered.width < multi.width); assert.match(filtered.text, /GET \/todos\/1/);
  await page.getByRole('searchbox').fill('nothing-matches-this-filter');
  await expect(page.getByRole('button', { name: 'Download SVG' })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.locator('.session-nav .session-row').nth(1).click();
  const other = await download('second-session');
  assert.notEqual(other.title, multi.title); assert.match(other.text, /401/);

  await open('examples/multi-session.ndjson');
  const recordings = await download('all-recordings');
  await page.getByRole('button', { name: /Recording 2 · schema/ }).click();
  const single = await download('single-recording');
  assert.equal(recordings.textLabels.filter(text => text.startsWith('Recording ')).length, 2);
  assert.equal(single.textLabels.filter(text => text.startsWith('Recording ')).length, 1);

  await open('examples/stream-read-timeout.ndjson');
  const timeout = await download('body-timeout');
  assert.match(timeout.text, /200/); assert.match(timeout.text, /headers only/); assert.match(timeout.text, /timed out/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Download SVG' })).toBeVisible();
  const mobile = await download('mobile');
  assert.ok(mobile.width < timeout.width);
  await page.setViewportSize({ width: 1440, height: 1000 });

  const events = (await readFile(root + 'examples/handler-http.ndjson', 'utf8')).trim().split('\n').map(JSON.parse);
  events[0].data.name = '<script>alert("x")</script> & \u0001\uD800';
  await open(null, Buffer.from(events.map(JSON.stringify).join('\n') + '\n'));
  const hostile = await download('inert-capture-text');
  assert.match(hostile.title, /<script>alert\("x"\)<\/script> & ��/);
  assert.doesNotMatch(hostile.svg, /<script/);

  // These are the actual downloaded bytes, opened without a viewer or network.
  const offline = await browser.newContext({ offline: true, viewport: { width: 1100, height: 1000 } });
  const document = await offline.newPage();
  await document.goto(pathToFileURL(handler.path).href);
  assert.equal(await document.locator('parsererror').count(), 0);
  await expect(document.locator('svg')).toBeVisible();
  const bounds = await document.evaluate(() => {
    const svg = document.querySelector('svg'), { width, height } = svg.viewBox.baseVal;
    return [...svg.querySelectorAll('text')].filter(node => { const b = node.getBBox(), m = node.getCTM(); return b.x + m.e < -1 || b.x + b.width + m.e > width + 1 || b.y + m.f < -1 || b.y + b.height + m.f > height + 1; }).map(node => node.textContent);
  });
  assert.deepEqual(bounds, [], 'Export text must stay inside the image');
  await document.locator('svg').screenshot({ path: output + 'standalone-handler.png' });
  const embedded = await offline.newPage();
  await embedded.setContent(`<img alt="Exported sequence" src="data:image/svg+xml;base64,${Buffer.from(handler.svg).toString('base64')}">`);
  const dimensions = await embedded.locator('img').evaluate(async image => { await image.decode(); return [image.naturalWidth, image.naturalHeight]; });
  assert.deepEqual(dimensions, [handler.width, handler.height]);
  await embedded.locator('img').screenshot({ path: output + 'embedded-handler.png' });
  assert.deepEqual(errors, []);
  await writeFile(output + 'results.json', JSON.stringify({ browser: browser.version(), results, standalone: true, offlineImage: true, consoleErrors: errors }, null, 2) + '\n');
  console.log(`SVG export checks passed: ${results.length} downloads, standalone SVG and offline image embedding. Evidence: artifacts/svg-export/`);
} finally {
  await browser?.close();
  await new Promise(resolve => { server.httpServer.close(resolve); server.httpServer.closeAllConnections(); });
}
