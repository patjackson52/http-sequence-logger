import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCapture } from '../validate.mjs';
const dir = new URL('../samples/live/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
for (const sample of manifest.files) {
  test(`recorded Android flow: ${sample.file}`, () => {
    const raw = readFileSync(new URL(sample.file, dir), 'utf8');
    const result = validateCapture(raw);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.summary, sample.summary);
    assert.equal(raw.includes('emilyspass'), false);
    assert.equal(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(raw), false);
    const events = raw.trim().split('\n').map(JSON.parse);
    const requests = events.filter(e => e.event_type === 'http.request.started');
    assert.equal(requests.filter(e => e.data.adapter.name === 'customer.manual').length, 1);
    assert.equal(requests.find(e => e.data.adapter.name === 'customer.manual').data.origin.executor.owner, 'integrator');
    assert.ok(requests.some(e => e.data.origin.executor.owner === 'sdk'));
    assert.equal(events.find(e => e.event_type === 'session.started').data.trace_propagation, 'disabled');
  });
}
test('recorded Android multi-session file retains both complete recordings', () => {
  const result = validateCapture(readFileSync(new URL('multi-session.ndjson', dir), 'utf8'));
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.sessions, 2);
  assert.equal(result.summary.requests, 17);
});
