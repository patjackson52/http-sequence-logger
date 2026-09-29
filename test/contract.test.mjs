import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateCapture } from '../validate.mjs';

const root = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(`examples/${name}.ndjson`, root), 'utf8');
const parse = (name = 'success') => read(name).trim().split('\n').map((line) => JSON.parse(line));
const encode = (events) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
const first = (events, type) => events.find((e) => e.event_type === type);
function reject(name, change, pattern) {
  test(name, () => {
    const events = parse();
    change(events);
    const result = validateCapture(encode(events));
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), pattern);
  });
}

const manifest = JSON.parse(readFileSync(new URL('examples/manifest.json', root), 'utf8'));
for (const fixture of manifest.captures) {
  test(`reference capture: ${fixture.file}`, () => {
    const result = validateCapture(readFileSync(new URL(`examples/${fixture.file}`, root), 'utf8'));
    assert.deepEqual(result.errors, []);
    for (const [key, value] of Object.entries(fixture.expected)) assert.equal(result.summary[key], value, key);
    if (fixture.file === 'interrupted.ndjson') assert.equal(result.warnings.length, 4);
    else if (fixture.file === 'handler-interrupted.ndjson') assert.equal(result.warnings.length, 1);
    else assert.deepEqual(result.warnings, []);
  });
}

test('committed schema and captures reproduce exactly', () => {
  const names = ['schema/event.schema.json', ...readdirSync(new URL('examples/', root)).map((name) => `examples/${name}`)];
  const before = names.map((name) => readFileSync(new URL(name, root), 'utf8'));
  execFileSync(process.execPath, ['scripts/build-schema.mjs'], { cwd: root });
  execFileSync(process.execPath, ['scripts/build-examples.mjs'], { cwd: root });
  names.forEach((name, i) => assert.equal(readFileSync(new URL(name, root), 'utf8'), before[i], name));
});

test('repeated query parameters and response headers survive round-trip', () => {
  const result = validateCapture(read('success'));
  const request = first(result.events, 'http.request.started').data.request;
  assert.deepEqual(new URL(request.url).searchParams.getAll('tag'), ['mobile', 'checkout']);
  const response = first(result.events, 'http.response.headers').data.response;
  assert.equal(response.headers.entries.filter((e) => e.name === 'Set-Cookie').length, 2);
});

test('interleaved sessions and resumed IDs are grouped independently of file position', () => {
  const result = validateCapture(read('multi-session'));
  assert.equal(result.summary.sessions, 2);
  assert.equal(result.summary.recordings, 3);
  assert.equal(result.summary.origins.length, 6);
  assert.equal(result.events.filter((e) => e.session_id === 'checkout-123' && e.event_type === 'http.request.started').length, 12);
});

test('out-of-order delivery is reconstructed using recording sequence', () => {
  const result = validateCapture(encode(parse('concurrent').reverse()));
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
});

test('wall clock adjustment does not invalidate monotonic durations', () => {
  const events = parse();
  first(events, 'http.ended').timestamp = '2026-09-28T17:00:00.000Z';
  assert.equal(validateCapture(encode(events)).valid, true);
});

test('identical replayed events deduplicate, including reordered JSON properties', () => {
  const events = parse();
  events.push(Object.fromEntries(Object.entries(events[0]).reverse()));
  const result = validateCapture(encode(events));
  assert.equal(result.valid, true);
  assert.equal(result.summary.duplicate_events, 1);
  assert.equal(result.summary.requests, 1);
});

test('partial trailing JSON is reported and recovered; malformed middle line is rejected', () => {
  const partial = validateCapture(`${read('interrupted')}{"schema_version":`);
  assert.equal(partial.valid, true);
  assert.match(partial.warnings.join('\n'), /incomplete final JSON line/);
  const malformed = validateCapture(`${read('interrupted')}not-json\n`);
  assert.equal(malformed.valid, false);
  assert.match(malformed.errors.join('\n'), /invalid JSON/);
});

test('BOM, CRLF, and a complete last line without newline are accepted', () => {
  assert.equal(validateCapture(`\uFEFF${read('success').trim().replaceAll('\n', '\r\n')}`).valid, true);
});

test('missing records produce partial-data warnings without fabricating values', () => {
  const events = parse().filter((e) => e.event_type !== 'http.response.headers');
  const result = validateCapture(encode(events));
  assert.equal(result.valid, true);
  assert.match(result.warnings.join('\n'), /sequence gap/);
  assert.match(result.warnings.join('\n'), /final response headers are missing/);
});

test('remote parent identity is accepted without a local server span', () => {
  const events = parse();
  for (const event of events.filter((e) => e.context?.parent_scope === 'none')) {
    event.context.parent_scope = 'remote';
    event.context.parent_span_id = '1122334455667788';
  }
  const result = validateCapture(encode(events));
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
});

