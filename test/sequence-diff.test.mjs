import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { diffSequences, sequencesFromCapture, validateSequence, validateDiff, formatDiffText } from '../sequence-diff/index.mjs';

const sample = readFileSync(new URL('../examples/success.ndjson', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const clone = value => structuredClone(value);
const eventOf = kind => clone(sample.find(e => e.event_type === kind));
const bodyOf = direction => clone(sample.find(e => e.event_type === 'http.body.captured' && e.data.direction === direction));
function make(paths = ['/verify'], suffix = 'a') {
  const events = [], trace = (suffix === 'a' ? 'a' : 'b').repeat(32);
  const context = span => ({ trace_id: trace, span_id: span, parent_span_id: span === '1'.repeat(16) ? null : '1'.repeat(16), parent_scope: span === '1'.repeat(16) ? 'none' : 'local' });
  const begin = eventOf('session.started'); begin.data.name = 'Sign in'; events.push(begin);
  const root = clone(sample[2]); root.context = context('1'.repeat(16)); events.push(root);
  paths.forEach((path, i) => {
    const ctx = context((i + 2).toString(16).padStart(16, '0'));
    const request = eventOf('http.request.started'); request.context = ctx;
    request.data.request.url = 'https://api.example' + path;
    request.data.request.method_source = 'observed';
    request.data.request.headers = { availability: 'captured', representation: 'raw', order_preserved: true, entries: [], reason: null };
    const response = eventOf('http.response.headers'); response.context = ctx;
    response.data.response.url = request.data.request.url;
    response.data.response.headers = clone(request.data.request.headers);
    const reqBody = bodyOf('request'); reqBody.context = ctx;
    const resBody = bodyOf('response'); resBody.context = ctx;
    const end = eventOf('http.ended'); end.context = ctx; end.data.application_outcome = 'success';
    events.push(request, reqBody, response, resBody, end);
  });
  const rootEnd = eventOf('operation.ended'); rootEnd.context = context('1'.repeat(16)); events.push(rootEnd, eventOf('session.ended'));
  const starts = new Map();
  events.forEach((e, i) => {
    e.event_id = suffix + '-event-' + (i + 1); e.recording_id = suffix + '-recording';
    e.session_id = suffix + '-session'; e.sequence = i + 1;
    e.monotonic_ns = String(i * 1000000); e.timestamp = new Date(Date.UTC(2026, 9, 1) + i).toISOString();
    if (e.event_type === 'operation.started' || e.event_type === 'http.request.started') starts.set(e.context.span_id, i);
    if (e.event_type === 'operation.ended' || e.event_type === 'http.ended') e.data.duration_ns = String((i - starts.get(e.context.span_id)) * 1000000);
  });
  return sequencesFromCapture(events)[0];
}
const httpPairs = diff => diff.pairs.filter(p => (p.primary ?? p.secondary).kind === 'http');
const body = (doc, direction = 'response') => doc.events.find(e => e.event_type === 'http.body.captured' && e.data.direction === direction).data.body;
function content(doc, text) {
  const b = body(doc); b.content.data = text; b.stored_bytes = b.observed_bytes = b.total_bytes = Buffer.byteLength(text);
}
function renumber(doc) {
  const starts = new Map();
  doc.events.forEach((e, i) => {
    e.sequence = i + 1; e.monotonic_ns = String(i * 1000000); e.timestamp = new Date(Date.UTC(2026, 9, 1) + i).toISOString();
    if (e.event_type === 'operation.started' || e.event_type === 'http.request.started') starts.set(e.context.span_id, i);
    if (e.event_type === 'operation.ended' || e.event_type === 'http.ended') e.data.duration_ns = String((i - starts.get(e.context.span_id)) * 1000000);
  });
}

test('deterministic same sequence, independent IDs, immutable inputs and valid output schema', () => {
  const a = make(), b = make(['/verify'], 'b'), before = JSON.stringify([a, b]);
  const d = diffSequences(a, b);
  assert.equal(d.result, 'equal');
  assert.equal(httpPairs(d).length, 1);
  assert.equal(validateDiff(d), true);
  assert.deepEqual(diffSequences(a, b), d);
  assert.equal(JSON.stringify([a, b]), before);
  assert.equal(d.pairs.every(p => p.primary.event_pointers.every(path => a.events[Number(path.split('/').at(-1))])), true);
});

test('content diffs expose raw bodies and safe JSON field paths; absent differs from null', () => {
  const a = make(), b = make(['/verify'], 'b');
  content(a, '{"verified":true,"optional":null}');
  content(b, '{"verified":false}');
  const p = httpPairs(diffSequences(a, b))[0];
  assert.equal(p.changes.some(c => c.path === '/response_body/json/verified' && c.primary.value === true && c.secondary.value === false), true);
  const removed = p.changes.find(c => c.path === '/response_body/json/optional');
  assert.equal(removed.primary.present, true); assert.equal(removed.primary.value, null); assert.equal(removed.secondary.present, false);
  assert.equal(p.changes.some(c => c.path === '/response_body/content/data'), true);
});

test('duplicate JSON keys and imprecise numbers keep raw evidence, never fabricate field equality', () => {
  for (const [x, y] of [['{"a":1,"a":2}', '{"a":2}'], ['{"n":9007199254740992}', '{"n":9007199254740993}']]) {
    const a = make(), b = make(['/verify'], 'b'); content(a, x); content(b, y);
    const d = diffSequences(a, b);
    assert.equal(d.result, 'different');
    assert.equal(httpPairs(d)[0].changes.some(c => c.path.startsWith('/response_body/json')), false);
  }
});

test('query values do not break correspondence; repeated query and header entries remain ordered', () => {
  const a = make(['/verify?tag=a&tag=b']), b = make(['/verify?tag=b&tag=a'], 'b');
  const d = diffSequences(a, b), p = httpPairs(d)[0];
  assert.equal(p.presence, 'both');
  assert.equal(p.changes.some(c => c.path === '/request/query/0/value'), true);
  const headers = doc => doc.events.find(e => e.event_type === 'http.request.started').data.request.headers.entries;
  headers(a).push({ name: 'X-Id', value: 'one', redacted: false }, { name: 'X-Id', value: 'two', redacted: false });
  headers(b).push({ name: 'X-Id', value: 'two', redacted: false }, { name: 'X-Id', value: 'one', redacted: false });
  assert.equal(httpPairs(diffSequences(a, b))[0].changes.some(c => c.path === '/request/headers/entries/0/value'), true);
  const ignored = httpPairs(diffSequences(a, b, { ignore_headers: ['x-ID'] }))[0];
  assert.equal(ignored.changes.some(c => c.path.startsWith('/request/headers/entries')), false);
  assert.equal(ignored.ignored_paths.includes('/request/headers/entries'), true);
});

test('insertions are one-sided nodes, while moves are matched calls with an order relation', () => {
  const a = make(['/config', '/verify']), b = make(['/verify', '/config', '/extra'], 'b');
  const d = diffSequences(a, b);
  assert.equal(httpPairs(d).filter(p => p.presence === 'both').length, 2);
  assert.equal(httpPairs(d).filter(p => p.presence === 'secondary_only').length, 1);
  assert.equal(d.order_changes.length, 1);
  assert.equal(d.order_changes[0].interpretation, 'reordered');
});

test('repeated endpoints stay unresolved until explicit one-to-one matches are provided', () => {
  const a = make(['/verify', '/verify']), b = make(['/verify', '/verify'], 'b');
  const d = diffSequences(a, b), unresolved = httpPairs(d);
  assert.equal(unresolved.length, 4);
  assert.equal(unresolved.every(p => p.presence === 'unresolved'), true);
  assert.equal(d.result, 'inconclusive');
  const xs = unresolved.filter(p => p.primary), ys = unresolved.filter(p => p.secondary);
  const resolved = diffSequences(a, b, { matches: xs.map((p, i) => ({ primary: p.primary.node_id, secondary: ys[i].secondary.node_id })) });
  assert.equal(resolved.result, 'equal');
  assert.equal(httpPairs(resolved).every(p => p.matching.basis === 'explicit'), true);
  assert.equal(diffSequences(a, a).result, 'equal');
});

test('partial recordings cannot establish absent calls', () => {
  const a = make(['/verify', '/extra']), b = make(['/verify'], 'b');
  b.events.pop();
  const d = diffSequences(a, b);
  assert.equal(httpPairs(d).find(p => p.primary?.label.endsWith('/extra')).presence, 'unresolved');
  assert.equal(d.diagnostics.some(d => d.message.includes('missing session.ended')), true);
});

test('redacted and truncated content is unknown even when retained strings match', () => {
  for (const mode of ['redacted', 'truncated']) {
    const a = make(), b = make(['/verify'], 'b');
    body(a)[mode] = body(b)[mode] = true;
    if (mode === 'truncated') body(a).reason = body(b).reason = 'body_limit';
    const d = diffSequences(a, b);
    assert.equal(d.result, 'inconclusive');
    assert.equal(httpPairs(d)[0].uncertainties.some(u => u.reason.includes(mode)), true);
  }
});

test('exact timing comparison is opt-in and preserves decimal nanoseconds', () => {
  const a = make(), b = make(['/verify'], 'b');
  const last = b.events.at(-1), rootEnd = b.events.at(-2), httpEnd = b.events.find(e => e.event_type === 'http.ended');
  httpEnd.monotonic_ns = '9007199254740993000';
  httpEnd.data.duration_ns = String(BigInt(httpEnd.monotonic_ns) - BigInt(b.events.find(e => e.event_type === 'http.request.started').monotonic_ns));
  rootEnd.monotonic_ns = '9007199254740993001';
  rootEnd.data.duration_ns = String(BigInt(rootEnd.monotonic_ns) - BigInt(b.events[1].monotonic_ns));
  last.monotonic_ns = '9007199254740993002';
  assert.equal(diffSequences(a, b).result, 'equal');
  const changes = httpPairs(diffSequences(a, b, { compare_timing: true }))[0].changes;
  assert.equal(changes.find(c => c.path === '/timing/duration_ns').secondary.value, httpEnd.data.duration_ns);
});

test('concurrent start-order differences are not labeled causal reordering', () => {
  const a = make(['/config', '/verify']), b = make(['/config', '/verify'], 'b');
  for (const doc of [a, b]) {
    const first = doc.events.slice(2, 7), second = doc.events.slice(7, 12);
    doc.events = [...doc.events.slice(0, 2), first[0], second[0], ...first.slice(1), ...second.slice(1), ...doc.events.slice(12)];
    renumber(doc);
  }
  [b.events[2], b.events[3]] = [b.events[3], b.events[2]]; renumber(b);
  const d = diffSequences(a, b);
  assert.equal(d.order_changes.length, 1);
  assert.equal(d.order_changes[0].interpretation, 'observed_order_only');
});

test('schema rejects malformed documents, mixed sessions, invalid options and unknown overrides', () => {
  const a = make();
  assert.throws(() => validateSequence({ ...a, schema_version: 'future' }), /Invalid sequence/);
  const bad = clone(a); bad.events[1].session_id = 'foreign';
  assert.throws(() => validateSequence(bad), /declared session/);
  assert.throws(() => sequencesFromCapture([null]), /Invalid canonical event/);
  assert.throws(() => diffSequences(a, a, { random: true }), /Unknown comparison option/);
  assert.throws(() => diffSequences(a, a, { matches: [{ primary: 'missing', secondary: 'missing' }] }), /missing nodes/);
  assert.throws(() => sequencesFromCapture(sample.map(JSON.stringify).join('\n') + '\n{"broken":'), /parse failed/);
  const duplicate = clone(a); duplicate.events.push({ ...clone(duplicate.events[0]), data: { ...duplicate.events[0].data, name: 'conflict' } });
  assert.throws(() => validateSequence(duplicate), /Contradictory/);
});

test('every current capture fixture is accepted, and self-comparison has no invented structural changes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../examples/manifest.json', import.meta.url)));
  for (const item of manifest.captures) {
    const text = readFileSync(new URL('../examples/' + item.file, import.meta.url), 'utf8');
    for (const doc of sequencesFromCapture(text)) {
      const diff = diffSequences(doc, doc);
      assert.equal(diff.summary.primary_only, 0, item.file);
      assert.equal(diff.summary.secondary_only, 0, item.file);
      assert.equal(diff.order_changes.length, 0, item.file);
      assert.equal(diff.summary.field_changes, 0, item.file);
    }
  }
});

