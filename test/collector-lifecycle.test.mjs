import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CaptureStore } from "../collector/store.mjs";
import { publishManifest } from "../collector/registry.mjs";
import { advertiseCollector } from "../collector/bonjour.mjs";
import {
  decodeAndroidControl,
  decodeAndroidJournalNames,
  androidDescriptorProbeCommand,
  decodeAndroidDescriptorCandidates,
} from "../collector/android-live.mjs";
import { awaitExportDrain } from "../collector/server.mjs";

test("bounded Android batch probing sees initialization after a miss and preserves unexpected access errors", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/descriptor-probe-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir + "/test.app", { recursive: true });
  const packages = ["test.app", "test.denied", "test.release"];
  const command = androidDescriptorProbeCommand(packages);
  await mkdir(dir + "/bin");
  await writeFile(dir + "/bin/run-as", `#!/bin/sh\ncase "$1" in test.denied) printf 'run-as: permission denied'; exit 1;; test.release) printf 'run-as: package not debuggable: test.release'; exit 1;; esac\npkg=$1; shift 3; cd "$FIXTURE_ROOT/$pkg" && exec "$@"\n`, { mode: 0o700 });
  const probe = async () => decodeAndroidDescriptorCandidates(Buffer.from(
    (await promisify(execFile)("/bin/sh", ["-c", command], {
      env: { ...process.env, FIXTURE_ROOT: dir, PATH: dir + "/bin:" + process.env.PATH }, maxBuffer: 16385, timeout: 10000,
    })).stdout), packages);
  assert.deepEqual(await probe(), ["test.denied"]);
  await mkdir(dir + "/test.app/no_backup/HTTPSequenceLogger", { recursive: true });
  await writeFile(dir + "/test.app/no_backup/HTTPSequenceLogger/source.json", "{}");
  assert.deepEqual(await probe(), ["test.app", "test.denied"]);
  for (const invalid of [["test.app;touch /tmp/unsafe"], Array(33).fill("test.app"), ["a." + "b".repeat(256)]])
    assert.throws(() => androidDescriptorProbeCommand(invalid));
  for (const invalid of ["Dtest.foreign\n", "Dtest.app\ntest.app\n", "N", "Dtest.app;echo x\n"])
    assert.throws(() => decodeAndroidDescriptorCandidates(Buffer.from(invalid), packages));
  assert.throws(() => decodeAndroidDescriptorCandidates(Buffer.from([68, 255]), packages));
});

test("expired presence changes the registry once, preserves history and resumes immediately", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/source-expiry-"),
    s = new CaptureStore(dir);
  await s.ready;
  t.after(async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ticket = await s.ticket({ principal: "test" }),
    source = await s.register(ticket.enrollment_token, {
      version: 2,
      registration_id: randomUUID(),
      platform: "ios",
      environment_id: "test-phone",
      app_id: "test.app",
      installation_id: randomUUID(),
    });
  const before = await s.sources();
  assert.equal(before.sources[0].status, "Ready and waiting for events");
  const expired = await s.expirePresence(Date.now() + 31000);
  assert.equal(expired.changed, true);
  assert.ok(expired.registry_revision > before.registry_revision);
  const once = await s.expirePresence(Date.now() + 31000);
  assert.equal(once.changed, false);
  assert.equal(once.registry_revision, expired.registry_revision);
  const visible = await s.sources();
  assert.equal(visible.sources[0].status, "Last seen with retained history");
  assert.match(visible.sources[0].reason, /unknown/);
  assert.equal(visible.event_cursor, 0);
  await s.presence(source.source_token, { instance_id: "foreground-resumed" });
  const resumed = await s.sources();
  assert.equal(resumed.sources[0].status, "Ready and waiting for events");
  assert.equal(resumed.sources[0].reason, null);
});

