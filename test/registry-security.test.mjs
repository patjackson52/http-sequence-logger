import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateJSON, confined, descriptor, validateGenerationInventory } from '../collector/registry.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'registry-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('private descriptor reads reject public files, symlinks, non-files and oversized input', async t => {
  const root = await directory(t), path = join(root, 'source.json');
  await writeFile(path, '{"value":"safe"}', { mode: 0o600 });
  assert.deepEqual(await privateJSON(path), { value: 'safe' });
  await chmod(path, 0o644);
  await assert.rejects(privateJSON(path), /Unsafe private JSON/);
  await chmod(path, 0o600);
  const alias = join(root, 'alias.json');
  await symlink(path, alias);
  await assert.rejects(privateJSON(alias), /Unsafe private JSON/);
  await assert.rejects(privateJSON(root), /Unsafe private JSON/);
  await writeFile(path, 'x'.repeat(16385));
  await assert.rejects(privateJSON(path), /Unsafe private JSON/);
});

test('private JSON rejects invalid UTF-8 and measures its limit in bytes', async t => {
  const root = await directory(t), path = join(root, 'source.json');
  await writeFile(path, Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), { mode: 0o600 });
  await assert.rejects(privateJSON(path), /encoded data was not valid/);
  const body = JSON.stringify({ label: '🧭' });
  await writeFile(path, body);
  assert.deepEqual(await privateJSON(path, Buffer.byteLength(body)), { label: '🧭' });
  await assert.rejects(privateJSON(path, Buffer.byteLength(body) - 1), /Unsafe private JSON/);
  await writeFile(path, '{');
  await assert.rejects(privateJSON(path), SyntaxError);
});

test('malformed private credential JSON never exposes parser input in diagnostics', async t => {
  const root = await directory(t), path = join(root, 'pairing.json');
  for (const raw of ['PRIVATE_TEST_SECRET_XYZ', '{"source_token":PRIVATE_TEST_SECRET_XYZ}', '{"enrollment_token":PRIVATE_TEST_SECRET_XYZ}']) {
    await writeFile(path, raw, { mode: 0o600 });
    await assert.rejects(privateJSON(path), error => {
      assert.ok(error instanceof SyntaxError, 'Owner recovery needs the parse-error type');
      assert.match(error.message, /Invalid private JSON/);
      assert.doesNotMatch(error.message, /PRIVATE_TE|source_token|enrollment_token/);
      assert.equal(error.cause, undefined, 'A raw parser cause would retain credential fragments');
      return true;
    });
  }
});

test('capture confinement rejects traversal, external symlink targets and nonregular captures', async t => {
  const root = await directory(t), container = join(root, 'app');
  await mkdir(join(container, 'journals', 'generation'), { recursive: true });
  const capture = join(container, 'journals', 'generation', 'capture.ndjson');
  await writeFile(capture, 'retained\n', { mode: 0o600 });
  assert.equal(await confined(container, 'journals/generation/capture.ndjson'), await realpath(capture));
  for (const relative of [capture, '../outside.ndjson', 'journals/../capture.ndjson', 'journals//capture.ndjson', 'journals\\..\\capture.ndjson']) {
    await assert.rejects(confined(container, relative), /Unsafe capture path/);
  }
  const outside = join(root, 'outside.ndjson');
  await writeFile(outside, 'outside\n', { mode: 0o600 });
  await symlink(outside, join(container, 'escaped.ndjson'));
  await assert.rejects(confined(container, 'escaped.ndjson'), /escapes container/);
  await assert.rejects(confined(container, 'journals/generation'), /not regular/);
});

test('only the current fixed opt-in descriptor matching the enumerated app is accepted', () => {
  const valid = { version: 2, platform: 'ios', app_id: 'dev.example', installation_id: 'installation', journal_directory: 'journals' };
  assert.deepEqual(descriptor(valid, 'ios', 'dev.example'), valid);
  for (const changes of [{ version: 1 }, { platform: 'android' }, { app_id: 'dev.other' }, { installation_id: '' }, { installation_id: 'x'.repeat(257) }, { journal_directory: '../captures' }]) {
    assert.throws(() => descriptor({ ...valid, ...changes }, 'ios', 'dev.example'), /Invalid opt-in source descriptor/);
  }
});

test('existing installation inventory detects whole-generation loss without requiring logs from an initialized app', () => {
  assert.deepEqual(validateGenerationInventory(undefined, []), []);
  const inventory = { version: 2, reservations: { first: 1000, second: 0 } };
  assert.deepEqual(validateGenerationInventory(inventory, ['first', 'second']), ['first', 'second']);
  assert.throws(() => validateGenerationInventory(inventory, ['second']), /Retained journal generation missing: first/);
  // A newly created directory can precede its first inventory publication.
  assert.deepEqual(validateGenerationInventory(inventory, ['first', 'second', 'allocating']), ['first', 'second']);
  for (const value of [null, { version: 1, reservations: {} }, { version: 2, reservations: [] }, { version: 2, reservations: { '../escape': 1 } }, { version: 2, reservations: { first: -1 } }, { version: 2, reservations: { first: 1.5 } }, { version: 2, reservations: { first: Number.MAX_SAFE_INTEGER + 1 } }]) {
    assert.throws(() => validateGenerationInventory(value, ['first']), /Invalid installation journal inventory/);
  }
  assert.throws(() => validateGenerationInventory({ version: 2, reservations: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['generation-' + i, 0])) }, []), /generation limit/);
});
