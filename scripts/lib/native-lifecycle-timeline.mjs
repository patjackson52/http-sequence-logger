import assert from "node:assert/strict";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CollectorClient } from "../../viewer/src/collector-client.mjs";

export const timestamp = () => ({ wall_ms: Date.now(), monotonic_ms: performance.now() });
export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export async function boundedRead(path, limit = 16384) {
  const handle = await open(path, "r");
  try {
    const chunks = [];let total = 0;
    while (total <= limit) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));total += bytesRead;
    }
    assert(total <= limit, "Private evidence file exceeded read budget");
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

export function warmMissBoundaries(rows, platform, target) {
  const adapter = platform === "android" ? "android" : "ios-simulator";
  const matches = rows.filter((row) => row.name === adapter && Array.isArray(row.devices) && row.devices.some((device) =>
    platform === "android" ? device.serial === target && device.state === "device" : device.udid === target));
  if (matches.length < 2) return null;
  const [first, second] = matches;
  const wallDelta = second.wall_ms - first.wall_ms, monotonicDelta = second.monotonic_ms - first.monotonic_ms;
  assert(wallDelta >= 0 && wallDelta < 10000 && monotonicDelta >= 0 && monotonicDelta < 10000,
    "First full tick exceeded the 10000ms inventory cache bound; warm cache unverified");
  return { first_tick_start: first, second_tick_start: second, wall_delta_ms: wallDelta,
    monotonic_delta_ms: monotonicDelta, cache_ttl_ms: 10000, warm_cache_verified: true };
}

export async function waitForWarmMiss(observations, platform, target, descriptorAbsent) {
  const until = performance.now() + 60000;
  while (performance.now() < until) {
    const boundaries = warmMissBoundaries(observations.tick_starts, platform, target);
    if (boundaries) {
      assert(await descriptorAbsent(), "Owned descriptor must remain absent after the first complete agnostic tick");
      const adapter = platform === "android" ? "android" : "ios-simulator";
      const candidates = observations.candidates.filter((row) => row.name === adapter + ":" + target);
      assert(candidates.length, "Owned target inventory candidate count missing");
      return { ...boundaries, candidates, descriptor_absent_checked_after_second_boundary: timestamp(),
        agnostic: true, filters: { device: null, app: null },
        scope: "The second structural tick start follows the first tick's completed workers and polling interval. The uniquely owned app was installed before startup, its descriptor remains absent, and the cache-age upper bound is under its 10s TTL. Actual SDK launch follows this boundary; no per-command observer or favorable-phase retry." };
    }
    await delay(25);
  }
  throw new Error("Two agnostic installed-target tick boundaries did not complete before launch deadline");
}

export async function persistStage(directory, stage) {
  assert(/^[a-z][a-z-]{0,63}$/.test(stage.name), "Invalid private stage evidence name");
  await writeFile(join(directory, "stage-" + stage.name + "-timing.json"), JSON.stringify(stage, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

export function cleanupRecorder(directory, errors) {
  const phases = [];
  const save = async () => {
    try { await writeFile(join(directory, "cleanup-progress.json"), JSON.stringify(phases, null, 2) + "\n", { mode: 0o600 }); }
    catch (error) { errors.push({ action: "persist cleanup phase", error: error.message }); }
  };
  return async (label, action, timeout = 15000) => {
    const phase = { label, before: timestamp(), finished: false };phases.push(phase);await save();
    let timer;
    try {
      await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " did not finish within " + timeout + "ms; graceful ownership release unproven")), timeout);
      })]);
      phase.passed = true;return true;
    } catch (error) {
      phase.passed = false;phase.error = error.message;errors.push({ action: label, error: error.message });return false;
    } finally { clearTimeout(timer);phase.after = timestamp();phase.finished = true;await save(); }
  };
}