test('HTTP cannot terminate successfully at headers and hide a later read failure', () => {
  const events = parse();
  const end = first(events, 'http.ended');
  const responseBody = events.find((e) => e.event_type === 'http.body.captured' && e.data.direction === 'response');
  end.data.end_reason = 'headers';
  end.monotonic_ns = '40000000';
  end.data.duration_ns = '30000000';
  [end.sequence, responseBody.sequence] = [responseBody.sequence, end.sequence];
  assert.equal(validateCapture(encode(events)).valid, false);
});

test('body storage uses bytes, supports binary, and permits redaction plus truncation', () => {
  const events = parse();
  const body = events.find((e) => e.event_type === 'http.body.captured').data.body;
  Object.assign(body, { content: { encoding: 'utf-8', data: 'é' }, observed_bytes: 2, total_bytes: 2, stored_bytes: 2 });
  assert.equal(validateCapture(encode(events)).valid, true);
  Object.assign(body, { content: { encoding: 'base64', data: '/wA=' }, charset: null, media_type: 'application/octet-stream' });
  assert.equal(validateCapture(encode(events)).valid, true);
  assert.equal(validateCapture(read('redacted-truncated')).valid, true);
});

test('HTTP 200 can carry a separately classified application failure', () => {
  const events = parse();
  first(events, 'http.ended').data.application_outcome = 'error';
  const result = validateCapture(encode(events));
  assert.equal(result.valid, true);
  assert.equal(result.summary.failed_requests, 1);
});

test('one malformed record does not crash validation of the rest of the file', () => {
  const result = validateCapture(`${read('success')}null\n[]\n{}\n`);
  assert.equal(result.valid, false);
  assert.equal(result.summary.requests, 1);
});

reject('unknown schema version is rejected', (e) => { e[0].schema_version = '2.0'; }, /schema validation/);
reject('unknown core properties are rejected', (e) => { e[0].sesion_id = 'typo'; }, /schema validation/);
reject('zero trace IDs are rejected', (e) => { first(e, 'http.request.started').context.trace_id = '0'.repeat(32); }, /schema validation/);
reject('impossible calendar timestamps are rejected', (e) => { e[0].timestamp = '2026-02-30T18:30:00.000Z'; }, /schema validation/);
reject('status zero is not used to represent missing HTTP response', (e) => { first(e, 'http.ended').data.status_code = 0; }, /schema validation/);
reject('conflicting event IDs are rejected', (e) => { const copy = structuredClone(e[0]); copy.data.name = 'changed'; e.push(copy); }, /conflicting duplicate/);
reject('request context cannot change mid-flight', (e) => { first(e, 'http.ended').context.parent_span_id = '1122334455667788'; }, /context changed/);
reject('a recording cannot change sessions mid-flight', (e) => { first(e, 'http.ended').session_id = 'different-session'; }, /reused across different sessions/);
reject('duration inconsistencies are rejected', (e) => { first(e, 'http.ended').data.duration_ns = '1'; }, /duration_ns/);
reject('nanoseconds must not be JSON floating-point numbers', (e) => { e[0].monotonic_ns = 0; }, /schema validation/);
reject('duplicate recording sequences are rejected', (e) => { e[2].sequence = e[1].sequence; }, /duplicate sequence/);
reject('terminal status must match response headers', (e) => { first(e, 'http.ended').data.status_code = 201; }, /disagrees with final response/);
reject('captured body byte count is checked', (e) => { first(e, 'http.body.captured').data.body.stored_bytes = 100; }, /stored_bytes/);
reject('unavailable body must not retain hidden content', (e) => { first(e, 'http.body.captured').data.body.availability = 'unavailable'; }, /schema validation/);
reject('invalid base64 is rejected', (e) => { first(e, 'http.body.captured').data.body.content = { encoding: 'base64', data: '%%%%' }; }, /canonical padded base64/);
reject('URL credentials are rejected', (e) => { first(e, 'http.request.started').data.request.url = 'https://user:secret@api.example/verify'; }, /no userinfo/);
reject('adapter visibility claims must match session metadata', (e) => { first(e, 'http.request.started').data.attempt.visibility = 'individual'; }, /adapter capabilities/);
reject('HTTP failures cannot be mislabeled successful', (e) => {
  first(e, 'http.ended').data.status_code = 503;
  first(e, 'http.response.headers').data.response.status_code = 503;
}, /successful HTTP exchange requires/);

test('retry links must connect sequential sibling HTTP attempts', () => {
  const events = parse('retry');
  const retry = events.filter((e) => e.event_type === 'http.request.started')[1];
  retry.data.attempt.index = 7;
  const result = validateCapture(encode(events));
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /increment by one/);
});

