import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const configFile = fileURLToPath(new URL('../web-sample/vite.config.mjs', import.meta.url));
await build({ configFile, mode: 'capture', logLevel: 'error' });
await build({ configFile, mode: 'production', logLevel: 'error' });
async function contents(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) output.push(...await contents(path)); else output.push(await readFile(path, 'utf8'));
  }
  return output;
}
const debug = (await contents(new URL('../web-sample/dist-debug/', import.meta.url))).join('\n');
const shipping = (await contents(new URL('../web-sample/dist/', import.meta.url))).join('\n');
for (const marker of ['http.request.started', 'IndexedDBJournal', '__network_log', 'Export NDJSON', 'capture.observation_stop_reason']) {
  assert.ok(debug.includes(marker), `Positive debug marker missing: ${marker}`);
  assert.ok(!shipping.includes(marker), `Production contains development marker: ${marker}`);
}
const entry = await readFile(new URL('../web-sdk/src/api.mjs', import.meta.url), 'utf8');
assert.ok(!/^import\s/m.test(entry), 'No-op entry imports another module');
const pkg = JSON.parse(await readFile(new URL('../web-sdk/package.json', import.meta.url), 'utf8'));
assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
console.log('PASS debug positive controls, production graph, all emitted assets/maps, no-op entry, zero runtime package dependencies');
