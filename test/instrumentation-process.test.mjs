import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finishOwnedCleanup, runOwnedProcess } from "../scripts/lib/instrumentation-process.mjs";

const exited = (pid) => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

test("timeout escalates a TERM-ignoring owned helper and rejects after close", async () => {
  await assert.rejects(runOwnedProcess(process.execPath, ["-e", `
    process.on('SIGTERM', () => {});
    console.log(process.pid);
    setInterval(() => {}, 10000);
  `], { timeout: 1000, terminationGrace: 50 }), (error) => {
    assert.match(error.message, /timed out/);
    assert.equal(error.signal, "SIGKILL");
    exited(Number(error.stdout.toString().trim()));
    return true;
  });
});

test("stdin failure closes the helper before rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "networklog-owned-process-"));
  const pidPath = join(directory, "pid");
  try {
    await assert.rejects(runOwnedProcess(process.execPath, ["-e", `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[1], String(process.pid));
      fs.closeSync(0);
      setInterval(() => {}, 10000);
    `, pidPath], { input: Buffer.alloc(2 * 1024 * 1024), timeout: 5000, terminationGrace: 50 }),
    (error) => { assert.equal(error.code, "EPIPE");return true; });
    exited(Number(await readFile(pidPath, "utf8")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("helper output is bounded and overflow still closes the process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "networklog-owned-process-"));
  const pidPath = join(directory, "pid");
  try {
    await assert.rejects(runOwnedProcess(process.execPath, ["-e", `
      require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => process.stdout.write('x'.repeat(8192)), 5);
    `, pidPath], { outputLimit: 1024, timeout: 5000, terminationGrace: 50 }), (error) => {
      assert.match(error.message, /output exceeded/);
      assert.ok(error.stdout.length + error.stderr.length <= 1024);
      return true;
    });
    exited(Number(await readFile(pidPath, "utf8")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("route failure cannot skip collector/history cleanup or hide original failure", async () => {
  const primary = new Error("instrumentation failed"), route = new Error("owned route changed"), history = new Error("history verification failed");
  const calls = [];
  await assert.rejects(finishOwnedCleanup([
    async () => { calls.push("route");throw route; },
    async () => { calls.push("collector"); },
    async () => { calls.push("history");throw history; },
    async () => { calls.push("remaining routes"); },
  ], primary), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.deepEqual(error.errors, [primary, route, history]);
    return true;
  });
  assert.deepEqual(calls, ["route", "collector", "history", "remaining routes"]);
  await assert.rejects(finishOwnedCleanup([async () => {}], primary), (error) => error === primary);
});
