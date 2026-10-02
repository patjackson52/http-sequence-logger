import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import Database from "better-sqlite3";
import { CaptureStore } from "../collector/store.mjs";
import { startCollector } from "../collector/server.mjs";

const fixture = JSON.parse(
  (await readFile(new URL("../examples/success.ndjson", import.meta.url), "utf8"))
    .split("\n")[0],
);
const encode = (event) => JSON.stringify(event) + "\n";
const status = (code) => (error) => error.status === code;
const metadata = (extra = {}) => ({
  version: 2,
  registration_id: randomUUID(),
  platform: "android",
  environment_id: "acceptance-device",
  app_id: "acceptance.app",
  installation_id: randomUUID(),
  journal_id: randomUUID(),
  ...extra,
});
function clock() {
  const buffer = new SharedArrayBuffer(8), values = new BigInt64Array(buffer);
  const initial = Date.now();
  Atomics.store(values, 0, BigInt(initial));
  return { buffer, initial, set: (now) => Atomics.store(values, 0, BigInt(now)) };
}
function filesystemFaults() {
  const buffer = new SharedArrayBuffer(16), values = new BigInt64Array(buffer);
  Atomics.store(values, 0, -1n);
  return { buffer, values };
}
function releaseGate(buffer) {
  if (!buffer) return;
  const gate = new Int32Array(buffer);
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
}
async function ownedStore(t, limits = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "collector-acceptance-"));
  const stores = [];
  const open = async () => {
    const store = new CaptureStore(directory, limits, options);
    stores.push(store);
    await store.ready;
    return store;
  };
  t.after(async () => {
    releaseGate(options.testCommitGate);
    await Promise.all(stores.map((store) => store.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return { store: await open(), open, directory };
}
async function enroll(store, md = metadata()) {
  const grant = await store.ticket({ principal: "acceptance" });
  return store.register(grant.enrollment_token, md);
}
function sameCredential(actual, expected) {
  for (const key of ["version", "collector_id", "source_id", "source_token"])
    assert.equal(actual[key], expected[key]);
}
function numbered(sequence, recording = "acceptance-recording") {
  return { ...fixture, event_id: `${recording}/${sequence}`, recording_id: recording, sequence };
}

test("single-installation redemption recovers a lost response across restart, expires and requires fresh provisioning", { timeout: 10000 }, async (t) => {
  const time = clock();
  const owned = await ownedStore(t, {}, { testClock: time.buffer });
  let store = owned.store;
  const md = metadata();
  const ticket = await store.ticket({ principal: "native-pairing", ttl: 1000, max_sources: 1 });
  const source = await store.register(ticket.enrollment_token, md);
  sameCredential(await store.register(ticket.enrollment_token, md), source);
  await assert.rejects(store.register(ticket.enrollment_token, metadata()), status(429));
  await assert.rejects(store.register(ticket.enrollment_token, { ...md, registration_id: randomUUID() }), status(429));
  await assert.rejects(store.register(ticket.enrollment_token, { ...md, app_id: "conflicting.app" }), status(409));
  assert.equal((await store.sources()).sources.length, 1);
  await store.close();
  store = await owned.open();
  time.set(time.initial + 1001);
  sameCredential(await store.register(ticket.enrollment_token, md), source);
  await assert.rejects(store.register(ticket.enrollment_token, metadata()), status(401));
  time.set(time.initial + 1200001);
  await assert.rejects(store.register(ticket.enrollment_token, md), status(401));
  const fresh = await store.ticket({ principal: "native-pairing", max_sources: 1 });
  const repaired = await store.register(fresh.enrollment_token, { ...md, registration_id: randomUUID(), journal_id: randomUUID() });
  assert.equal(repaired.source_id, source.source_id);
  assert.notEqual(repaired.source_token, source.source_token);
  assert.equal((await store.sources()).sources.length, 1);
  assert.equal((await store.authorize(repaired.source_token)).source_id, source.source_id);
});

test("a scoped enrollment cannot recover another installation's registration operation", { timeout: 10000 }, async (t) => {
  const { store } = await ownedStore(t);
  const first = metadata(), second = metadata();
  const grant = await store.ticket({ principal: "scoped", scope: { installation_id: first.installation_id }, max_sources: 1 });
  const source = await store.register(grant.enrollment_token, first);
  const otherGrant = await store.ticket({ principal: "scoped", scope: { installation_id: second.installation_id }, max_sources: 1 });
  await assert.rejects(store.register(otherGrant.enrollment_token, first), status(403));
  const other = await store.register(otherGrant.enrollment_token, second);
  assert.notEqual(other.source_id, source.source_id);
  assert.equal((await store.sources()).sources.length, 2);
  sameCredential(await store.register(grant.enrollment_token, first), source);
});

test("HTTP source rotation has a bounded overlap and revocation immediately rejects every credential while retaining history", { timeout: 10000 }, async (t) => {
  const time = clock(), directory = await mkdtemp(join(tmpdir(), "collector-acceptance-http-"));
  const collector = await startCollector({ directory, port: 0, testClock: time.buffer });
  t.after(async () => { await collector.close(); await rm(directory, { recursive: true, force: true }); });
  const md = metadata(), source = await collector.enroll(md, "native-pairing");
  const rotated = await collector.store.rotate(source.source_id);
  assert.equal(rotated.source_id, source.source_id);
  assert.notEqual(rotated.source_token, source.source_token);
  const request = (token, route, body) => fetch(collector.origin + route, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": route.endsWith("events") ? "application/x-ndjson" : "application/json" },
    body,
    signal: AbortSignal.timeout(3000),
  });
  const upload = async (token, sequence, expected) => {
    const response = await request(token, "/api/v2/events", encode(numbered(sequence)));
    assert.equal(response.status, expected);
    const result = await response.json();
    if (expected === 200) assert.equal(result.accepted, 1);
    return result;
  };
  await upload(source.source_token, 1, 200);
  await upload(rotated.source_token, 2, 200);
  time.set(time.initial + 59999);
  await upload(source.source_token, 3, 200);
  time.set(time.initial + 60000);
  await upload(source.source_token, 4, 401);
  await upload(rotated.source_token, 4, 200);
  await collector.store.revoke(source.source_id);
  for (const token of [source.source_token, rotated.source_token]) {
    await upload(token, 5, 401);
    const response = await request(token, "/api/v2/presence", "{}");
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
  const grant = await collector.store.ticket({ principal: "native-pairing", max_sources: 1 });
  await assert.rejects(collector.store.register(grant.enrollment_token, { ...md, registration_id: randomUUID() }), status(401));
  assert.deepEqual((await collector.store.page({ source_id: source.source_id })).lines.map((line) => JSON.parse(line).sequence), [1, 2, 3, 4]);
  assert.equal((await collector.store.sources()).sources[0].status, "Permission required");
  await collector.close();
  const reopened = new CaptureStore(directory, {}, { testClock: time.buffer });
  try {
    await reopened.ready;
    for (const token of [source.source_token, rotated.source_token])
      await assert.rejects(reopened.authorize(token), status(401));
    assert.equal((await reopened.page({ source_id: source.source_id })).lines.length, 4);
  } finally { await reopened.close(); }
});

test("physical database/WAL/backup capacity rejects new bytes without losing history, checkpoints or replay ACKs", { timeout: 10000 }, async (t) => {
  const { store, directory } = await ownedStore(t, { physicalBytes: 1024 * 1024 });
  const source = await enroll(store), first = encode(numbered(1)), second = encode(numbered(2));
  const checkpoint = { generation: "physical", offset: Buffer.byteLength(first) };
  await store.ingest(source.source_token, first, { key: "journal", value: checkpoint });
  const backups = join(directory, "backups"), padding = join(backups, "acceptance-padding.sqlite");
  await mkdir(backups, { mode: 0o700 });
  await writeFile(padding, Buffer.alloc(1024 * 1024), { mode: 0o600 });
  const usage = await store.status();
  assert.ok(usage.physical_bytes > usage.limits.physicalBytes);
  assert.equal(usage.physical_bytes, usage.database_bytes + usage.wal_bytes + 1024 * 1024);
  assert.ok((await store.sources()).sources[0].bytes < usage.limits.sourceBytes);
  await assert.rejects(store.ingest(source.source_token, second, { key: "journal", value: { offset: 999 } }), status(507));
  await assert.rejects(store.backup(), status(507));
  assert.deepEqual(await readdir(backups), ["acceptance-padding.sqlite"]);
  assert.equal((await store.ingest(source.source_token, first)).duplicates, 1);
  assert.equal((await store.page()).lines.length, 1);
  assert.deepEqual(await store.checkpoint(source.source_id, "journal"), checkpoint);
  await rm(padding);
  assert.equal((await store.ingest(source.source_token, second)).accepted, 1);
});

test("free-space reserve rejects a batch atomically and admits it after space returns", { timeout: 10000 }, async (t) => {
  const faults = filesystemFaults(), freeReserve = 16384;
  const { store } = await ownedStore(t, { freeReserve }, { testFilesystemFaults: faults.buffer });
  const source = await enroll(store), first = encode(numbered(1)), second = encode(numbered(2));
  const checkpoint = { generation: "free-space", offset: Buffer.byteLength(first) };
  await store.ingest(source.source_token, first, { key: "journal", value: checkpoint });
  Atomics.store(faults.values, 0, BigInt(freeReserve + Buffer.byteLength(second) - 1));
  await assert.rejects(store.ingest(source.source_token, second, { key: "journal", value: { offset: 999 } }), status(507));
  assert.equal(store.cursor, 1);
  assert.deepEqual(await store.checkpoint(source.source_id, "journal"), checkpoint);
  Atomics.store(faults.values, 0, 0n);
  await assert.rejects(store.backup(), status(507));
  assert.equal((await store.ingest(source.source_token, first)).duplicates, 1);
  assert.deepEqual((await store.page()).lines, [first.trimEnd()]);
  Atomics.store(faults.values, 0, BigInt(freeReserve + Buffer.byteLength(second)));
  assert.equal((await store.ingest(source.source_token, second)).accepted, 1);
});

test("a failed online backup removes its partial destination and keeps prior snapshots and the live store usable", { timeout: 10000 }, async (t) => {
  const faults = filesystemFaults();
  const { store, directory } = await ownedStore(t, {}, { testFilesystemFaults: faults.buffer });
  const source = await enroll(store);
  await store.ingest(source.source_token, encode(numbered(1)));
  const before = await store.backup(), originalBytes = await readFile(before.path);
  Atomics.store(faults.values, 1, 1n);
  await assert.rejects(store.backup(), status(507));
  assert.equal(Atomics.load(faults.values, 1), 0n);
  assert.deepEqual(await readFile(before.path), originalBytes);
  assert.deepEqual(await readdir(join(directory, "backups")), [before.path.split("/").at(-1)]);
  assert.equal((await store.ingest(source.source_token, encode(numbered(2)))).accepted, 1);
  const after = await store.backup();
  assert.notEqual(after.path, before.path);
  for (const [snapshot, count] of [[before, 1], [after, 2]]) {
    const db = new Database(snapshot.path, { readonly: true, fileMustExist: true });
    try {
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(db.prepare("select count(*) count from events").get().count, count);
      assert.equal(db.prepare("select id from sources").get().id, source.source_id);
    } finally { db.close(); }
  }
});

async function waitForStall(buffer) {
  const gate = new Int32Array(buffer);
  await Atomics.waitAsync(gate, 1, 0, 3000).value;
  assert.equal(Atomics.load(gate, 1), 1, "worker must enter the controlled commit stall");
}

test("two sources rotate fairly through bounded jobs and source bytes while reserved control admission stays bounded", { timeout: 10000 }, async (t) => {
  const gate = new SharedArrayBuffer(8), text = (name, n) => encode(numbered(n, `source-${name}`));
  const bytes = Buffer.byteLength(text("a", 1));
  const { store } = await ownedStore(t, { queueJobs: 6, queueBytes: bytes * 6, sourceQueueBytes: bytes * 3 }, { testCommitGate: gate });
  const a = await enroll(store), b = await enroll(store);
  const pending = [store.ingest(a.source_token, text("a", 1))];
  await waitForStall(gate);
  try {
    pending.push(store.ingest(a.source_token, text("a", 2)), store.ingest(a.source_token, text("a", 3)));
    await assert.rejects(store.ingest(a.source_token, text("a", 4)), status(429));
    pending.push(...[1, 2, 3].map((n) => store.ingest(b.source_token, text("b", n))));
    await setImmediate();
    assert.equal(store.jobs, 6);
    assert.equal(store.bytes, bytes * 6);
    await assert.rejects(store.ingest(b.source_token, text("b", 4)), status(429));
    const controls = Array.from({ length: 16 }, () => store.status());
    await setImmediate();
    assert.equal(store.jobs, 22);
    await assert.rejects(store.status(), status(429));
    assert.equal(store.cursor, 0, "a stalled transaction must never publish an ACK cursor");
    releaseGate(gate);
    const results = await Promise.all(pending);
    assert.ok(results.every((ack) => ack.accepted === 1));
    await Promise.all(controls);
    const committed = (await store.page()).lines.map((line) => JSON.parse(line).event_id);
    assert.deepEqual(committed, ["source-a/1", "source-a/2", "source-b/1", "source-a/3", "source-b/2", "source-b/3"]);
    assert.equal(store.jobs, 0);
    assert.equal(store.bytes, 0);
    assert.equal((await store.ingest(a.source_token, text("a", 4))).accepted, 1);
  } finally {
    releaseGate(gate);
    await Promise.allSettled(pending);
  }
});

test("aggregate byte admission rejects a second source before the job count limit and releases bytes after commit", { timeout: 10000 }, async (t) => {
  const gate = new SharedArrayBuffer(8), text = (name, n) => encode(numbered(n, `source-${name}`));
  const bytes = Buffer.byteLength(text("a", 1));
  const { store } = await ownedStore(t, { queueJobs: 8, queueBytes: bytes * 2, sourceQueueBytes: bytes * 2 }, { testCommitGate: gate });
  const a = await enroll(store), b = await enroll(store);
  const pending = [store.ingest(a.source_token, text("a", 1))];
  await waitForStall(gate);
  try {
    pending.push(store.ingest(b.source_token, text("b", 1)));
    await assert.rejects(store.ingest(b.source_token, text("b", 2)), status(429));
    assert.equal(store.jobs, 2);
    assert.equal(store.bytes, bytes * 2);
    releaseGate(gate);
    await Promise.all(pending);
    assert.equal(store.bytes, 0);
    assert.equal((await store.ingest(b.source_token, text("b", 2))).accepted, 1);
  } finally {
    releaseGate(gate);
    await Promise.allSettled(pending);
  }
});