test("source pagination is revision-bound and missing pages restart after registry changes", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/source-pages-"),
    s = new CaptureStore(dir);
  await s.ready;
  t.after(async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 3; i++) {
    const grant = await s.ticket({ principal: "test" });
    await s.register(grant.enrollment_token, {
      version: 2,
      registration_id: randomUUID(),
      platform: "android",
      environment_id: "emulator",
      app_id: "test.app." + i,
      installation_id: randomUUID(),
    });
  }
  const first = await s.sources({ limit: 1 });
  assert.equal(first.sources.length, 1);
  assert.equal(first.has_more, true);
  const second = await s.sources({
    limit: 1,
    after: first.next_after,
    registry_revision: first.registry_revision,
  });
  assert.notEqual(second.sources[0].source_id, first.sources[0].source_id);
  await s.sourceStatus(
    first.sources[0].source_id,
    "Backlog retained",
    "Disk error",
  );
  await assert.rejects(
    s.sources({
      after: second.next_after,
      registry_revision: first.registry_revision,
    }),
    (e) => e.status === 409,
  );
});

test("stalled export drain honors its deadline and every completion removes losing listeners", async (t) => {
  const keepalive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepalive));
  for (const event of ["drain", "close"]) {
    const res = new EventEmitter();
    res.destroyed = false;
    const promise = awaitExportDrain(res, Date.now() + 1000);
    assert.equal(res.listenerCount(event), 1);
    res.emit(event);
    await promise;
    for (const name of ["drain", "close", "error"])
      assert.equal(res.listenerCount(name), 0);
  }
  const stalled = new EventEmitter();
  stalled.destroyed = false;
  const started = performance.now();
  await assert.rejects(
    awaitExportDrain(stalled, Date.now() + 20),
    (e) => e.status === 408,
  );
  assert.ok(performance.now() - started < 1000);
  for (const name of ["drain", "close", "error"])
    assert.equal(stalled.listenerCount(name), 0);
  const errored = new EventEmitter();
  errored.destroyed = false;
  const waiting = awaitExportDrain(errored, Date.now() + 1000);
  errored.emit("error", new Error("socket failed"));
  await assert.rejects(waiting, /socket failed/);
  assert.equal(errored.listenerCount("close"), 0);
});

test("fresh authorized native grants preserve installation source identity across process journals", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/native-reprovision-"),
    s = new CaptureStore(dir);
  await s.ready;
  t.after(async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  const md = {
    version: 2,
    platform: "ios",
    environment_id: "private-installation",
    app_id: "example.debug",
    installation_id: randomUUID(),
    journal_id: randomUUID(),
    registration_id: randomUUID(),
  };
  const oldTicket = await s.ticket({
      principal: "native-pairing",
      max_sources: 1,
    }),
    old = await s.register(oldTicket.enrollment_token, md);
  const grant = await s.ticket({ principal: "native-pairing", max_sources: 1 }),
    current = await s.register(grant.enrollment_token, {
      ...md,
      journal_id: randomUUID(),
      registration_id: randomUUID(),
    });
  assert.equal(current.source_id, old.source_id);
  assert.equal((await s.sources()).sources.length, 1);
  await s.revoke(old.source_id);
  const rejected = await s.ticket({
    principal: "native-pairing",
    max_sources: 1,
  });
  await assert.rejects(
    s.register(rejected.enrollment_token, {
      ...md,
      registration_id: randomUUID(),
    }),
    (e) => e.status === 401,
  );
});

test("Android metadata markers distinguish missing files, empty explicit selections and remote errors", () => {
  assert.equal(decodeAndroidControl(Buffer.from("N")), null);
  assert.equal(decodeAndroidControl(Buffer.from("F")).length, 0);
  assert.throws(() => decodeAndroidControl(Buffer.from([70, 255])));
  assert.throws(
    () => JSON.parse(decodeAndroidControl(Buffer.from("F"))),
    SyntaxError,
  );
  assert.equal(
    JSON.parse(decodeAndroidControl(Buffer.from('F{"version":2}'))).version,
    2,
  );
  for (const response of [
    "",
    "U",
    "NX",
    "run-as: package not an application: system.app",
  ])
    assert.throws(() => decodeAndroidControl(Buffer.from(response)));
  assert.throws(
    () =>
      decodeAndroidControl(
        Buffer.concat([Buffer.from("F"), Buffer.alloc(16385)]),
      ),
    /limit/,
  );
});

