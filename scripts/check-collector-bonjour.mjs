// Actual macOS DNS-SD check; unique owned service/collector, no device pairing.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startCollector } from "../collector/server.mjs";
import { localCertificate } from "../collector/tls.mjs";
import { advertiseCollector } from "../collector/bonjour.mjs";
import { launchContext } from "./lib/launch-context.mjs";

assert.equal(process.platform, "darwin", "Actual DNS-SD check requires macOS");
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(resolve(root, "artifacts"), { recursive: true, mode: 0o700 });
const directory = await mkdtemp(resolve(root, "artifacts/bonjour-"));
const launch = launchContext();
const sourceHashes = {};
for (const path of ["scripts/check-collector-bonjour.mjs", "scripts/lib/launch-context.mjs",
  "collector/server.mjs", "collector/store.mjs", "collector/store-worker.mjs", "collector/tls.mjs", "collector/bonjour.mjs"]) {
  const bytes = await readFile(resolve(root, path));
  sourceHashes[path] = createHash("sha256").update(bytes).digest("hex");
  if (path === "scripts/check-collector-bonjour.mjs")
    await writeFile(resolve(directory, "executed-harness.mjs"), bytes, { mode: 0o600 });
}
const name = "NetworkLog acceptance " + randomUUID();
const hostname = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], {
  encoding: "utf8", timeout: 5000,
}).trim().toLowerCase() + ".local";
const processes = [];
function command(args) {
  const child = spawn("/usr/bin/dns-sd", args, { stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, args, output: "", closed: false, error: null };
  const append = (data) => {
    state.output += data.toString("utf8");
    if (Buffer.byteLength(state.output) > 65536) {
      state.error = new Error("DNS-SD output exceeded check limit");
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", append); child.stderr.on("data", append);
  child.on("error", (e) => { state.error = e; });
  child.on("close", () => { state.closed = true; });
  processes.push(state);
  return state;
}
async function until(state, predicate, label, milliseconds = 10000) {
  const deadline = performance.now() + milliseconds;
  while (!predicate(state.output)) {
    if (state.error) throw state.error;
    assert(!state.closed && performance.now() < deadline, label);
    await new Promise((ok) => setTimeout(ok, 25));
  }
  return performance.now();
}
async function stop(state) {
  if (state.closed) return;
  state.child.kill("SIGTERM");
  const deadline = performance.now() + 1000;
  while (!state.closed && performance.now() < deadline)
    await new Promise((ok) => setTimeout(ok, 25));
  if (!state.closed) {
    state.child.kill("SIGKILL");
    const killed = performance.now() + 1000;
    while (!state.closed && performance.now() < killed)
      await new Promise((ok) => setTimeout(ok, 25));
    assert(state.closed, "Owned DNS-SD child did not close after kill");
  }
}
let collector, advertisement;
const result = { success: false, service: name, hostname, activation: false,
  launch_context: launch, source_hashes: sourceHashes };
try {
  collector = await startCollector({ directory, port: 0,
    tls: { ...localCertificate(directory, hostname), port: 0 } });
  const browse = command(["-B", "_nlog._tcp", "local."]);
  // dns-sd flushes piped browse output when a result arrives; its initial
  // banner alone may remain buffered when no matching services exist.
  const began = performance.now();
  advertisement = advertiseCollector(collector, { enabled: true, name });
  const added = await until(browse, output => output.split("\n").some(line => line.includes(name) && /\bAdd\b/.test(line)), "Owned service was not discovered");
  const resolver = command(["-L", name, "_nlog._tcp", "local."]);
  const id = collector.store.config.collector_id;
  const tls = collector.connections.find(c => c.endpoint.startsWith("https:"));
  const port = Number(new URL(tls.endpoint).port);
  await until(resolver, output => output.includes("collector_id=" + id) && output.includes("version=2") && output.includes("hostname=" + hostname) && output.includes(":" + port), "Owned service TXT/port did not resolve");
  assert.doesNotMatch(resolver.output, /source_token|enrollment_token|read_token|Authorization|Bearer/);
  const closed = performance.now();
  await advertisement.close(); advertisement = null;
  const removed = await until(browse, output => output.split("\n").some(line => line.includes(name) && /\bRmv\b/.test(line)), "Owned service was not withdrawn");
  Object.assign(result, { success: true, advertised_port: port, discovery_ms: added - began,
    withdrawal_ms: removed - closed, txt: { version: 2, collector_id: id, hostname },
    scoped_browse_lines: browse.output.split("\n").filter(line => line.includes(name)),
    scope: "Actual macOS dns-sd advertisement, browse, resolve and withdrawal. " +
      (launch.apple_terminal_ancestor ? "Apple Terminal process ancestry observed. " : "No Apple Terminal process ancestry established. ") +
      "See launch_context for bounded provenance; no physical client permissions, multicast-blocked behavior, address changes or TLS remote-peer delivery claim." });
} catch (e) {
  result.error = e.message;
  result.owned_resolver_output = processes.filter(p => p.args[0] === "-L").map(p => p.output);
  throw e;
} finally {
  const errors = [];
  await advertisement?.close().catch(e => errors.push(e.message));
  const stopped = await Promise.allSettled(processes.map(stop));
  for (const entry of stopped)
    if (entry.status === "rejected") errors.push(entry.reason.message);
  try { await collector?.close(); result.collector_closed = true; }
  catch (e) { result.collector_closed = false; errors.push(e.message); }
  result.owned_dns_sd_children_closed = processes.every(p => p.closed);
  if (errors.length) { result.success = false; result.cleanup_errors = errors; }
  await writeFile(resolve(directory, "evidence.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(`Bonjour ${result.success ? "PASS" : "FAIL"}: ${resolve(directory, "evidence.json")}`);
  if (errors.length) throw new Error("Bonjour check cleanup failed: " + errors.join("; "));
}
