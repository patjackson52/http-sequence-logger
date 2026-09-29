import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import configure from '../web-sample/vite.config.mjs';

test('production preview uses the production directory and no-op entry', () => {
  for (const environment of [
    { command: 'serve', mode: 'production', isPreview: true },
    { command: 'build', mode: 'production', isPreview: false },
  ]) {
    const config = configure(environment);
    assert.equal(config.build.outDir, 'dist');
    assert.match(config.resolve.alias['#logger'], /[\\/]src[\\/]api\.mjs$/);
    assert.match(config.resolve.alias['#setup'], /[\\/]setup-production\.mjs$/);
  }
  for (const environment of [
    { command: 'serve', mode: 'development', isPreview: false },
    { command: 'build', mode: 'capture', isPreview: false },
  ]) {
    const config = configure(environment);
    assert.equal(config.build.outDir, 'dist-debug');
    assert.match(config.resolve.alias['#logger'], /[\\/]src[\\/]index\.mjs$/);
    assert.match(config.resolve.alias['#setup'], /[\\/]setup-debug\.mjs$/);
  }
});

test('aborted fixture POSTs cause no unhandled rejection and both servers remain usable', async () => {
  // Isolate the process so a regression exposes the server crash without taking
  // down the test runner or leaving fixture listeners behind.
  const fixtureURL = new URL('../web-sample/fixture-server.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import { startFixtures } from ${JSON.stringify(fixtureURL)};
    const unhandled = [];
    process.on('unhandledRejection', error => unhandled.push(error.code || error.name));
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const reservations = [http.createServer(), http.createServer()];
    await Promise.all(reservations.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
    const [authPort, appPort] = reservations.map(server => server.address().port);
    await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
    const close = await startFixtures({ authPort, appPort });
    try {
      for (const port of [authPort, appPort]) {
        const request = http.request('http://127.0.0.1:' + port + '/token', {
          method: 'POST', headers: { 'Content-Length': '50000', Connection: 'close' },
        });
        request.on('error', () => {});
        await new Promise((resolve, reject) => {
          request.once('error', reject);
          request.write('unfinished JSON body', resolve);
        });
        // Let the server begin reading the advertised body before interrupting it.
        await wait(20);
        request.destroy();
      }
      await wait(30);
      const challenge = await fetch('http://127.0.0.1:' + authPort + '/challenge', { headers: { Connection: 'close' } });
      assert.equal(challenge.status, 200);
      assert.equal((await challenge.json()).challenge_id, 'demo-challenge');
      const proof = await fetch('http://127.0.0.1:' + appPort + '/proof', { headers: { Connection: 'close' } });
      assert.equal(proof.status, 200);
      assert.equal((await proof.json()).proof, 'local-demo-proof');
      assert.deepEqual(unhandled, []);
      console.log('PASS aborted POSTs handled; both fixture servers still respond');
    } finally { close(); }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 5000, maxBuffer: 32 * 1024,
  });
  assert.match(stdout, /PASS aborted POSTs handled/);
  assert.equal(stderr, '');
});
