// Actual desktop viewer captures using committed, sanitized logs. No UI/data edits.
import { build, preview } from 'vite';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../docs/screenshots/', import.meta.url);
const configFile = fileURLToPath(new URL('../viewer/vite.config.mjs', import.meta.url));
await mkdir(output, { recursive: true });
await build({ configFile, logLevel: 'error' });
const server = await preview({ configFile, preview: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.WEB_TEST_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function open(file) {
    await page.goto(origin);
    await page.getByLabel('Choose NDJSON files', { exact: true }).setInputFiles(root + file);
    await page.locator('.import-session').first().getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByText('Client', { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
  }
  async function save(name) {
    await page.mouse.move(1420, 980);
    await page.screenshot({ path: fileURLToPath(new URL(name + '.png', output)), animations: 'disabled' });
    console.log(`Captured ${name}.png`);
  }
  await open('samples/live/multi-session.ndjson');
  await save('desktop-multi-server');

  await open('samples/web/browser-auth-recovery.ndjson');
  await page.getByRole('button', { name: /Local call from SDK/ }).first().click();
  await page.getByText(/^Awaited handler invocation\./).waitFor();
  await page.locator('.diagram-host').evaluate(element => { element.scrollTop = 235; });
  await save('desktop-awaited-handler');

  await open('examples/retry.ndjson');
  await page.getByRole('button', { name: /503.*Select exchange/ }).first().click();
  await page.getByRole('tab', { name: 'Response', exact: true }).click();
  await save('desktop-retry');

  await open('examples/stream-read-timeout.ndjson');
  await page.getByRole('button', { name: /200.*Select exchange/ }).first().click();
  await page.getByRole('tab', { name: 'Response', exact: true }).click();
  await save('desktop-body-timeout');
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  await new Promise(resolve => { server.httpServer.close(resolve); server.httpServer.closeAllConnections(); });
}
