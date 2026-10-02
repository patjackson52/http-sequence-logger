// macOS-only: exhaust an owned 64 MiB image, never the host filesystem.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, open, readFile, rm, statfs, truncate, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCollector } from '../collector/server.mjs';
import { CaptureStore } from '../collector/store.mjs';

assert.equal(process.platform, 'darwin', 'This check requires macOS hdiutil');
const exec = promisify(execFile), artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(artifacts, 'disk-full-'));
const image = join(directory, 'bounded.dmg'), mount = join(directory, 'mount');
const filler = join(mount, 'bounded-padding');
await mkdir(mount, { mode: 0o700 });
let mounted = false, collector, restored;
const result = { kind: 'Actual HFS+ filesystem-full recovery on a bounded 64 MiB image; not power-loss or physical phone proof', checks: [] };
try {
  await exec('hdiutil', ['create', '-size', '64m', '-fs', 'HFS+', '-volname', 'NLogDiskFull', '-nospotlight', image], { timeout: 30000 });
  await exec('hdiutil', ['attach', image, '-nobrowse', '-owners', 'on', '-mountpoint', mount], { timeout: 30000 });
  mounted = true;
  const data = join(mount, 'collector');
  collector = await startCollector({ directory: data, port: 0, limits: { freeReserve: 0, physicalBytes: 128 * 1024 * 1024 } });
  const source = await collector.enroll({ version: 2, registration_id: randomUUID(), platform: 'android', environment_id: 'disk-full-test', app_id: 'test.disk', installation_id: randomUUID() });
  const fixture = (await readFile(new URL('../examples/redacted-truncated.ndjson', import.meta.url), 'utf8')).trim().split('\n');
  const seed = fixture[0] + '\n', large = JSON.parse(fixture[4]);
  large.data.body.content.data = 'a'.repeat(900 * 1024);
  for (const key of ['stored_bytes', 'observed_bytes', 'total_bytes']) large.data.body[key] = 900 * 1024;
  const body = JSON.stringify(large) + '\n';
  const checkpoint = { generation: 'g', offset: Buffer.byteLength(seed) };
  await collector.ingest(source.source_token, seed, { key: 'file', value: checkpoint });
  const handle = await open(filler, 'wx', 0o600);
  let written = 0, full = false;
  try {
    const block = Buffer.alloc(1024 * 1024);
    while (written < 128 * 1024 * 1024) {
      try { const out = await handle.write(block); written += out.bytesWritten; }
      catch (error) { if (error.code !== 'ENOSPC') throw error; full = true; break; }
    }
  } finally { await handle.close(); }
  assert.ok(full, 'The bounded image must actually report ENOSPC');
  result.paddingBytes = written;
  const request = () => fetch(collector.origin + '/api/v2/events', { method: 'POST', headers: { Authorization: 'Bearer ' + source.source_token, 'Content-Type': 'application/x-ndjson' }, body, signal: AbortSignal.timeout(10000) });
  const noSpace = await request();
  assert.notEqual(noSpace.status, 200); await noSpace.arrayBuffer();
  result.zeroSpaceStatus = noSpace.status;
  assert.equal(collector.store.cursor, 1);
  assert.deepEqual(await collector.store.checkpoint(source.source_id, 'file'), checkpoint);
  result.checks.push('Actual filesystem ENOSPC rejects upload without advancing history/checkpoint');
  // Leave enough for logical admission, but less than the body plus its SQLite
  // normalized copy and WAL frames, exercising an actual write/commit failure.
  const release = Math.ceil((Buffer.byteLength(body) + 8192) / 4096) * 4096;
  await truncate(filler, Math.max(0, written - release));
  const space = await statfs(data);
  result.availableBeforeSQLiteBytes = space.bavail * space.bsize;
  assert.ok(result.availableBeforeSQLiteBytes >= Buffer.byteLength(body));
  const sqliteFull = await request();
  const failure = await sqliteFull.json();
  assert.equal(sqliteFull.status, 507);
  assert.match(failure.error, /full|space/i);
  result.sqliteFullStatus = sqliteFull.status;
  assert.equal(collector.store.cursor, 1);
  assert.deepEqual((await collector.store.page()).lines, [seed.trimEnd()]);
  assert.deepEqual(await collector.store.checkpoint(source.source_id, 'file'), checkpoint);
  result.checks.push('SQLite filesystem-full failure rolls back the entire event transaction and returns no success ACK');
  await rm(filler);
  const repaired = await request(), ack = await repaired.json();
  assert.equal(repaired.status, 200); assert.equal(ack.accepted, 1); assert.equal(ack.duplicates, 0);
  result.checks.push('After freeing only test padding, exact event retry commits once');
  await collector.close(); collector = null;
  restored = new CaptureStore(data, { freeReserve: 0 }); await restored.ready;
  assert.equal(restored.cursor, 2);
  assert.deepEqual((await restored.page()).lines, [seed.trimEnd(), body.trimEnd()]);
  assert.equal((await restored.ingest(source.source_token, body)).duplicates, 1);
  result.checks.push('Fresh store reopening retains acknowledged events and replay identities');
  await restored.close(); restored = null;
  result.passed = true;
} catch (error) {
  result.passed = false; result.error = error.message; throw error;
} finally {
  // Free only this image's padding before cleanup, including assertion failures.
  const cleanupErrors = [];
  const cleanup = async action => { try { await action(); } catch (error) { cleanupErrors.push(error.message); } };
  await cleanup(() => rm(filler, { force: true }));
  await cleanup(() => collector?.close());
  await cleanup(() => restored?.close());
  if (mounted) await cleanup(async () => { await exec('hdiutil', ['detach', mount], { timeout: 30000 }); mounted = false; });
  if (!mounted) await cleanup(() => rm(image, { force: true }));
  if (cleanupErrors.length) { result.cleanupErrors = cleanupErrors; result.passed = false; }
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...result, evidence: join(directory, 'evidence.json') }, null, 2));
  if (cleanupErrors.length) throw new Error('Owned disk-image cleanup incomplete: ' + cleanupErrors.join('; '));
}
