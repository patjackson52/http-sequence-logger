import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { LogExplorerController } from '../viewer/src/use-log-explorer.mjs';
import { memoryFolderStore, openFolderStore } from '../viewer/src/folder-store.mjs';

const text = readFileSync(new URL('../examples/success.ndjson', import.meta.url), 'utf8');
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const file = (name, body = text) => ({ kind: 'file', name, async getFile() { return new File([body], name, { lastModified: 1000 }); } });
function dir(name, children = [], { gate, permission = 'granted', grant = 'granted', fail } = {}) {
  const handle = { kind: 'directory', name, children, signals: [], permission, requests: 0,
    async *values() { if (fail) throw Object.assign(new Error('moved'), { name: fail }); if (gate) await gate.promise; yield* handle.children; },
    async isSameEntry(other) { return other === handle || other?.alias === handle; },
    async queryPermission() { return handle.permission; },
    async requestPermission() { handle.requests++; handle.permission = grant; return grant; } };
  return handle;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fakeStore(records = [], { failDelete = false } = {}) {
  const store = memoryFolderStore(), puts = [];
  for (const r of records) store.put(r);
  return { puts, list: store.list, async put(r) { puts.push(r.id); await store.put(r); }, async delete(id) { if (failDelete) throw new Error('quota'); await store.delete(id); }, close() {} };
}
const controller = (options = {}) => new LogExplorerController({ support: 'picker', progressMs: 0, ...options });
const rows = (c, id, path = '') => c.state.listings[`${id}:${path}`]?.entries?.map(e => e.name);

test('IndexedDB unavailable falls back to memory: folders are not persisted and the notice stays', async () => {
  const handle = dir('logs', [file('a.ndjson')]);
  const c = controller({ openStore: async () => { throw new Error('blocked'); }, picker: async () => handle });
  await c.init();
  assert.equal(c.state.durable, false);
  assert.match(c.state.storageNotice, /can’t remember folders/);
  const id = await c.addFolder();
  assert.equal(c.state.folders[0].persisted, false);
  await c.addFolder(); // duplicate add resets the transient notice only
  assert.match(c.state.storageNotice, /can’t remember folders/);
  assert.match(c.state.notice, /already listed/);
  assert.equal(c.state.focusId, id);
  await settle();
  assert.deepEqual(rows(c, id), ['a.ndjson']);
});

test('a folder added before the store opens waits and is persisted', async () => {
  const opening = deferred(), store = fakeStore();
  const c = controller({ openStore: () => opening.promise, picker: async () => dir('early', [file('a.ndjson')]) });
  c.init();
  const adding = c.addFolder();
  await settle();
  assert.equal(c.state.folders.length, 0);
  opening.resolve(store);
  const id = await adding;
  assert.deepEqual(store.puts, [id]);
  assert.equal(c.state.folders[0].persisted, true);
});

test('picker cancel is silent, other picker errors are reported, dedupe and max folders hold', async () => {
  let next;
  const c = controller({ openStore: async () => fakeStore(), picker: async () => { if (next instanceof Error) throw next; return next; }, limits: { maxFolders: 2 } });
  await c.init();
  next = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  assert.equal(await c.addFolder(), null); assert.equal(c.state.notice, '');
  next = Object.assign(new Error('blocked by policy'), { name: 'SecurityError' });
  assert.equal(await c.addFolder(), null); assert.match(c.state.notice, /blocked by policy/);
  const one = dir('one'), two = dir('two');
  next = one; const first = await c.addFolder();
  next = { alias: one, name: 'one-again' }; assert.equal(await c.addFolder(), first);
  next = two; await c.addFolder();
  next = dir('three'); assert.equal(await c.addFolder(), null);
  assert.match(c.state.notice, /up to 2 folders/);
  assert.deepEqual(c.state.folders.map(f => f.name), ['one', 'two']);
});

test('removing a folder mid-scan aborts it and drops the late result', async () => {
  const gate = deferred(), handle = dir('slow', [file('a.ndjson')], { gate });
  const c = controller({ openStore: async () => fakeStore(), picker: async () => handle });
  await c.init();
  const id = await c.addFolder();
  assert.equal(c.state.listings[`${id}:`].state, 'loading');
  const scan = c.scans.get(`${id}:`);
  assert.equal(await c.remove(id), true);
  assert.equal(scan.signal.aborted, true);
  gate.resolve(); await settle();
  assert.deepEqual(c.state.folders, []);
  assert.equal(c.state.listings[`${id}:`], undefined);
});

test('refresh aborts the previous scan and picks up new files; a stale load cannot overwrite a newer one', async () => {
  const gate = deferred(), handle = dir('logs', [file('a.ndjson')], { gate });
  const c = controller({ openStore: async () => fakeStore(), picker: async () => handle });
  await c.init();
  const id = await c.addFolder();
  const first = c.scans.get(`${id}:`);
  handle.children = [file('a.ndjson'), file('b.ndjson')];
  c.refresh(id);
  assert.equal(first.signal.aborted, true);
  gate.resolve(); await settle();
  assert.deepEqual(rows(c, id).sort(), ['a.ndjson', 'b.ndjson']);
  assert.equal(c.state.listings[`${id}:`].state, 'ready');
});

test('restored folders honor prompt and denied permissions; Reconnect grants and lists', async () => {
  const prompt = dir('Downloads', [file('a.ndjson')], { permission: 'prompt' }), denied = dir('Secret', [], { permission: 'denied', grant: 'denied' });
  const store = fakeStore([{ id: 'p', name: 'Downloads', handle: prompt, added: 1 }, { id: 'd', name: 'Secret', handle: denied, added: 2 }]);
  const c = controller({ openStore: async () => store });
  await c.init();
  assert.deepEqual(c.state.folders.map(f => [f.id, f.status, f.persisted]), [['p', 'prompt', true], ['d', 'denied', true]]);
  c.toggle('p:', true, c.state.folders[0], '');
  await settle();
  assert.equal(c.state.listings['p:'], undefined, 'no listing without permission');
  await c.reconnect('p'); await settle();
  assert.equal(prompt.requests, 1);
  assert.equal(c.state.folders[0].status, 'ready');
  assert.deepEqual(rows(c, 'p'), ['a.ndjson']);
  await c.reconnect('d');
  assert.equal(c.state.folders[1].status, 'denied');
});

test('listing errors mark missing folders; failed IndexedDB delete keeps the row', async () => {
  const gone = dir('moved', [], { fail: 'NotFoundError' });
  const c = controller({ openStore: async () => fakeStore([], { failDelete: true }), picker: async () => gone });
  await c.init();
  const id = await c.addFolder(); await settle();
  assert.equal(c.state.folders[0].status, 'missing');
  assert.equal(await c.remove(id), false);
  assert.equal(c.state.folders.length, 1);
  assert.match(c.state.notice, /Couldn’t remove moved\/: quota/);
});

test('progress updates are throttled', async () => {
  let now = 0;
  const handle = dir('many', Array.from({ length: 250 }, (_, i) => file(`n-${i}.txt`)));
  const c = controller({ openStore: async () => fakeStore(), picker: async () => handle, progressMs: 1000, clock: () => now });
  await c.init();
  let updates = 0; c.subscribe(() => updates++);
  await c.addFolder(); await settle();
  assert.ok(updates <= 4, `expected few updates, got ${updates}`);
});

test('real IndexedDB round trip restores and forgets folders across controllers', async () => {
  const indexedDB = new IDBFactory(), openStore = () => openFolderStore({ indexedDB });
  const first = controller({ openStore, picker: async () => ({ kind: 'directory', name: 'plain' }) });
  await first.init();
  const id = await first.addFolder();
  assert.equal(first.state.folders[0].persisted, true);
  first.dispose();
  const second = controller({ openStore });
  await second.init();
  assert.deepEqual(second.state.folders.map(f => [f.id, f.name, f.status, f.persisted]), [[id, 'plain', 'ready', true]]);
  assert.equal(await second.remove(id), true);
  second.dispose();
  const third = controller({ openStore });
  await third.init();
  assert.deepEqual(third.state.folders, []);
  third.dispose();
});
