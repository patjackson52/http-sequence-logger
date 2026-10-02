import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('public CLI help exits successfully without service, device or file operations', t => {
  const directory = mkdtempSync(join(tmpdir(), 'network-log-help-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const commands = [
    ['collector/cli.mjs', ['--help']],
    ['collector/cli.mjs', ['status', '--manifest', join(directory, 'absent-manifest'), '--help']],
    ['collector/cli.mjs', ['doctor', '--adb', join(directory, 'absent-adb'), '--help']],
    ['scripts/android-live.mjs', ['--adb', join(directory, 'absent-adb'), '--help']],
    ['scripts/check-comparison.mjs', ['--help']],
    ['validate.mjs', ['--help']],
    ['sequence-diff/cli.mjs', ['--help']],
    ['sequence-diff/cli.mjs', ['normalize', 'absent.ndjson', '--output', join(directory, 'output.json'), '--help']],
    ['sequence-diff/cli.mjs', ['compare', 'absent.ndjson', 'absent.ndjson', '--options', 'absent-profile.json', '--help']],
  ];
  for (const [entry, args] of commands) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../' + entry, import.meta.url)), ...args], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined, entry);
    assert.equal(result.status, 0, entry + ': ' + result.stderr);
    assert.match(result.stdout, /Usage/i, entry);
    assert.equal(result.stderr, '', entry);
    assert.deepEqual(readdirSync(directory), [], entry + ' help created state/output');
  }
});

test('capture validation retains success, missing-input and unreadable-file exit semantics', () => {
  const entry = fileURLToPath(new URL('../validate.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 10000 });
  let result = run([]);
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /Usage/);
  result = run([fileURLToPath(new URL('../examples/success.ndjson', import.meta.url))]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /VALID/);
  result = run([fileURLToPath(new URL('../examples/does-not-exist.ndjson', import.meta.url))]);
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /ENOENT/);
});
