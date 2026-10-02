#!/usr/bin/env node
// Actual device instrumentation with a fresh private collector/config/cache fixture. Existing app history and pairing stay untouched.
import assert from "node:assert/strict";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startCollector } from "../collector/server.mjs";
import { adbPath, connectedDevices, selectDevice, SAMPLE_PACKAGE } from "../collector/android-live.mjs";
import { validateCapture } from "../shared/validate.mjs";
import { runOwnedProcess, finishOwnedCleanup } from "./lib/instrumentation-process.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let requestedDevice = process.env.ANDROID_SERIAL, explicitAdb;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--help") {
    console.log("node scripts/check-android-instrumentation.mjs --device SERIAL [--adb PATH]\nRuns actual LiveFlow and four TransferFlow methods (offline method twice), with fresh cache-only pairing/captures and HTTP+pinned HTTPS. Requires an idle authorized Android target, JDK17 and SDK35. Preserves existing canonical journal/pairing hashes and reverse routes; saves new private evidence under artifacts/android-instrumentation/<UUID>.");
    process.exit(0);
  }
  assert.ok(["--device", "--adb"].includes(process.argv[i]) && process.argv[i + 1], "Unknown or missing option");
  const option = process.argv[i++], value = process.argv[i];
  if (option === "--device") requestedDevice = value;else explicitAdb = value;
}
assert.ok(requestedDevice, "Select --device SERIAL explicitly; an active capture or discovery benchmark must finish first.");
const adb = adbPath(explicitAdb), device = selectDevice(await connectedDevices(adb), requestedDevice);
const id = randomUUID(), evidenceDirectory = resolve(root, "artifacts/android-instrumentation", id);
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
const environment = { ...process.env };
if (!environment.JAVA_HOME) {
  const known = ["/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home", "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"].find(existsSync);
  if (known) environment.JAVA_HOME = known;
}
async function run(command, args, { input, log, timeout = 120000, cwd = root } = {}) {
  const result = await runOwnedProcess(command, args, { cwd, env: environment, input, timeout });
  if (log) await writeFile(resolve(evidenceDirectory, log), Buffer.concat([result.stdout, result.stderr]), { mode: 0o600 });
  assert.equal(result.code, 0, `${command} failed (${result.code}): ${result.stderr.toString("utf8").slice(0, 2000)}`);
  return result.stdout;
}
const adbRun = (args, options) => run(adb, ["-s", device.serial, ...args], options);
const quote = (text) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
const inApp = (command, options) => adbRun(["shell", "-T", `run-as ${SAMPLE_PACKAGE} sh -c ${quote(command)}`], options);
const reverseList = async () => (await adbRun(["reverse", "--list"])).toString("utf8").trim().split(/\r?\n/).filter(Boolean).sort();
async function snapshot() {
  const text = (await inApp("for root in no_backup/HTTPSequenceLogger files/captures; do if [ -d \"$root\" ]; then find \"$root\" -type f -exec sha256sum {} \\;; fi; done")).toString("utf8");
  const rows = text.trim().split(/\r?\n/).filter(Boolean).sort();
  assert.ok(rows.length <= 4096, "Canonical history inventory exceeds bounded verification budget");
  return rows;
}
let collector, beforeHistory, beforeReverse, fixture;
const ownedRoutes = new Map(), cases = [], exports = [];
const fixtureBase = `cache/networklog-acceptance/${id}`;
let preservedHistory = false, preservedRoutes = false;
let primaryError;
async function reverse(port) {
  await adbRun(["reverse", "--no-rebind", `tcp:${port}`, `tcp:${port}`]);ownedRoutes.set(port, true);
}
async function removeReverse(port) {
  assert.equal(ownedRoutes.get(port), true, "Only an owned reverse route may be removed");
  const actual = await reverseList();
  assert.ok(actual.some((line) => line.split(/\s+/).slice(-2).join(" ") === `tcp:${port} tcp:${port}`), "Owned reverse route changed; refusing removal");
  await adbRun(["reverse", "--remove", `tcp:${port}`]);ownedRoutes.set(port, false);
}
async function runCase(name, method, extra = []) {
  console.log(`Running actual Android instrumentation: ${name}`);
  const started = Date.now();
  const text = (await adbRun(["shell", "am", "instrument", "-w", "-r", "-e", "class", method,
    "-e", "transferFixtureID", id, ...extra, `${SAMPLE_PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner`], { log: name + ".txt", timeout: 180000 })).toString("utf8");
  assert.match(text, /OK \(1 test\)/, `${name} did not report a passing test`);
  assert.doesNotMatch(text, /FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/);
  cases.push({ name, method, passed: true, elapsed_ms: Date.now() - started });
}
async function exportCapture(name, path) {
  const bytes = await adbRun(["exec-out", "run-as", SAMPLE_PACKAGE, "cat", `${fixtureBase}/${path}`]);
  const validation = validateCapture(bytes.toString("utf8"));
  assert.equal(validation.valid, true, `${name}: ${validation.errors.join("; ")}`);
  const file = resolve(evidenceDirectory, name + ".ndjson");await writeFile(file, bytes, { mode: 0o600 });
  exports.push({ name, path: file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), summary: validation.summary });
  return bytes;
}
try {
  beforeReverse = await reverseList();
  const installed = (await adbRun(["shell", "pm", "path", SAMPLE_PACKAGE])).toString("utf8").trim();
  beforeHistory = installed ? await snapshot() : [];
  await writeFile(resolve(evidenceDirectory, "history-before.json"), JSON.stringify(beforeHistory, null, 2) + "\n", { mode: 0o600 });
  console.log(`Building current Android app and instrumentation APKs for ${device.serial}`);
  await run(resolve(root, "android/gradlew"), ["-p", resolve(root, "android"), ":app:assembleDebug", ":app:assembleDebugAndroidTest", "--console=plain"], { log: "build.log", timeout: 300000 });
  await adbRun(["install", "-r", resolve(root, "android/app/build/outputs/apk/debug/app-debug.apk")], { log: "install-app.log" });
  await adbRun(["install", "-r", resolve(root, "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk")], { log: "install-tests.log" });
  await inApp(`test ! -e ${quote(fixtureBase)} && mkdir -p ${quote(fixtureBase)} && chmod 700 ${quote(fixtureBase)}`);
  fixture = fixtureBase;
  const collectorDirectory = resolve(evidenceDirectory, "collector"), key = resolve(collectorDirectory, "key.pem"), cert = resolve(collectorDirectory, "cert.pem");
  await mkdir(collectorDirectory, { mode: 0o700 });
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "2", "-keyout", key, "-out", cert,
    "-subj", "/CN=Android isolated instrumentation collector", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:FALSE",
    "-addext", "extendedKeyUsage=serverAuth", "-addext", "keyUsage=critical,digitalSignature,keyEncipherment"]);
  await chmod(key, 0o600);await chmod(cert, 0o600);
  collector = await startCollector({ directory: collectorDirectory, port: 0, tls: { key, cert, host: "127.0.0.1", bind: "127.0.0.1", port: 0 } });
  const source = await collector.enroll({ version: 2, registration_id: randomUUID(), platform: "android", environment_id: `instrumentation:${device.serial}`,
    app_id: SAMPLE_PACKAGE, installation_id: id, journal_id: id }, `instrumentation:${id}`);
  const httpPort = Number(new URL(collector.origin).port), tlsConnection = collector.connections[1], tlsPort = Number(new URL(tlsConnection.endpoint).port);
  const httpPairing = JSON.stringify(source), tlsPairing = JSON.stringify({ ...source, endpoint: tlsConnection.endpoint, certificate_sha256: tlsConnection.certificate_sha256 });
  await inApp(`cat > ${quote(fixtureBase + "/pairing.json")} && chmod 600 ${quote(fixtureBase + "/pairing.json")}`, { input: httpPairing });
  await inApp(`cat > ${quote(fixtureBase + "/connection-tls.json")} && chmod 600 ${quote(fixtureBase + "/connection-tls.json")}`, { input: tlsPairing });
  await reverse(httpPort);await reverse(tlsPort);
  await runCase("live-business-flow", "dev.networklog.app.LiveFlowTest#successfulAndRecoverySessionsProduceRealLogs");
  await runCase("production-debug-factory", "dev.networklog.app.TransferFlowTest#factoryDoesNotReadPairingInNonDebuggableApplication");
  await runCase("paired-http-transfer", "dev.networklog.app.TransferFlowTest#pairedCollectorReceivesCaptureAndRetainsLocalExport", ["-e", "transferLiveFlow", "true"]);
  await removeReverse(httpPort);
  await runCase("offline-write", "dev.networklog.app.TransferFlowTest#offlineSpoolSurvivesCloseAndResumesWithoutNewIds", ["-e", "transferOfflinePhase", "write"]);
  const offline = await exportCapture("offline-before-resume", "offline/capture.ndjson");
  await reverse(httpPort);
  await runCase("offline-resume", "dev.networklog.app.TransferFlowTest#offlineSpoolSurvivesCloseAndResumesWithoutNewIds", ["-e", "transferOfflinePhase", "resume"]);
  assert.deepEqual(await exportCapture("offline-after-resume", "offline/capture.ndjson"), offline);
  await runCase("paired-tls-wrong-pin", "dev.networklog.app.TransferFlowTest#pinnedTlsAcceptsPairedLeafAndRejectsDifferentPin");
  for (const [name, path] of [["live", "live/capture.ndjson"], ["paired", "paired/capture.ndjson"], ["tls", "tls/capture.ndjson"], ["wrong-pin-retained", "rejected-pin/capture.ndjson"]]) await exportCapture(name, path);
  const received = [];
  for (let after = 0;;) {
    const page = await collector.store.page({ after, source_id: source.source_id });received.push(...page.lines);after = page.next_after;
    if (!page.has_more) break;
  }
  const ids = new Set(received.map((line) => JSON.parse(line).event_id));
  const readFixture = (path) => adbRun(["exec-out", "run-as", SAMPLE_PACKAGE, "cat", `${fixtureBase}/${path}`]);
  for (const path of ["paired/capture.ndjson", "offline/capture.ndjson", "tls/capture.ndjson"]) {
    const lines = (await readFixture(path)).toString("utf8").trim().split("\n");
    assert.ok(lines.every((line) => ids.has(JSON.parse(line).event_id)), `${path} lacks collector ACK evidence`);
  }
  const rejected = (await readFixture("rejected-pin/capture.ndjson")).toString("utf8").trim().split("\n");
  assert.ok(rejected.every((line) => !ids.has(JSON.parse(line).event_id)), "Wrong-pin events reached collector");
  const afterHistory = await snapshot();assert.deepEqual(afterHistory, beforeHistory);preservedHistory = true;
  await writeFile(resolve(evidenceDirectory, "history-after.json"), JSON.stringify(afterHistory, null, 2) + "\n", { mode: 0o600 });
  for (const [port, active] of ownedRoutes) if (active) await removeReverse(port);
  assert.deepEqual(await reverseList(), beforeReverse);preservedRoutes = true;
  const certificateText = (await run("openssl", ["x509", "-in", cert, "-noout", "-text"])).toString("utf8");
  assert.match(certificateText, /TLS Web Server Authentication/);assert.match(certificateText, /Digital Signature, Key Encipherment/);assert.match(certificateText, /IP Address:127\.0\.0\.1/);
  await writeFile(resolve(evidenceDirectory, "certificate.txt"), certificateText, { mode: 0o600 });
  const evidence = { date: new Date().toISOString(), device, fixture_id: id, device_fixture: fixture, collector_id: collector.store.config.collector_id,
    source_id: source.source_id, http_port: httpPort, tls_port: tlsPort, cases, exports, received_events: received.length,
    preserved_history: preservedHistory, preserved_reverse_routes: preservedRoutes, existing_hashed_files: beforeHistory.length,
    scope: "Actual AndroidJUnitRunner execution of five methods in six invocations, including public demo HTTP business flows, offline write/resume, and positive/negative pinned HTTPS. All new config/captures live in a fresh cache fixture; no_backup canonical history, manual pairing and pre-existing reverse routes are preserved. Device fixture and private collector evidence are retained for inspection." };
  await writeFile(resolve(evidenceDirectory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(`PASS actual Android instrumentation: ${cases.length} invocations; evidence ${evidenceDirectory}/evidence.json`);
} catch (error) {
  primaryError = error;
}
await finishOwnedCleanup([
  ...[...ownedRoutes].filter(([, active]) => active).map(([port]) => () => removeReverse(port)),
  () => collector?.close(),
  async () => { if (beforeHistory && !preservedHistory) assert.deepEqual(await snapshot(), beforeHistory, "Canonical history/pairing changed during failed instrumentation"); },
  async () => { if (beforeReverse && !preservedRoutes) assert.deepEqual(await reverseList(), beforeReverse, "Existing reverse routes were not preserved"); },
], primaryError);