test('explicit SDK retries remain linked when the native calls hide transport attempts', () => {
  const result = validateCapture(read('retry'));
  const requests = result.events.filter((e) => e.event_type === 'http.request.started');
  assert.deepEqual(requests.map((e) => e.data.attempt.visibility), ['logical', 'logical']);
  assert.deepEqual(requests.map((e) => e.data.attempt.index), [0, 1]);
  assert.equal(requests[1].data.attempt.previous_span_id, requests[0].context.span_id);
  assert.equal(result.valid, true);
});

test('blank input is not a valid capture', () => {
  assert.equal(validateCapture('\n').valid, false);
});

test('manual capture needs no method spans or complete header/body metadata', () => {
  const result = validateCapture(read('manual-minimal'));
  assert.equal(result.valid, true);
  assert.equal(result.events.some((e) => e.event_type.startsWith('operation.')), false);
  const request = first(result.events, 'http.request.started');
  assert.equal(request.context.parent_span_id, null);
  assert.equal(request.data.adapter.name, 'customer.manual');
  assert.equal(request.data.origin.executor.owner, 'integrator');
  assert.equal(first(result.events, 'http.response.headers').data.response.url, null);
  assert.equal(result.events.filter((e) => e.event_type === 'http.body.captured').every((e) => e.data.body.availability === 'unavailable'), true);
});

test('post-header read failure is retained after calling method returns', () => {
  const result = validateCapture(read('stream-read-timeout'));
  const end = first(result.events, 'http.ended');
  assert.equal(result.valid, true);
  assert.equal(end.data.status_code, 200);
  assert.equal(end.data.outcome, 'timeout');
  assert.equal(result.summary.failed_requests, 1);
  assert.ok(first(result.events, 'operation.ended').sequence < end.sequence);
});

test('stopping observation preserves known error status and unknown transfer outcome', () => {
  const events = parse('manual-observation-stopped');
  first(events, 'http.response.headers').data.response.status_code = 500;
  first(events, 'http.ended').data.status_code = 500;
  const result = validateCapture(encode(events));
  assert.equal(result.valid, true);
  assert.equal(result.summary.unknown_outcomes, 1);
  assert.equal(result.summary.failed_requests, 1);
});

test('partial configured headers retain known entries and explain missing native headers', () => {
  const result = validateCapture(read('success'));
  const captured = first(result.events, 'http.request.started').data.request.headers;
  assert.equal(result.valid, true);
  assert.equal(captured.availability, 'partial');
  assert.equal(captured.reason, 'application_configured_only');
  assert.ok(captured.entries.length > 0);
});

test('iOS metrics preserve partial phases and native transaction identity', () => {
  const result = validateCapture(read('ios-partial-metrics'));
  const metric = first(result.events, 'http.metrics').data;
  assert.equal(result.valid, true);
  assert.equal(metric.phases[0].end_timestamp, null);
  assert.equal(metric.transaction.index, 0);
  assert.equal(metric.transaction.request.method, 'POST');
  const multi = validateCapture(read('ios-logical-transactions'));
  assert.equal(multi.summary.requests, 1);
  assert.equal(multi.summary.origins.length, 2);
  assert.deepEqual(multi.events.filter((e) => e.event_type === 'http.metrics').map((e) => e.data.transaction.response.status_code), [302, 200]);
});

test('native phases with neither endpoint are rejected instead of invented', () => {
  const events = parse('ios-partial-metrics');
  first(events, 'http.metrics').data.phases[0].start_timestamp = null;
  assert.equal(validateCapture(encode(events)).valid, false);
});

test('body count validation allows unknown sizes and redaction expansion', () => {
  const events = parse();
  const captured = first(events, 'http.body.captured').data.body;
  captured.observed_bytes = null;
  captured.total_bytes = null;
  assert.equal(validateCapture(encode(events)).valid, true);
  Object.assign(captured, { redacted: true, observed_bytes: 1, total_bytes: 1, stored_bytes: 10, content: { encoding: 'utf-8', data: '[REDACTED]' } });
  assert.equal(validateCapture(encode(events)).valid, true);
});

test('informational response may precede the final response but never follow it', () => {
  for (const afterFinal of [false, true]) {
    const events = parse();
    const finalIndex = events.findIndex((e) => e.event_type === 'http.response.headers');
    const interim = structuredClone(events[finalIndex]);
    interim.event_id = 'informational-response';
    interim.data.phase = 'informational';
    interim.data.response.status_code = 103;
    events.splice(finalIndex + (afterFinal ? 1 : 0), 0, interim);
    events.forEach((e, i) => { e.sequence = i + 1; });
    const result = validateCapture(encode(events));
    assert.equal(result.valid, !afterFinal);
    if (afterFinal) assert.match(result.errors.join('\n'), /informational response occurs after final/);
  }
});

