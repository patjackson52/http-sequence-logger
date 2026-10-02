import { readFile, writeFile, mkdir, appendFile, realpath, rename, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const tool = basename(process.argv[1]);
if (["adb", "xcrun", "plutil"].includes(tool)) {
  const c = JSON.parse(await readFile(process.env.ADAPTER_FIXTURE, "utf8"));
  const args = process.argv.slice(2);
  if (tool === "plutil") { for await (const bytes of process.stdin) process.stdout.write(bytes); }
  else if (tool === "xcrun") {
    if (args.includes("devices")) console.log(JSON.stringify({ devices: { Runtime: [{ udid: "fixture", name: "Fixture", state: "Booted" }] } }));
    else if (args.includes("listapps")) console.log(JSON.stringify({ "fixture.app": {} }));
    else console.log(c.container);
  } else {
    const a = args[0] === "-s" ? args.slice(2) : args;
    if (a[0] === "devices") console.log("fixture device model:Fixture");
    else if (a.includes("list")) console.log("package:fixture.app");
    else if (a[0] === "reverse") {
      await appendFile(c.trace, JSON.stringify(a) + "\n");
      if (a[1] === "--list" && c.conflict) console.log(`fixture tcp:${c.port} tcp:4321`);
      else if (a[1] !== "--list" && c.conflict) { console.error("cannot rebind existing socket"); process.exitCode = 1; }
    } else if (a[0] === "shell") { for await (const _ of process.stdin) {} }
    else if (a[1] === "sh") process.stdout.write("Dfixture.app\n");
    else {
      const command = a.at(-1);
      if (command.includes("ls -1")) process.stdout.write("D" + (await readdir(resolve(c.base, "journals"))).map(name => name + "\n").join(""));
      else if (command.includes("stat -c")) process.stdout.write(`1:2:${c.bytes}`);
      else if (command.includes("tail -c")) {
        const offset = Number(command.match(/tail -c \+(\d+)/)[1]) - 1;
        const count = Number(command.match(/head -c (\d+)/)[1]);
        process.stdout.write((await readFile(resolve(c.base, "journals/journal-one/capture.ndjson"))).subarray(offset, offset + count));
      } else {
        const path = command.match(/head -c 16385 ([^ ;]+)/)[1].replace("no_backup/HTTPSequenceLogger/", "");
        try { process.stdout.write(Buffer.concat([Buffer.from("F"), await readFile(resolve(c.base, path))])); }
        catch (e) { if (e.code !== "ENOENT") throw e; process.stdout.write("N"); }
      }
    }
  }
} else {
  const [inputDirectory, platform, kind] = process.argv.slice(2);
  const dir = await realpath(inputDirectory);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const { startCollector } = await import("../../collector/server.mjs");
  const { watchAndroid } = await import("../../collector/android-live.mjs");
  const { watchSimulators } = await import("../../collector/ios-simulator.mjs");
  const container = resolve(dir, "container");
  const base = platform === "ios" ? resolve(container, "Library/Application Support/HTTPSequenceLogger") : resolve(container, "no_backup/HTTPSequenceLogger");
  const journal = resolve(base, "journals/journal-one");
  await mkdir(journal, { recursive: true, mode: 0o700 });
  const text = await readFile(resolve(root, "examples/success.ndjson"), "utf8");
  const publication = { version: 2, journal_id: "journal-one", generation: kind === "missing" ? undefined : "arbitrary", capture: "capture.ndjson", durable_bytes: Buffer.byteLength(text) };
  const save = (file, value) => writeFile(resolve(base, file), JSON.stringify(value), { mode: 0o600 });
  await save("source.json", { version: 2, platform, app_id: "fixture.app", installation_id: "fixture-installation", journal_directory: "journals" });
  await save("journal-budget.json", { version: 2, reservations: { "journal-one": Buffer.byteLength(text) } });
  await save("journals/journal-one/journal.json", publication);
  await writeFile(resolve(journal, "capture.ndjson"), text, { mode: 0o600 });
  const holding = resolve(base, "fixture-held-journal");
  if (kind === "inventory") await rename(journal, holding);
  const config = resolve(dir, "fixture.json"), trace = resolve(dir, "trace.ndjson");
  await mkdir(resolve(dir, "bin"), { mode: 0o700 });
  for (const name of ["adb", "xcrun", "plutil"])
    await writeFile(resolve(dir, "bin", name), `#!${process.execPath}\nimport ${JSON.stringify(import.meta.url)};\n`, { mode: 0o700 });
  process.env.PATH = resolve(dir, "bin") + ":" + process.env.PATH;
  process.env.ADAPTER_FIXTURE = config;
  const collector = await startCollector({ directory: resolve(dir, "collector"), port: 0 });
  const main = platform === "ios" ? "ios-simulator" : "android";
  const reason = kind === "route" ? "cannot rebind" : kind === "inventory" ? "Retained journal generation missing" : "Invalid journal publication";
  let gapSeen = false, repairStarted = false, transientClear = false;
  const status = new Map(), originalStatus = collector.setAdapterStatus;
  collector.setAdapterStatus = (name, value) => {
    if (name === main) {
      if (value.reason?.includes(reason)) gapSeen = true;
      if (gapSeen && !repairStarted && value.state === "ready") transientClear = true;
    }
    status.set(name, value); originalStatus(name, value);
  };
  const enrollment = collector.enroll.bind(collector);
  let connection, watcher;
  collector.enroll = async (...args) => { connection = await enrollment(...args); await collector.ingest(connection.source_token, text); return connection; };
  const c = { container, base, bytes: Buffer.byteLength(text), trace, conflict: kind === "route", port: Number(new URL(collector.origin).port) };
  await writeFile(config, JSON.stringify(c), { mode: 0o600 });
  const wait = async (predicate) => { const deadline = Date.now() + 15000; while (!await predicate()) { assert(Date.now() < deadline, "Fixture reconciliation timed out: " + JSON.stringify([...status])); await new Promise(ok => setTimeout(ok, 25)); } };
  try {
    watcher = platform === "ios" ? await watchSimulators({ collector, interval: 25 }) : await watchAndroid({ collector, adb: resolve(dir, "bin/adb"), interval: 25 });
    await wait(() => status.get(main)?.reason?.includes(reason));
    const expectedEnvironment = platform === "ios" ? "simulator:fixture" : "adb:fixture:user:0";
    const bound = (await collector.store.sources()).sources.find(source => source.source_id === connection.source_id);
    assert.equal(bound.local_binding, expectedEnvironment, "First discovery must bind before publishing a local proposal");
    await assert.rejects(collector.store.bindLocal(connection.source_token, {
      platform, app_id: "fixture.app", installation_id: "fixture-installation",
      environment_id: expectedEnvironment + ":clone", environment_name: "Owned clone fixture",
    }), error => error.status === 409 && /already bound/.test(error.message));
    assert.equal((await collector.store.sources()).sources.find(source => source.source_id === connection.source_id).environment_id, expectedEnvironment);
    const before = collector.store.cursor;
    assert.equal(await collector.store.checkpoint(connection.source_id, "journal-one"), null);
    assert.equal(before, text.trim().split("\n").length);
    await collector.store.presence(connection.source_token, { instance_id: "concurrent-push" });
    await collector.ingest(connection.source_token, text);
    await new Promise(ok => setTimeout(ok, 150));
    assert.equal(status.get(main).state, "waiting");
    assert(status.get(main).reason.includes(reason));
    assert.equal(transientClear, false, "Scan-start status hid the unresolved local gap");
    assert.equal(collector.store.cursor, before);
    if (kind === "route") {
      const commands = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
      assert(commands.some(a => a[1] === "--no-rebind"));
      assert(!commands.some(a => a[1] === `tcp:${c.port}`));
      c.conflict = false; await writeFile(config, JSON.stringify(c), { mode: 0o600 });
    }
    repairStarted = true;
    if (kind === "inventory") await rename(holding, journal);
    publication.generation = "journal-one";
    await save("journals/journal-one/journal.json", publication);
    await wait(async () => (await collector.store.checkpoint(connection.source_id, "journal-one"))?.offset === Buffer.byteLength(text));
    await wait(() => status.get(main)?.state === "ready");
    assert.equal(collector.store.cursor, before);
    assert.equal(await readFile(resolve(journal, "capture.ndjson"), "utf8"), text);
    console.log(JSON.stringify({ platform, kind, preserved: true, checkpoint_recovered: true, diagnostic_survived_push: true, first_reconciliation_bound: true, clone_rejected_before_restart: true }));
  } finally { await watcher?.close(); await collector.close(); }
}