test('CLI produces clean JSON, text, strict exit codes, normalization and overwrite protection', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sequence-diff-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = make(), b = make(['/extra'], 'b');
  const paths = [join(dir, 'a.json'), join(dir, 'b.json')];
  paths.forEach((path, i) => writeFileSync(path, JSON.stringify(i ? b : a)));
  const cli = (...args) => spawnSync(process.execPath, [new URL('../sequence-diff/cli.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });
  let r = cli('compare', ...paths, '--check');
  assert.equal(r.status, 1, r.stderr); assert.equal(JSON.parse(r.stdout).result, 'different'); assert.equal(r.stderr, '');
  r = cli('compare', paths[0], paths[0], '--check'); assert.equal(r.status, 0, r.stderr);
  const unknown = clone(a); body(unknown).redacted = true; writeFileSync(paths[1], JSON.stringify(unknown));
  r = cli('compare', paths[1], paths[1], '--check'); assert.equal(r.status, 3, r.stderr);
  r = cli('compare', paths[0], paths[0], '--format', 'text'); assert.match(r.stdout, /^EQUAL/);
  r = cli('compare', ...paths, '--output', paths[0]); assert.equal(r.status, 2); assert.deepEqual(JSON.parse(readFileSync(paths[0])), a);
  const ndjson = join(dir, 'input.ndjson'); writeFileSync(ndjson, a.events.map(JSON.stringify).join('\n'));
  r = cli('normalize', ndjson); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).format, 'http-sequence');
  r = cli('compare', ...paths, '--format', 'typo'); assert.equal(r.status, 2); assert.equal(r.stdout, '');
});

