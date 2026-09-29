import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCapture } from '../validate.mjs';

const [input, output = 'artifacts/live', androidVersion = 'unknown', api = 'unknown'] = process.argv.slice(2);
if (!input) throw new Error('Usage: node scripts/collect-live.mjs input.ndjson [output-directory] [Android-version] [API]');
const raw = readFileSync(input, 'utf8');
const result = validateCapture(raw);
if (!result.valid || result.warnings.length) throw new Error(JSON.stringify({ errors: result.errors, warnings: result.warnings }));
const events = raw.trim().split('\n').map(JSON.parse);
const starts = events.filter(e => e.event_type === 'session.started');
if (starts.length !== 2) throw new Error('Expected successful and recovery sessions');
mkdirSync(output, { recursive: true });
const descriptions = ['Successful sign-in, refresh, SDK-invoked app handler with a manual request and an explicit return, and receipt.', 'Successful sign-in with one intentional HTTP 401, token refresh, and correlated retry.'];
const files = starts.map((session, index) => {
  const name = index === 0 ? 'successful-sign-in.ndjson' : 'recovered-sign-in.ndjson';
  const lines = events.filter(e => e.recording_id === session.recording_id);
  const content = lines.map(e => JSON.stringify(e)).join('\n') + '\n';
  const validation = validateCapture(content);
  const expectedRequests = index === 0 ? 8 : 9;
  if (validation.summary.requests !== expectedRequests || validation.summary.failed_requests !== index || validation.summary.unfinished_requests !== 0 || validation.summary.handler_calls !== 1 || validation.summary.unfinished_handler_calls !== 0 || validation.summary.unknown_handler_outcomes !== 0) throw new Error('Unexpected flow outcome');
  // Known public password and JWT signatures must never appear in persisted event values.
  if (content.includes('emilyspass') || /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(content)) throw new Error('Credential found in capture');
  writeFileSync(resolve(output, name), content);
  return { file: name, description: descriptions[index], captured_at: session.timestamp, summary: validation.summary };
});
writeFileSync(resolve(output, 'multi-session.ndjson'), raw);
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ synthetic: false, source: 'Android emulator live HTTPS requests via SampleFlow / LiveFlowTest', android_version: androidVersion, api_level: api, capture_sdk: '0.2.0', redaction: 'Applied on device before writing; captures are not retrospectively fabricated or edited.', files }, null, 2) + '\n');
console.log(JSON.stringify({ output: resolve(output), ...result.summary }, null, 2));