test("adapter recovery clears only its matched backlog error without asserting producer activity", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/adapter-recovery-"),
    s = new CaptureStore(dir);
  await s.ready;
  t.after(async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  const grant = await s.ticket({ principal: "test" });
  const source = await s.register(grant.enrollment_token, {
    version: 2,
    registration_id: randomUUID(),
    platform: "android",
    environment_id: "emulator",
    app_id: "test.app",
    installation_id: randomUUID(),
  });
  await s.sourceStatus(source.source_id, "Backlog retained", "ADB unavailable");
  const before = (await s.sources()).sources[0].last_seen;
  assert.equal(
    (await s.sourceReconciled(source.source_token, "Different error")).changed,
    false,
  );
  assert.equal(
    (await s.sourceReconciled(source.source_token, "ADB unavailable")).changed,
    true,
  );
  const recovered = (await s.sources()).sources[0];
  assert.equal(recovered.status, "Last seen with retained history");
  assert.match(recovered.reason, /activity unknown/);
  assert.equal(recovered.last_seen, before);
  for (const status of ["Storage full", "Permission required"]) {
    await s.sourceStatus(source.source_id, status, "Continuing error");
    assert.equal(
      (await s.sourceReconciled(source.source_token, "Continuing error"))
        .changed,
      false,
    );
    assert.equal((await s.sources()).sources[0].status, status);
  }
  await s.sourceStatus(source.source_id, "Backlog retained", "Original error");
  await s.presence(source.source_token);
  assert.equal(
    (await s.sourceReconciled(source.source_token, "Original error")).changed,
    false,
  );
  assert.equal(
    (await s.sources()).sources[0].status,
    "Ready and waiting for events",
  );
  await s.revoke(source.source_id);
  await assert.rejects(
    s.sourceReconciled(source.source_token, "Original error"),
    (e) => e.status === 401,
  );
  await s.close();
  const restarted = new CaptureStore(dir);
  await restarted.ready;
  assert.equal(
    (await restarted.sources()).sources[0].status,
    "Permission required",
  );
  await restarted.close();
});

test(
  "optional Bonjour close resolves failed spawn and bounds an unresponsive child",
  { skip: process.platform !== "darwin" },
  async () => {
    const collector = {
      connections: [
        { endpoint: "https://example.test:44319", collector_id: randomUUID() },
      ],
      setAdapterStatus() {},
    };
    const failed = new EventEmitter();
    failed.pid = undefined;
    failed.kill = () => false;
    const broken = advertiseCollector(collector, {
      enabled: true,
      spawnProcess: () => failed,
      shutdownMs: 20,
    });
    failed.emit(
      "error",
      Object.assign(new Error("not found"), { code: "ENOENT" }),
    );
    await broken.close();
    const child = new EventEmitter(),
      signals = [];
    child.pid = 123;
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    const live = advertiseCollector(collector, {
      enabled: true,
      spawnProcess: () => child,
      shutdownMs: 20,
    });
    const before = performance.now();
    await live.close();
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.ok(performance.now() - before < 1000);
  },
);