test('human output escapes terminal controls from capture strings', () => {
  const a = make(), b = make(['/verify'], 'b');
  content(b, '{"note":"\\u001b[31m"}');
  assert.equal(formatDiffText(diffSequences(a, b)).includes('\u001b'), false);
});

test('CLI warnings stay in results and exported profiles reproduce explicit correspondence', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sequence-diff-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = ['primary.json', 'secondary.json'].map(name => join(dir, name));
  const cli = (...args) => spawnSync(process.execPath, [new URL('../sequence-diff/cli.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });
  const incomplete = make(); incomplete.events.pop();
  writeFileSync(paths[0], JSON.stringify(incomplete));
  let response = cli('compare', paths[0], paths[0], '--check');
  assert.equal(response.status, 3, response.stderr);
  assert.equal(response.stderr, '');
  assert.ok(JSON.parse(response.stdout).diagnostics.some(item => item.severity === 'warning'));
  response = cli('compare', paths[0], paths[0], '--format', 'text');
  assert.equal(response.status, 0, response.stderr);
  assert.match(response.stdout, /warning primary:/);
  assert.equal(response.stderr, '');

  const primary = make(['/repeat', '/repeat']), secondary = make(['/repeat', '/repeat'], 'b');
  const initial = diffSequences(primary, secondary);
  const left = initial.pairs.find(pair => pair.primary?.kind === 'http').primary;
  const right = initial.pairs.find(pair => pair.secondary?.kind === 'http').secondary;
  const expected = diffSequences(primary, secondary, {
    matches: [{ primary: left.node_id, secondary: right.node_id }], compare_timing: true, ignore_headers: ['date'],
  });
  assert.equal(initial.result, 'inconclusive');
  assert.equal(expected.result, 'equal');
  const profile = join(dir, 'comparison.profile.json');
  writeFileSync(profile, JSON.stringify(expected.profile));
  [primary, secondary].forEach((document, index) => writeFileSync(paths[index], JSON.stringify(document)));
  response = cli('compare', ...paths, '--options', profile);
  assert.equal(response.status, 0, response.stderr);
  assert.deepEqual(JSON.parse(response.stdout), expected);
  assert.equal(response.stderr, '');
});

test('capture partitioning cannot hide recording or event identity conflicts across sessions', () => {
  const a = make(), b = make(['/verify'], 'b');
  b.events.forEach(e => { e.recording_id = a.events[0].recording_id; });
  assert.throws(() => sequencesFromCapture([...a.events, ...b.events]), /Contradictory capture/);
  const c = make(['/verify'], 'b'); c.events[0].event_id = a.events[0].event_id;
  assert.throws(() => sequencesFromCapture([...a.events, ...c.events]), /Contradictory capture/);
});

test('orphan-only parent cycles fail instead of silently disappearing from comparison', () => {
  const a = make();
  const rootId = a.events[1].context.span_id;
  const httpId = a.events.find(e => e.event_type === 'http.request.started').context.span_id;
  a.events = a.events.filter(e => !['operation.started', 'http.request.started'].includes(e.event_type));
  for (const e of a.events.filter(e => e.context)) {
    e.context.parent_scope = 'local';
    e.context.parent_span_id = e.context.span_id === rootId ? httpId : rootId;
  }
  assert.throws(() => diffSequences(a, a), /Cyclic local parent/);
});

test('manual pairs reject duplicate targets and wrong recording override category', () => {
  const a = make(['/x', '/y']), b = make(['/x', '/y'], 'b');
  const initial = diffSequences(a, b), p = httpPairs(initial);
  assert.throws(() => diffSequences(a, b, { matches: p.map(x => ({ primary: x.primary.node_id, secondary: p[0].secondary.node_id })) }), /one-to-one/);
  const recording = initial.pairs[0];
  assert.throws(() => diffSequences(a, b, { matches: [{ primary: recording.primary.node_id, secondary: recording.secondary.node_id }] }), /recording_matches/);
});

test('observable retry is an extra attempt, not a changed pairing with the first call', () => {
  const docs = ['success', 'retry'].map(n => sequencesFromCapture(readFileSync(new URL('../examples/' + n + '.ndjson', import.meta.url), 'utf8'))[0]);
  const d = diffSequences(...docs);
  assert.equal(httpPairs(d).filter(p => p.presence === 'both').length, 1);
  assert.equal(httpPairs(d).filter(p => p.presence === 'secondary_only').length, 1);
});

test('generated copies stay synchronized with authoritative capture validators', () => {
  for (const [source, target] of [['validate.mjs', 'capture-validation.mjs'], ['event-validator.mjs', 'event-validator.mjs']]) {
    const canonical = readFileSync(new URL('../shared/' + source, import.meta.url), 'utf8');
    const generated = readFileSync(new URL('../sequence-diff/generated/' + target, import.meta.url), 'utf8');
    assert.equal(generated.slice(generated.indexOf('\n') + 1), canonical);
  }
});
