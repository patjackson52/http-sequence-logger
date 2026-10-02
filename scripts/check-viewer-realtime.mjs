import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startCollector } from '../collector/server.mjs';
import { buildViewer } from '../collector/runtime.mjs';
import { validateCapture } from '../shared/validate.mjs';

const privateDir = await mkdtemp(join(tmpdir(), 'viewer-realtime-'));
const artifacts = resolve(process.env.VIEWER_REALTIME_ARTIFACTS || 'artifacts/viewer-realtime');
await mkdir(artifacts, { recursive: true });
const fixture = (await readFile(new URL('../examples/success.ndjson', import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
const representative = (await readFile(new URL('../examples/viewer-three-origin.ndjson', import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
const scenarios = [{ name: 'empty-session', fixture: [fixture[0], fixture.at(-1)], requests: 0 }, { name: 'eight-request-diagram', fixture: representative, requests: 8 }];
const evidence = { kind: 'Synthetic source events through real SQLite/SSE and installed Chrome viewer; selected heading, request count and representative SVG targets plus two frame opportunities; no native callback/network or power-loss claim', samples: [], errors: [] };
let collector, browser;
try {
  await buildViewer();
  collector = await startCollector({ directory: privateDir, port: 0 });
  const source = await collector.enroll({ version: 2, registration_id: randomUUID(), platform: 'web', environment_id: 'latency-browser', app_id: 'latency.app', installation_id: randomUUID(), journal_id: randomUUID(), origin: 'http://latency.test' });
  browser = await chromium.launch({ channel: process.env.WEB_TEST_CHANNEL || 'chrome', headless: true });
  evidence.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.goto(collector.origin);
  await expect(page.locator('.live-actions strong')).toContainText('● Live');
  await page.getByLabel('Follow newest session').check();
  let committedAt;
  const ingest = collector.store.ingest.bind(collector.store);
  collector.store.ingest = async (...args) => {
    const result = await ingest(...args);
    committedAt = performance.now(); // The worker reply follows the FULL SQLite commit.
    return result;
  };
  for (const scenario of scenarios) for (let trial = 0; trial < 10; trial++) {
    const id = randomUUID(), name = `Realtime visibility ${scenario.name} ${trial}`;
    const common = { recording_id: id, session_id: id, session_namespace: 'viewer-latency/development' };
    const spans = new Map();
    const events = scenario.fixture.map((original, index) => {
      const event = JSON.parse(JSON.stringify(original, (key, value) => {
        if (typeof value !== 'string' || !/^(?:trace_id|(?:parent_|previous_)?span_id)$/.test(key)) return value;
        if (!spans.has(value)) spans.set(value, randomUUID().replaceAll('-', '').slice(0, value.length));
        return spans.get(value);
      }));
      return { ...event, ...common, event_id: `${id}/${index + 1}`, sequence: index + 1 };
    });
    events[0].data.name = name;
    events[0].data.producer.platform = 'web'; events[0].data.producer.app_id = 'latency.app';
    const ndjson = events.map(JSON.stringify).join('\n') + '\n';
    const validated = validateCapture(ndjson);
    assert.equal(validated.valid, true);
    assert.deepEqual(validated.warnings, []);
    const started = performance.now();
    const ack = await collector.ingest(source.source_token, ndjson);
    assert.equal(ack.accepted, events.length);
    const commit = committedAt;
    await page.getByRole('heading', { name, exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.locator('.view-controls')).toContainText(`${scenario.requests} of ${scenario.requests} requests`);
    if (scenario.requests) {
      await expect(page.locator('.view-controls')).toContainText('1 of 1 handler calls');
      const request = events.find(event => event.event_type === 'http.request.started');
      const entity = `${request.context.trace_id}/${request.context.span_id}`;
      await expect(page.locator(`.nll-seq-svg [data-entity-id="${entity}"]`).first()).toBeVisible();
      await expect(page.getByLabel('Origin https://tasks.example', { exact: true })).toBeVisible();
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const visible = performance.now();
    // Admission precedes commit, so this also conservatively bounds actual
    // commit-to-visibility without assuming a cross-worker timestamp.
    evidence.samples.push({ scenario: scenario.name, trial, events: events.length, requests: scenario.requests, admission_to_visible_frames_ms: visible - started, commit_reply_to_visible_frames_ms: visible - commit });
  }
  assert.deepEqual(evidence.errors, []);
  const values = evidence.samples.map(row => row.admission_to_visible_frames_ms).sort((a, b) => a - b);
  evidence.min_ms = values[0]; evidence.median_ms = values[Math.floor(values.length / 2)]; evidence.max_ms = values.at(-1);
  evidence.scenarios = scenarios.map(scenario => {
    const values = evidence.samples.filter(row => row.scenario === scenario.name).map(row => row.admission_to_visible_frames_ms).sort((a,b) => a-b);
    return { name: scenario.name, samples: values.length, events_per_sample: scenario.fixture.length, requests: scenario.requests, min_ms: values[0], median_ms: values[Math.floor(values.length / 2)], max_ms: values.at(-1) };
  });
  evidence.target_ms = 1000;
  evidence.passed = evidence.max_ms <= evidence.target_ms;
  await page.screenshot({ path: join(artifacts, 'viewer.png'), fullPage: true });
  assert.ok(evidence.passed, 'Committed-event visibility exceeded one second');
} catch (error) {
  evidence.passed = false; evidence.error = error.message; throw error;
} finally {
  await browser?.close(); await collector?.close();
  await rm(privateDir, { recursive: true, force: true });
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