// The production watcher still enumerates every authorized device and app.
// This private collector can pair only the uniquely named fixture it owns.
export function observeLifecycle(collector, app) {
  const observations = { enrollment: [], durable_events: new Map(), viewer_events: new Map(), viewer_sources: new Map(), denied_foreign_apps: new Set(), candidates: [], tick_starts: [] };
  const own = (metadata) => {
    if (metadata.app_id !== app) {
      observations.denied_foreign_apps.add(metadata.app_id);
      throw new Error("Private acceptance collector preserves other application pairing");
    }
  };
  const enroll = collector.enroll.bind(collector);
  collector.enroll = async (metadata, ...args) => {
    own(metadata);
    const result = await enroll(metadata, ...args);
    observations.enrollment.push({ ...timestamp(), installation_id: metadata.installation_id, source_id: result.source_id });
    return result;
  };
  const bind = collector.store.bindLocal.bind(collector.store);
  collector.store.bindLocal = (token, metadata) => { own(metadata);return bind(token, metadata); };
  const ingest = collector.store.ingest.bind(collector.store);
  collector.store.ingest = async (...args) => {
    const result = await ingest(...args), at = timestamp();
    for (const line of args[1].split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (!observations.durable_events.has(event.event_id)) observations.durable_events.set(event.event_id, at);
    }
    return result;
  };
  const status = collector.setAdapterStatus.bind(collector);
  collector.setAdapterStatus = (name, value) => {
    if ((name === "android" || name === "ios-simulator") && Array.isArray(value.devices)) observations.tick_starts.push({ name, devices: value.devices, ...timestamp() });
    if (value.reason?.includes("candidates")) observations.candidates.push({ name, reason: value.reason, ...timestamp() });
    status(name, value);
  };
  const client = new CollectorClient({ token: collector.browserToken,
    fetcher: (path, options) => fetch(collector.origin + path, options),
    onSources: (sources) => {
      for (const source of sources) if (source.app_id === app && !observations.viewer_sources.has(source.source_id)) observations.viewer_sources.set(source.source_id, timestamp());
    },
    onCapture: (raw) => {
      const at = timestamp();
      for (const line of raw.split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (!observations.viewer_events.has(event.event_id)) observations.viewer_events.set(event.event_id, at);
      }
    },
  });
  const running = client.run();
  return {
    observations,
    async ready() {
      const until = performance.now() + 15000;
      while (!client.collectorId && performance.now() < until) await delay(25);
      assert.equal(client.collectorId, collector.store.config.collector_id, "Real Node viewer client did not connect");
    },
    stage(launch, marker, source, events) {
      assert(marker.sdk_call, "Actual fixture SDK call timestamps missing");
      const ids = events.map((event) => event.event_id);
      assert(ids.every((id) => observations.durable_events.has(id) && observations.viewer_events.has(id)), "Missing actual ingest ACK/viewer receipt timestamps");
      const registration = observations.enrollment.find((entry) => entry.source_id === source.source_id);
      const viewerSource = observations.viewer_sources.get(source.source_id);
      assert(registration && viewerSource, "Missing registry/viewer source timestamps");
      const receipt = ids.map((id) => observations.viewer_events.get(id));
      return { launch, sdk_call: marker.sdk_call, registry_row_after_enrollment_ack: registration,
        viewer_registry_row: viewerSource,
        events: ids.map((id) => ({ event_id: id, ingest_ack: observations.durable_events.get(id), viewer_receipt: observations.viewer_events.get(id) })),
        registry_row_preexists_launch: registration.monotonic_ms < launch.before.monotonic_ms,
        launch_to_registry_ms: registration.monotonic_ms < launch.before.monotonic_ms ? null : registration.monotonic_ms - launch.before.monotonic_ms,
        launch_to_both_events_viewer_ms: Math.max(...receipt.map((at) => at.monotonic_ms)) - launch.before.monotonic_ms,
        sdk_call_duration_ms: Number(BigInt(marker.sdk_call.after_monotonic_ns) - BigInt(marker.sdk_call.before_monotonic_ns)) / 1e6,
        clock_scope: "Host launch/ACK/Node viewer callbacks share one host monotonic clock. SDK call bracket uses its native monotonic clock. Native wall timestamps are retained; no cross-clock SDK-to-viewer interval or rendered UI claim." };
    },
    async close() { client.stop();await running; },
  };
}
