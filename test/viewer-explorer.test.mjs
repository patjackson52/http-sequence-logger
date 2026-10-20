// Explorer rows format in the viewer's zone; pin it so SSR assertions are deterministic.
process.env.TZ = 'UTC';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { IDBFactory } from 'fake-indexeddb';
import { importFiles } from '../viewer/src/model.mjs';
import { EXPLORER_LIMITS, duplicateLabels, formatShortTime, listDirectory, logLabel, machineLabel, memoryDirectory, readHead, readLogHeader, sessionsByFile, sortEntries } from '../viewer/src/log-explorer.mjs';
import { memoryFolderStore, openFolderStore } from '../viewer/src/folder-store.mjs';
import { folderSupport } from '../viewer/src/use-log-explorer.mjs';
import { CollectorClient } from '../viewer/src/collector-client.mjs';
import { startCollector } from '../collector/server.mjs';

const example = name => readFileSync(new URL(`../examples/${name}.ndjson`, import.meta.url), 'utf8');
const UTC = { locale: 'en-US', timeZone: 'UTC' };
const now = new Date('2026-10-20T15:00:00Z'); // Tuesday

// Minimal File System Access shapes: values() async iteration and getFile().
function fileHandle(name, text, lastModified = Date.parse('2026-10-01T00:00:00Z'), { size, fail } = {}) {
  return { kind: 'file', name, async getFile() { if (fail) throw Object.assign(new Error('gone'), { name: 'NotFoundError' }); const file = new File([text], name, { lastModified }); return size ? Object.defineProperty(file, 'size', { value: size }) : file; } };
}
function dirHandle(name, children) {
  return { kind: 'directory', name, async *values() { yield* children; }, async isSameEntry(other) { return other === this; } };
}

test('short time is 24h, day-relative and stable for a fixed clock and zone', () => {
  assert.equal(formatShortTime('2026-10-20T14:32:00Z', now, UTC), '14:32');
  assert.equal(formatShortTime('2026-10-20T00:05:00Z', now, UTC), '00:05');
  assert.equal(formatShortTime('2026-10-19T09:10:00Z', now, UTC), 'Mon 09:10');
  assert.equal(formatShortTime('2026-10-14T09:10:00Z', now, UTC), 'Wed 09:10');
  assert.equal(formatShortTime('2026-10-13T09:10:00Z', now, UTC), 'Oct 13');
  assert.equal(formatShortTime('2026-10-03T09:10:00Z', now, UTC), 'Oct 3');
  assert.equal(formatShortTime('2025-10-03T09:10:00Z', now, UTC), '2025-10-03');
  assert.equal(formatShortTime('2026-12-01T09:10:00Z', now, UTC), 'Dec 1');
  assert.equal(formatShortTime('not a date', now, UTC), '');
  assert.equal(formatShortTime(null, now, UTC), '');
  // Future (clock-skewed) timestamps never claim a weekday or "today".
  assert.equal(formatShortTime('2026-10-21T09:10:00Z', now, UTC), 'Oct 21');
  assert.equal(formatShortTime('2027-01-02T09:10:00Z', now, UTC), '2027-01-02');
  assert.equal(formatShortTime('2026-10-20T23:59:00Z', now, UTC), '23:59');
  // Calendar day follows the requested zone, not UTC.
  assert.equal(formatShortTime('2026-10-20T02:00:00Z', now, { locale: 'en-US', timeZone: 'America/Los_Angeles' }), 'Mon 19:00');
});