test("simultaneous stale manifest claimants cannot steal a fresh owner", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/manifest-reclaim-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = dir + "/active.json";
  await writeFile(
    path + ".owner",
    JSON.stringify({ pid: 2147483647, instance_id: randomUUID() }),
    { mode: 0o600 },
  );
  const collector = {
    origin: "http://127.0.0.1:12345",
    store: {
      config: { collector_id: randomUUID() },
      async ticket() {
        return { enrollment_token: "test", expires_at: Date.now() + 10000 };
      },
    },
  };
  const outcomes = await Promise.all([
    publishManifest(collector, path),
    publishManifest(collector, path),
  ]);
  assert.equal(outcomes.filter((x) => x.active).length, 1);
  await Promise.all(outcomes.map((x) => x.close()));
  await assert.rejects(stat(path + ".owner"), (e) => e.code === "ENOENT");
  await assert.rejects(
    stat(path + ".owner.reclaim"),
    (e) => e.code === "ENOENT",
  );
});

test("simultaneous stale database claimants retain exactly one store owner", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/store-reclaim-");
  await writeFile(dir + "/collector.lock", "2147483647", { mode: 0o600 });
  const stores = [new CaptureStore(dir), new CaptureStore(dir)];
  t.after(async () => {
    await Promise.all(stores.map((s) => s.close().catch(() => {})));
    await rm(dir, { recursive: true, force: true });
  });
  const results = await Promise.allSettled(stores.map((s) => s.ready));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const owner = stores[results.findIndex((r) => r.status === "fulfilled")];
  assert.equal((await owner.status()).collector_id, owner.config.collector_id);
  await owner.close();
  const reopened = new CaptureStore(dir);
  await reopened.ready;
  await reopened.close();
});

test("fresh simultaneous manifest startups safely diagnose a still-initializing owner", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/manifest-fresh-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const collector = {
    origin: "http://127.0.0.1:12345",
    store: {
      config: { collector_id: randomUUID() },
      async ticket() {
        return { enrollment_token: "test" };
      },
    },
  };
  for (let i = 0; i < 20; i++) {
    const path = dir + "/active-" + i + ".json";
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => publishManifest(collector, path)),
    );
    assert.equal(outcomes.filter((x) => x.active).length, 1);
    await Promise.all(outcomes.map((x) => x.close()));
  }
});

test("manifest and store close callers share one ownership cleanup", async (t) => {
  const dir = await mkdtemp(tmpdir() + "/close-coalesce-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = dir + "/active.json",
    collector = {
      origin: "http://127.0.0.1:12345",
      store: {
        config: { collector_id: randomUUID() },
        async ticket() {
          return { enrollment_token: "test" };
        },
      },
    };
  const first = await publishManifest(collector, path);
  const one = first.close(),
    two = first.close();
  assert.equal(one, two);
  await one;
  const successor = await publishManifest(collector, path);
  assert.equal(successor.active, true);
  await first.close();
  assert.ok((await stat(path + ".owner")).isFile());
  await successor.close();
  const store = new CaptureStore(dir + "/db");
  await store.ready;
  const a = store.close(),
    b = store.close();
  assert.equal(a, b);
  await a;
});

test("Android generation enumeration uses explicit status and one name per line", () => {
  const names = [randomUUID(), randomUUID(), randomUUID()];
  assert.deepEqual(
    decodeAndroidJournalNames(Buffer.from("D" + names.join("\n") + "\n")),
    names,
  );
  assert.deepEqual(decodeAndroidJournalNames(Buffer.from("N")), []);
  assert.deepEqual(decodeAndroidJournalNames(Buffer.from("D")), []);
  assert.throws(
    () =>
      decodeAndroidJournalNames(
        Buffer.from("D" + names.slice(0, 2).join("  ")),
      ),
    /listing/,
  );
  for (const raw of [
    Buffer.from(""),
    Buffer.from("U"),
    Buffer.from("D../escape"),
    Buffer.from([68, 255]),
  ])
    assert.throws(() => decodeAndroidJournalNames(raw));
  assert.throws(
    () =>
      decodeAndroidJournalNames(
        Buffer.from("D" + Array.from({ length: 129 }, randomUUID).join("\n")),
      ),
    /count/,
  );
});