reject('a complete body cannot claim unseen trailing bytes', (e) => { first(e, 'http.body.captured').data.body.total_bytes += 100; }, /complete.*total_bytes/);
reject('unavailable body counts must still be consistent', (e) => {
  Object.assign(first(e, 'http.body.captured').data.body, { availability: 'unavailable', content: null, stored_bytes: 0, observed_bytes: 200, total_bytes: 100, reason: 'not_retained' });
}, /observed_bytes exceeds total_bytes/);
reject('known status success cannot claim observation_stopped', (e) => { first(e, 'http.ended').data.end_reason = 'observation_stopped'; }, /unknown outcome/);
reject('partial headers require a reason', (e) => { first(e, 'http.request.started').data.request.headers.reason = null; }, /schema validation/);
reject('optional exact request target retains source details', (e) => { first(e, 'http.request.started').data.request.request_target = { value: '*', redacted: false }; }, /schema validation/);

test('manual custom clients can retain OPTIONS asterisk request targets', () => {
  const events = parse('manual-minimal');
  const request = first(events, 'http.request.started').data.request;
  Object.assign(request, { method: 'OPTIONS', request_target: { value: '*', source: 'observed', redacted: false } });
  assert.equal(validateCapture(encode(events)).valid, true);
});


function rejectHandler(name, change, pattern) {
  test(name, () => {
    const events = parse('handler-http');
    change(events);
    const result = validateCapture(encode(events));
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), pattern);
  });
}
rejectHandler('handler end must explicitly describe method exit', events => {
  delete events.find(e => e.data.completion).data.completion;
}, /handler end requires/);
rejectHandler('handler return cannot claim an error outcome', events => {
  events.find(e => e.data.completion).data.completion = 'threw';
}, /completion boundary disagrees/);
rejectHandler('caller metadata must agree with parent method', events => {
  events.find(e => e.data.invocation).data.invocation.caller.owner = 'integrator';
}, /caller must match/);
rejectHandler('1.0 rejects handler fields instead of silently changing its schema', events => {
  events.forEach(e => { e.schema_version = '1.0'; });
}, /schema validation/);
rejectHandler('a recording cannot change its schema version midstream', events => {
  events[0].schema_version = '1.0';
}, /schema version changed/);
rejectHandler('generic operation cannot carry a handler return', events => {
  const lastOperation = events.filter(e => e.event_type === 'operation.ended').at(-1);
  lastOperation.data.completion = 'returned';
}, /non-handler operation/);
test('no-HTTP handler is a complete traceable invocation with no server origins', () => {
  const result = validateCapture(read('handler-no-http'));
  assert.equal(result.valid, true);
  assert.equal(result.summary.requests, 0);
  assert.equal(result.summary.handler_calls, 1);
  assert.deepEqual(result.summary.origins, []);
});
test('a handler may return while its causally linked HTTP child continues', () => {
  const events = parse('handler-http');
  const end = events.find(e => e.data.completion);
  end.monotonic_ns = '25000000'; end.data.duration_ns = '20000000';
  events.sort((a,b) => Number(BigInt(a.monotonic_ns) - BigInt(b.monotonic_ns)));
  events.forEach((e,i) => { e.sequence = i + 1; });
  const result = validateCapture(encode(events));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});
test('stopped handler observation requires a retained reason', () => {
  const events = parse('handler-stopped');
  delete events.find(e => e.data.completion).extensions;
  assert.match(validateCapture(encode(events)).errors.join('\n'), /requires a reason/);
});

for (const [name, time, pattern] of [
  ['synchronous handler cannot begin after its caller ended', 4, /synchronous handler starts after caller ended/],
  ['synchronous handler must exit before its caller ends', 6, /synchronous handler completes after caller ended/],
]) {
  rejectHandler(name, events => {
    const handler = events.find(e => e.data.invocation);
    const parent = events.find(e => e.event_type === 'operation.started' && e.context.span_id === handler.context.parent_span_id);
    const end = events.find(e => e.event_type === 'operation.ended' && e.context.span_id === parent.context.span_id);
    end.monotonic_ns = String(time * 1_000_000);
    end.data.duration_ns = String(BigInt(end.monotonic_ns) - BigInt(parent.monotonic_ns));
    events.sort((a,b) => Number(BigInt(a.monotonic_ns) - BigInt(b.monotonic_ns)));
    events.forEach((e,i) => { e.sequence = i + 1; });
  }, pattern);
}