test('log header reads the first session.started name and time from a bounded head', () => {
  const multi = readLogHeader(example('multi-session'));
  assert.equal(multi.name, 'multi-android');
  assert.equal(multi.startedAt, '2026-09-28T18:30:00.000Z');
  assert.equal(multi.sessions, importFiles([{ name: 'm.ndjson', text: example('multi-session') }]).sessions.length);
  assert.equal(multi.error, null);
  const text = example('success'), cut = readLogHeader(text.slice(0, text.indexOf('\n') + 20), { complete: false });
  assert.equal(cut.events, 1, 'partial trailing line is ignored');
  assert.equal(cut.name, 'success');
  assert.equal(readLogHeader('not json\n{bad').error, 'Unreadable');
  const oversized = readLogHeader('{"event_type":"session.started","data":{"name":"x', { complete: false });
  assert.equal(oversized.error, null, 'first line longer than the head is unknown, not broken');
  assert.equal(oversized.unknown, true);
  assert.equal(logLabel({ name: 'huge-line.ndjson', header: oversized }).name, 'huge-line');
  const start = (id, name, timestamp) => JSON.stringify({ event_type: 'session.started', session_namespace: 'n', session_id: id, timestamp, data: name === undefined ? {} : { name } });
  const mixed = readLogHeader([start('a', undefined, '2026-10-01T00:00:00Z'), start('b', 'Second', '2026-10-02T00:00:00Z')].join('\n'));
  assert.equal(mixed.name, null, 'name never comes from a later session');
  assert.equal(mixed.startedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(readLogHeader('').error, 'No sessions');
  const long = readLogHeader(JSON.stringify({ event_type: 'session.started', session_id: 's', session_namespace: 'n', timestamp: 'bogus', data: { name: `  ${'x'.repeat(300)}  ` } }));
  assert.equal(long.name.length, EXPLORER_LIMITS.maxNameLength);
  assert.equal(long.startedAt, null);
});

test('readHead slices large files and labels fall back to the filename, never placeholder metadata', async () => {
  const big = example('success') + '\n'.repeat(10) + 'x'.repeat(EXPLORER_LIMITS.headBytes);
  const header = await readHead(new File([big], 'big.ndjson'));
  assert.equal(header.complete, false);
  assert.equal(header.name, 'success');
  const noStart = example('success').split('\n').slice(1).join('\n');
  const label = logLabel({ name: 'checkout-run.ndjson', lastModified: Date.parse('2026-10-02T00:00:00Z'), header: readLogHeader(noStart) });
  assert.equal(label.name, 'checkout-run');
  assert.equal(label.time, '2026-10-02T00:00:00.000Z');
  assert.notEqual(label.name, 'Session metadata not recorded');
  assert.equal(logLabel({ name: 'x.ndjson', lastModified: 0, header: {} }).time, null, 'lastModified 0 is undated');
});

test('entries sort subfolders first, then newest logs, undated last; identical siblings are flagged', () => {
  const log = (name, startedAt, lastModified) => ({ kind: 'file', name, header: { name: name.split('.')[0], startedAt }, lastModified });
  const sorted = sortEntries([log('old.ndjson', '2026-01-01T00:00:00Z'), { kind: 'directory', name: 'run10' }, log('undated.ndjson', null, null), log('new.ndjson', null, Date.parse('2026-10-01T00:00:00Z')), { kind: 'directory', name: 'run2' }]);
  assert.deepEqual(sorted.map(e => e.name), ['run2', 'run10', 'new.ndjson', 'old.ndjson', 'undated.ndjson']);
  assert.deepEqual(duplicateLabels([{ name: 'A', time: '2026-10-20T14:00:00Z' }, { name: 'A', time: '2026-10-20T14:00:30Z' }, { name: 'A', time: '2026-10-19T14:00:00Z' }], now, UTC), [true, true, false]);
});

test('directory listing is one lazy level of ndjson logs with bounded heads and overflow', async () => {
  const sub = dirHandle('android', [fileHandle('nested.ndjson', example('retry'))]);
  const root = dirHandle('logs', [
    fileHandle('a.ndjson', example('success'), Date.parse('2026-09-01T00:00:00Z')),
    fileHandle('notes.txt', 'ignore'), fileHandle('.hidden.ndjson', example('success')),
    dirHandle('.git', []), dirHandle('node_modules', []), sub,
    fileHandle('broken.ndjson', 'oops\n'), fileHandle('huge.ndjson', '', undefined, { size: EXPLORER_LIMITS.maxFileBytes + 1 }),
    fileHandle('gone.ndjson', '', undefined, { fail: true }),
  ]);
  const result = await listDirectory(root);
  assert.deepEqual(result.entries.map(e => e.name).sort(), ['a.ndjson', 'android', 'broken.ndjson', 'gone.ndjson', 'huge.ndjson']);
  assert.equal(result.entries[0].name, 'android');
  assert.equal(result.entries[0].kind, 'directory');
  assert.equal(result.entries[0].path, 'android/');
  const byName = Object.fromEntries(result.entries.map(e => [e.name, e]));
  assert.equal(byName['a.ndjson'].header.name, 'success');
  assert.equal(byName['broken.ndjson'].header.error, 'Unreadable');
  assert.equal(byName['huge.ndjson'].header.error, 'Too large');
  assert.equal(byName['gone.ndjson'].header.error, 'Unreadable');
  assert.ok(!('file' in byName['a.ndjson']), 'File objects are not retained in listing state');
  assert.equal(result.overflow, 0);
  const nested = await listDirectory(byName.android.handle, { path: 'android/' });
  assert.equal(nested.entries[0].path, 'android/nested.ndjson');
  assert.equal(nested.entries[0].header.name, 'retry');
  const many = dirHandle('many', Array.from({ length: 7 }, (_, i) => fileHandle(`log-${i}.ndjson`, example('success'), i * 1000)));
  const capped = await listDirectory(many, { limits: { maxEntries: 5 } });
  assert.equal(capped.entries.length, 5);
  assert.equal(capped.overflow, 2);
  assert.deepEqual(capped.entries.map(e => e.name).sort(), ['log-2.ndjson', 'log-3.ndjson', 'log-4.ndjson', 'log-5.ndjson', 'log-6.ndjson'], 'keeps the newest by lastModified');
  let pulled = 0;
  const endless = { kind: 'directory', name: 'endless', async *values() { for (let i = 0; ; i++) { pulled++; yield i % 2 ? fileHandle(`x-${i}.txt`, '') : fileHandle(`l-${i}.ndjson`, example('success'), i + 1); } } };
  const stopped = await listDirectory(endless, { limits: { maxScanned: 10, maxEntries: 3 } });
  assert.equal(stopped.truncated, true);
  assert.equal(pulled, 11, 'iteration stops at maxScanned');
  assert.equal(stopped.overflow, 2, 'overflow counts only logs and folders found but not shown');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(listDirectory(root, { signal: aborted.signal }), { name: 'AbortError' });
});

test('webkitdirectory snapshots become a read-only memory directory', async () => {
  const file = (path, text) => Object.defineProperty(new File([text], path.split('/').at(-1)), 'webkitRelativePath', { value: path });
  const handle = memoryDirectory([file('captures/one.ndjson', example('success')), file('captures/sub/two.ndjson', example('retry')), file('captures/sub/readme.md', '#')]);
  assert.equal(handle.name, 'captures');
  const top = await listDirectory(handle);
  assert.deepEqual(top.entries.map(e => [e.kind, e.name]), [['directory', 'sub'], ['file', 'one.ndjson']]);
  const sub = await listDirectory(top.entries[0].handle, { path: 'sub/' });
  assert.deepEqual(sub.entries.map(e => e.header.name), ['retry']);
  assert.equal(memoryDirectory([file('x/a.ndjson', ''), file('x/b.ndjson', '')], { maxFiles: 1 }).truncated, true);
  const filtered = memoryDirectory([file('x/a.txt', ''), file('x/.git/c.ndjson', ''), file('x/node_modules/d.ndjson', ''), file('x/.e.ndjson', ''), file('x/ok.ndjson', '')], { maxFiles: 1 });
  assert.equal(filtered.count, 1);
  assert.equal(filtered.truncated, false, 'ignored files do not consume the cap');
  assert.deepEqual((await listDirectory(filtered)).entries.map(e => e.name), ['ok.ndjson']);
});

test('imported sessions group by containing file', () => {
  const capture = importFiles([{ name: 'multi.ndjson', text: example('multi-session') }, { name: 'one.ndjson', text: example('success') }]);
  const groups = sessionsByFile(capture);
  assert.deepEqual(groups.map(g => [g.file.name, g.sessions.length]), [['multi.ndjson', capture.sessions.length - 1], ['one.ndjson', 1]]);
  assert.deepEqual(sessionsByFile(null), []);
  const lines = example('success').trim().split('\n'), half = Math.ceil(lines.length / 2);
  const split = importFiles([{ name: 'first.ndjson', text: lines.slice(0, half).join('\n') + '\n' }, { name: 'second.ndjson', text: lines.slice(half).join('\n') + '\n' }]);
  assert.equal(split.sessions.length, 1);
  assert.deepEqual(sessionsByFile(split).map(g => [g.file.name, g.sessions.length]), [['first.ndjson', 1], ['second.ndjson', 0]], 'a split session is listed once, under its first file');
});

test('folder store persists records in IndexedDB and has an in-memory fallback', async () => {
  const indexedDB = new IDBFactory();
  const store = await openFolderStore({ indexedDB });
  await store.put({ id: 'b', name: 'second', handle: { kind: 'directory', name: 'second' }, added: 2, transient: 'dropped' });
  await store.put({ id: 'a', name: 'first', handle: { kind: 'directory', name: 'first' }, added: 1 });
  store.close();
  const reopened = await openFolderStore({ indexedDB });
  assert.deepEqual((await reopened.list()).map(r => [r.id, r.handle.name, r.transient]), [['a', 'first', undefined], ['b', 'second', undefined]]);
  await reopened.delete('a');
  assert.deepEqual((await reopened.list()).map(r => r.id), ['b']);
  reopened.close();
  await assert.rejects(openFolderStore({ indexedDB: null }), /IndexedDB unavailable/);
  const memory = memoryFolderStore();
  await memory.put({ id: 'x', name: 'x', added: 1 });
  assert.equal((await memory.list()).length, 1);
  await memory.delete('x');
  assert.equal((await memory.list()).length, 0);
});

test('folder support detects picker, webkitdirectory fallback or none', () => {
  function Input() {} Input.prototype.webkitdirectory = false;
  assert.equal(folderSupport({ showDirectoryPicker() {}, isSecureContext: true }), 'picker');
  assert.equal(folderSupport({ showDirectoryPicker() {}, isSecureContext: false, HTMLInputElement: Input }), 'input');
  assert.equal(folderSupport({ HTMLInputElement: Input }), 'input');
  assert.equal(folderSupport({}), 'none');
  assert.equal(folderSupport(undefined), 'none');
  assert.equal(machineLabel('patrick-mbp.local'), 'patrick-mbp');
  assert.equal(machineLabel(' '), null);
});

test('collector status reports machine_name and session summaries carry first_event_at', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'explorer-status-'));
  let collector;
  try {
    collector = await startCollector({ directory, port: 0, activate: false });
    const status = await (await fetch(collector.origin + '/api/v2/status', { headers: { Authorization: `Bearer ${collector.browserToken}` } })).json();
    assert.equal(status.machine_name, hostname());
    assert.equal((await fetch(collector.origin + '/api/v2/status')).status, 401);
    const producer = JSON.parse(example('success').split('\n')[0]).data.producer;
    const source = await collector.enroll({ version: 2, registration_id: randomUUID(), platform: producer.platform, environment_id: 'explorer-test', app_id: producer.app_id, installation_id: randomUUID() });
    await collector.ingest(source.source_token, example('success'));
    const first = JSON.parse(example('success').split('\n')[0]);
    const page = await (await fetch(collector.origin + '/api/v2/sessions', { headers: { Authorization: `Bearer ${collector.browserToken}` } })).json();
    assert.equal(page.sessions[0].first_event_at, first.timestamp);
    assert.equal(page.sessions[0].name, first.data.name);
    const pinned = await collector.store.sessions({ high_water: collector.store.cursor - 1, latest: true });
    assert.equal(pinned.sessions[0].first_event_at, first.timestamp);
  } finally { await collector?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('collector client publishes machine name once per change', async () => {
  const names = [];
  let machine = 'patrick-mbp.local';
  const json = value => new Response(JSON.stringify(value));
  const client = new CollectorClient({ onMachine: value => names.push(value), fetcher: async url => json(url.includes('/status') ? { adapters: {}, machine_name: machine } : url.includes('/sources') ? { collector_id: 'c', event_cursor: 0, sources: [] } : { high_water: 0, sessions: [], has_more: false }) });
  await client.refresh(new AbortController().signal);
  await client.refresh(new AbortController().signal);
  machine = 'other';
  await client.refresh(new AbortController().signal);
  machine = undefined;
  await client.refresh(new AbortController().signal);
  assert.deepEqual(names, ['patrick-mbp.local', 'other', null]);
});

let server, Explorer;
before(async () => {
  server = await createServer({ configFile: fileURLToPath(new URL('../viewer/vite.config.mjs', import.meta.url)), server: { middlewareMode: true }, logLevel: 'silent' });
  Explorer = (await server.ssrLoadModule('/src/Explorer.jsx')).default;
});
after(async () => { await server?.close(); });

const nodeKey = (id, path = '') => `${id}:${path}`;
function fakeExplorer(overrides = {}) {
  return { support: 'picker', folders: [], listings: {}, expanded: new Set(['machine']), notice: '', focusId: null, clearFocus() {}, toggle() {}, addFolder() {}, addFiles() {}, remove() {}, refresh() {}, reconnect() {}, nodeKey, limits: EXPLORER_LIMITS, ...overrides };
}
const render = props => renderToStaticMarkup(React.createElement(Explorer, { explorer: fakeExplorer(), now, liveState: 'idle', onAllDevices() {}, onSource() {}, onLiveSession() {}, onMoreSessions() {}, onResume() {}, onImportedSession() {}, onOpenLog() {}, onSelectSession() {}, ...props }));
const hostile = '<img src=x onerror=alert(1)>';

test('explorer renders machine name, devices while paused, and escapes hostile names', () => {
  const sources = [{ source_id: 'src-1', environment_id: 'env', environment_name: 'Test phone', app_id: 'dev.app', platform: 'android', status: 'Ready and waiting for events', last_seen: Date.parse('2026-10-20T14:00:00Z') }];
  const sessions = [{ session_namespace: 'ns', session_id: 'one', name: hostile, event_count: 3, source_ids: ['src-1'], first_event_at: '2026-10-20T14:32:00Z' }];
  const html = render({ machineName: `${hostile}.local`, liveAvailable: true, liveState: 'idle', sources, sessions, current: { kind: 'live', sessionId: JSON.stringify(['ns', 'one']) } });
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /This machine <span>· &lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
  assert.match(html, /Devices and environments<span>· Paused<\/span>/);
  assert.match(html, />Resume live</);
  assert.match(html, /<summary title="env"><span class="name">Test phone<\/span>/);
  assert.match(html, /<span class="label">Android<\/span>/);
  assert.match(html, /title="Android · dev.app\nReady and waiting for events/);
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.match(html, /class="tree-row session-row live-session" aria-current="true"/);
  assert.match(html, /<time dateTime="2026-10-20T14:32:00.000Z"><span class="sr-only">started <\/span>14:32<\/time>/);
  const live = render({ machineName: 'patrick-mbp.local', liveAvailable: true, liveState: 'live', sources, sessions });
  assert.doesNotMatch(live, /Resume live|Paused/);
  assert.match(live, /This machine <span>· patrick-mbp<\/span>/);
  assert.match(live, /title="patrick-mbp.local"/);
});

test('static explorer shows This computer, hides devices, and offers fallbacks per support level', () => {
  const html = render({});
  assert.match(html, /This computer/);
  assert.doesNotMatch(html, /Devices and environments/);
  assert.match(html, /Add folder…/);
  assert.match(html, /Add a folder to browse its .ndjson logs/);
  assert.match(render({ explorer: fakeExplorer({ support: 'input' }) }), /<input[^>]*webkitdirectory=""/);
  assert.match(render({ explorer: fakeExplorer({ support: 'input' }) }), /Add folder \(this visit only\)/);
  const none = render({ explorer: fakeExplorer({ support: 'none' }), onChooseFiles() {} });
  assert.match(none, /Folder access needs Chrome or Edge; use Import files\./);
  assert.match(none, /Choose files…/);
  assert.doesNotMatch(none, /Add folder…/);
});

test('folder nodes show Reconnect, unavailable states and labeled log rows', () => {
  const folders = [
    { id: 'f1', name: 'logs', status: 'ready', persisted: true },
    { id: 'f2', name: 'Downloads', status: 'prompt', persisted: true },
    { id: 'f3', name: 'moved', status: 'missing', persisted: true },
  ];
  const entries = sortEntries([
    { kind: 'directory', name: 'sub', path: 'sub/' },
    { kind: 'file', name: 'a.ndjson', path: 'a.ndjson', lastModified: 0, header: { name: hostile, startedAt: '2026-10-19T09:10:00Z', sessions: 3, events: 9, complete: true } },
    { kind: 'file', name: 'b.ndjson', path: 'b.ndjson', lastModified: Date.parse('2026-10-03T00:00:00Z'), header: { name: 'Checkout', startedAt: '2026-10-03T08:00:00Z', sessions: 1 } },
    { kind: 'file', name: 'b-2.ndjson', path: 'b-2.ndjson', lastModified: 0, header: { name: 'Checkout', startedAt: '2026-10-03T09:00:00Z', sessions: 1 } },
    { kind: 'file', name: 'broken.ndjson', path: 'broken.ndjson', lastModified: 0, header: { error: 'Unreadable' } },
  ]);
  const explorer = fakeExplorer({ folders, expanded: new Set(['machine', 'f1:', 'f2:']), listings: { 'f1:': { state: 'ready', entries, overflow: 4, logs: 4, at: now.getTime() } } });
  const html = render({ explorer, current: { kind: 'folder', key: 'f1:b.ndjson' } });
  assert.match(html, /<span class="name">logs\/<\/span>/);
  assert.match(html, />Refresh<\/button>/);
  assert.match(html, />Reconnect<\/button>/);
  assert.match(html, /· access needed/);
  assert.match(html, /⚠ Folder unavailable/);
  assert.match(html, /<span class="name">sub\/<\/span>/);
  assert.ok(html.indexOf('sub/</span>') < html.indexOf('Mon 09:10'), 'subfolders render before logs');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;<\/span><span class="count" title="3 sessions">\+2<\/span>/);
  assert.match(html, /Mon 09:10/);
  assert.equal((html.match(/<span class="sub mono">b(-2)?\.ndjson<\/span>/g) || []).length, 2, 'identical name + time shows filenames');
  assert.match(html, /⚠ Unreadable/);
  assert.match(html, /4 more not shown/);
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.match(html, /aria-current="true" title="Checkout\nb.ndjson/);
  assert.doesNotMatch(html, /<img\b/);
});

test('imported files list single sessions as rows and multi-session files as nodes', () => {
  const capture = importFiles([{ name: 'multi.ndjson', text: example('multi-session') }, { name: 'one.ndjson', text: example('success') }]);
  const html = render({ imported: capture, current: { kind: 'import', sessionId: capture.sessions.at(-1).id } });
  assert.match(html, /<h3>Imported files<\/h3>/);
  assert.match(html, /<span class="name">multi.ndjson<\/span><small>\d sessions<\/small>/);
  assert.match(html, /<span class="label">success<\/span>/);
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.doesNotMatch(html, /Session metadata not recorded/);
});

test('subfolders nest up to maxDepth levels below an added folder', () => {
  const dir = (name, path) => ({ kind: 'directory', name, path });
  const folders = [{ id: 'f', name: 'root', status: 'ready', persisted: true }];
  const listings = { 'f:': { state: 'ready', entries: [dir('a', 'a/')], overflow: 0, logs: 0 }, 'f:a/': { state: 'ready', entries: [dir('b', 'a/b/')], overflow: 0, logs: 0 } };
  const html = render({ explorer: fakeExplorer({ folders, listings, expanded: new Set(['machine', 'f:', 'f:a/']), limits: { ...EXPLORER_LIMITS, maxDepth: 1 } }) });
  assert.match(html, /<span class="name">a\/<\/span>/, 'depth 1 is listable when maxDepth is 1');
  assert.match(html, /b\/ · too deep to list/);
  const truncated = render({ explorer: fakeExplorer({ folders, listings: { 'f:': { state: 'ready', entries: [], overflow: 0, logs: 0, truncated: true } }, expanded: new Set(['machine', 'f:']) }) });
  assert.match(truncated, /Listing stopped after 5000 entries/);
});

test('paused header separates its badge and source times are announced as last seen', () => {
  const sources = [{ source_id: 's', environment_id: 'e', app_id: 'a', platform: 'ios', status: 'Last seen with retained history', last_seen: Date.parse('2026-10-20T14:00:00Z') }];
  const html = render({ liveAvailable: true, liveState: 'idle', sources, explorer: fakeExplorer({ storageNotice: 'This browser can’t remember folders; they stay listed until reload.' }) });
  assert.match(html, /<h3>Devices and environments<span>· Paused<\/span><\/h3>/);
  assert.doesNotMatch(html, / id="/);
  assert.match(html, /<span class="glyph" aria-hidden="true">◌<\/span><span class="name"><span class="label">iOS<\/span><\/span><time[^>]*><span class="sr-only">last seen <\/span>14:00/);
  assert.match(html, /can’t remember folders/);
});
