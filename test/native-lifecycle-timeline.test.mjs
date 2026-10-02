import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { startCollector } from "../collector/server.mjs";
import { boundedRead, cleanupRecorder, delay, observeLifecycle, persistStage, timestamp, warmMissBoundaries, waitForWarmMiss } from "../scripts/lib/native-lifecycle-timeline.mjs";
import { runOwnedProcess } from "../scripts/lib/instrumentation-process.mjs";

test("timeline records real HTTP upload ACK and real Node viewer receipt; rejects foreign enrollment/bind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "networklog-lifecycle-timeline-"));
  let collector, timeline;
  try {
    collector = await startCollector({ directory, port: 0, activate: false });
    timeline = observeLifecycle(collector, "com.example.shop");await timeline.ready();
    const metadata = { version: 2, platform: "android", environment_id: "timeline-host-test", app_id: "com.example.shop", installation_id: randomUUID(), journal_id: randomUUID(), registration_id: randomUUID() };
    await assert.rejects(async () => collector.enroll({ ...metadata, app_id: "foreign.app" }), /preserves other application pairing/);
    await assert.rejects(async () => collector.store.bindLocal("foreign-token", { ...metadata, app_id: "foreign.app" }), /preserves other application pairing/);
    assert.equal((await collector.store.sources()).sources.length, 0);
    const launch = { before: timestamp() }, source = await collector.enroll(metadata);
    const events = (await readFile(new URL("../examples/success.ndjson", import.meta.url), "utf8")).trim().split("\n").slice(0, 2).map(JSON.parse);
    const response = await fetch(collector.origin + "/api/v2/events", { method: "POST", headers: { Authorization: "Bearer " + source.source_token, "Content-Type": "application/x-ndjson" }, body: events.map(JSON.stringify).join("\n") + "\n" });
    assert.equal(response.status, 200);await response.json();
    const until = performance.now() + 5000;
    while (!events.every((event) => timeline.observations.viewer_events.has(event.event_id)) && performance.now() < until) await delay(10);
    const measured = timeline.stage(launch, { sdk_call: { before_monotonic_ns: "1000000", after_monotonic_ns: "2000000", descriptor_verified_after_return: true } }, source, events);
    assert.equal(measured.sdk_call_duration_ms, 1);
    assert.equal(measured.registry_row_preexists_launch, false);
    assert(measured.launch_to_registry_ms >= 0);
    assert(measured.launch_to_both_events_viewer_ms >= measured.launch_to_registry_ms);
    assert(measured.events.every((event) => event.viewer_receipt.monotonic_ms >= event.ingest_ack.monotonic_ms));
    assert.equal((await collector.store.page({ after: 0 })).lines.length, 2);
  } finally {
    await timeline?.close();await collector?.close();await rm(directory, { recursive: true, force: true });
  }
});

test("warm miss requires two structural authorized-target tick boundaries below cache TTL", async () => {
  const target = "emulator-owned";
  const boundary = (wall, mono, devices = [{ serial: target, state: "device" }]) => ({ name: "android", devices, wall_ms: wall, monotonic_ms: mono });
  const first = boundary(1000, 10), second = boundary(4000, 3010);
  assert.equal(warmMissBoundaries([first, boundary(2000, 1010, [{ serial: "other", state: "device" }])], "android", target), null);
  assert.equal(warmMissBoundaries([first, boundary(2000, 1010, [{ serial: target, state: "unauthorized" }])], "android", target), null);
  assert.equal(warmMissBoundaries([first, { ...second, name: "android:" + target }], "android", target), null);
  const evidence = warmMissBoundaries([first, second], "android", target);
  assert.equal(evidence.wall_delta_ms, 3000);assert.equal(evidence.warm_cache_verified, true);
  assert.throws(() => warmMissBoundaries([first, boundary(11000, 10010)], "android", target), /warm cache unverified/);
  assert.throws(() => warmMissBoundaries([first, boundary(4000, 10010)], "android", target), /warm cache unverified/);
  const observations = { tick_starts: [first, second], candidates: [{ name: "android:" + target, reason: "123 package candidates for Android user 0" }] };
  await assert.rejects(waitForWarmMiss(observations, "android", target, async () => false), /descriptor must remain absent/);
  const warm = await waitForWarmMiss(observations, "android", target, async () => true);
  assert.equal(warm.candidates[0].reason, "123 package candidates for Android user 0");assert.deepEqual(warm.filters, { device: null, app: null });
  const sim = "owned-sim", ios = [first, second].map(row => ({ ...row, name: "ios-simulator", devices: [{ udid: sim }] }));
  assert.equal(warmMissBoundaries(ios, "ios", sim).warm_cache_verified, true);
});

test("owned simulator modes reject an arbitrary target before tools/state access", async () => {
  const script = new URL("../scripts/check-native-installation-lifecycle.mjs", import.meta.url).pathname;
  for (const mode of ["--owned-simulator", "--owned-simulator-erase"]) {
    const result = await runOwnedProcess(process.execPath, [script, "--platform", "ios", mode, "--simulator", randomUUID()], { timeout: 5000 });
    assert.equal(result.code, 2);assert.match(result.stderr.toString(), /Owned mode refuses an arbitrary pre-existing/);
  }
  const conflicting = await runOwnedProcess(process.execPath, [script, "--platform", "ios", "--owned-simulator", "--owned-simulator-erase"], { timeout: 5000 });
  assert.equal(conflicting.code, 2);assert.match(conflicting.stderr.toString(), /Choose one owned simulator mode/);
});

test("stage timing survives a labeled owner-close timeout and remaining cleanup continues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "networklog-lifecycle-cleanup-"));
  try {
    const limited = join(directory,"limited");await writeFile(limited,Buffer.alloc(65537));await assert.rejects(boundedRead(limited,65536),/exceeded read budget/);
    const stage = { name: "initial", timing: { launch: { before: timestamp() }, sdk_call: { api: "fixture" } } };
    await persistStage(directory, stage);
    const errors = [], clean = cleanupRecorder(directory, errors);let collectorClosed = false;
    assert.equal(await clean("close watcher", () => new Promise(() => {}), 20), false);
    assert.equal(await clean("close collector", async () => { collectorClosed = true; }), true);
    assert.equal(collectorClosed, true);
    assert.match(errors[0].error, /graceful ownership release unproven/);
    assert.deepEqual(JSON.parse(await boundedRead(join(directory, "stage-initial-timing.json"))), stage);
    const phases = JSON.parse(await boundedRead(join(directory, "cleanup-progress.json")));
    assert.deepEqual(phases.map((phase) => [phase.label, phase.finished, phase.passed]), [["close watcher", true, false], ["close collector", true, true]]);
    assert(phases.every((phase) => phase.after.monotonic_ms >= phase.before.monotonic_ms));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
