// Host-only SIGKILL fixtures in private journals. Never accesses native devices or existing captures.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { platform, release } from "node:os";
import { runOwnedProcess } from "./lib/instrumentation-process.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = resolve(root, "artifacts/native-crash-stages", randomUUID());
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
const init = resolve(evidenceDirectory, "show-test-output.gradle");
await writeFile(init, "allprojects { tasks.withType(Test).configureEach { testLogging.showStandardStreams = true; outputs.upToDateWhen { false } } }\n", { mode: 0o600 });
const boundaries = ["temp_written", "temp_synced", "renamed", "directory_synced"];
const supportedStages = ["enqueue", "append_partial", "append_complete", "synced_unpublished", "published", "cursor_committed", "cursor_lost", ...["metadata", "cursor"].flatMap(kind => boundaries.map(stage => kind + "_" + stage))];
const results = [];
async function run(name, executable, args, cwd) {
  const started = Date.now();
  let result;
  try { result = await runOwnedProcess(executable, args, { cwd, env: process.env, timeout: 240000, outputLimit: 32 * 1024 * 1024 }); }
  catch (error) {
    await writeFile(resolve(evidenceDirectory, name + ".log"), Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]), { mode: 0o600 });
    throw error;
  }
  const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
  await writeFile(resolve(evidenceDirectory, name + ".log"), output, { mode: 0o600 });
  assert.equal(result.code, 0, `${name} crash-stage tests failed; see ${evidenceDirectory}`);
  const stages = [...output.matchAll(/NATIVE_CRASH_STAGE (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]));
  assert.deepEqual(stages.map(stage => stage.stage).sort(), [...supportedStages].sort());
  assert.ok(stages.every(stage => stage.passed && stage.hard_kill && stage.retained_history_unchanged));
  results.push({ name, executable, args, elapsed_ms: Date.now() - started, stages });
  console.log(`${name}: ${stages.length} controlled SIGKILL stages passed`);
}
const evidence = {
  date: new Date().toISOString(),
  host: { platform: platform(), release: release(), node: process.version },
  scope: "Host subprocess SIGKILL only at actual production append/sync and atomic journal.json/cursor publication boundaries, using private minimal persistence fixture lines and existing internal disk interfaces. Collector ACKs are modeled by a durable test receipt; these lines are not full-schema app captures. Reopen resynchronizes a surviving complete tail and republishes its watermark. Unsynced complete bytes surviving SIGKILL are not a power-loss durability guarantee. No native devices, public injection APIs, or existing captures are used.",
  unsupported: ["Device/process crashes on Android or iOS hardware/simulator, OS/kernel crashes, sudden power loss, and real SQLite collector ACK transport are outside this host matrix."],
  production_source_sha256:Object.fromEntries(await Promise.all(["android/logger/src/main/kotlin/dev/networklog/logger/JournalCompletions.kt","android/logger/src/main/kotlin/dev/networklog/logger/FileHttpEventSink.kt","ios/Sources/NetworkLogTransfer/DurableSpool.swift"].map(async path=>[path,createHash("sha256").update(await readFile(resolve(root,path))).digest("hex")]))),
  results,
};
try {
  await run("android-jvm", resolve(root, "android/gradlew"), ["--init-script", init, ":logger:testDebugUnitTest", "--tests", "dev.networklog.logger.NativeCrashTest"], resolve(root, "android"));
  if (process.platform !== "darwin") throw new Error("The Swift host crash matrix requires macOS; Android evidence was retained.");
  await run("ios-swift-host", "swift", ["test", "--filter", "NativeCrashTests"], resolve(root, "ios"));
  evidence.controlled_sigkill_count=results.reduce((count,result)=>count+result.stages.reduce((n,stage)=>n+1+stage.repeated_atomic_kills,0),0);
  assert.equal(evidence.controlled_sigkill_count,34);
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = error.message; process.exitCode = 1; }
const path = resolve(evidenceDirectory, "evidence.json");
await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
console.log(`${evidence.passed ? "PASS" : "FAIL"} native host crash matrix: ${results.reduce((count, result) => count + result.stages.length, 0)} completed SIGKILL stages; evidence ${path}`);
