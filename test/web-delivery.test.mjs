import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { MemoryJournal, IndexedDBJournal } from "../web-sdk/src/storage.mjs";
import { uploadJournal } from "../web-sdk/src/transfer.mjs";
import { createNetworkLogRelay } from "../web-sdk/dev-relay.mjs";
import { startCollector } from "../collector/server.mjs";

const line = (id, extra = {}) => JSON.stringify({ event_id: id, ...extra }) + "\n";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const config = { version: 1, collector_id: "collector-one" };
const acknowledgment = (body) => ({ ...config, acknowledged_event_ids: body.trim().split("\n").map((value) => JSON.parse(value).event_id) });
function temp(t) {
  const path = mkdtempSync(join(tmpdir(), "web-delivery-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("memory journal bounds UTF-8 bytes and events, retaining canonical lines", async () => {
  const value = line("a", { content: "漢字" }), bytes = Buffer.byteLength(value);
  const journal = new MemoryJournal({ maxBytes: bytes, maxEvents: 2 });
  assert.equal(journal.append(value), true);
  assert.equal(journal.append(line("b")), false);
  await journal.flush();
  assert.equal(journal.exportNDJSON(), value);
  assert.deepEqual(journal.stats, { bytes, events: 1, dropped: 1, error: null });
  assert.throws(() => journal.append("{}\n{}\n"), /one complete/);
  assert.throws(() => journal.append("[]\n"), /event object/);
  const one = new MemoryJournal({ maxEvents: 1 });
  assert.equal(one.append(line("first")), true);
  assert.equal(one.append(line("second")), false);
  assert.throws(() => new MemoryJournal({ maxBytes: Infinity }), /positive/);
});

test("IndexedDB flush commits, reload preserves IDs/order, and limits protect reopening", async () => {
  const indexedDB = new IDBFactory(), options = { indexedDB, journalId: "session-group" };
  const journal = await IndexedDBJournal.open(options);
  for (const id of ["a", "b", "c"]) assert.equal(journal.append(line(id)), true);
  assert.equal(journal.stats.pending, 3);
  await journal.flush();
  assert.equal(journal.stats.pending, 0);
  assert.equal(journal.stats.persistedEvents, 3);
  await journal.close();
  assert.equal(journal.append(line("closed")), false);
  const restored = await IndexedDBJournal.open(options);
  assert.equal(restored.exportNDJSON(), journal.exportNDJSON());
  await restored.close();
  await assert.rejects(IndexedDBJournal.open({ ...options, maxEvents: 2 }), /exceeds configured limits/);
  await assert.rejects(IndexedDBJournal.open({ indexedDB }), /journalId/);
});

test("concurrent IndexedDB writers never overwrite the committed journal", async () => {
  const indexedDB = new IDBFactory(), options = { indexedDB, journalId: "same-journal" };
  const first = await IndexedDBJournal.open(options), second = await IndexedDBJournal.open(options);
  first.append(line("first"));
  await first.flush();
  second.append(line("second"));
  await assert.rejects(second.flush(), /Another writer/);
  assert.equal(second.exportNDJSON(), line("second"));
  assert.match(second.stats.error, /Another writer/);
  await first.close();
  await assert.rejects(second.close(), /Another writer/);
  const restored = await IndexedDBJournal.open(options);
  assert.equal(restored.exportNDJSON(), line("first"));
  await restored.close();
});

test("an aborted persistence transaction retains memory and reports failure", async () => {
  const journal = await IndexedDBJournal.open({ indexedDB: new IDBFactory(), journalId: "abort" });
  const transaction = journal._db.transaction.bind(journal._db);
  journal._db.transaction = (...args) => {
    const tx = transaction(...args);
    queueMicrotask(() => tx.abort());
    return tx;
  };
  journal.append(line("retained"));
  await assert.rejects(journal.flush(), /write failed/);
  assert.equal(journal.exportNDJSON(), line("retained"));
  assert.equal(journal.stats.persistedEvents, 0);
  await assert.rejects(journal.close(), /write failed/);
});

test("IndexedDB opening fails promptly when blocked or timed out and closes late success", async () => {
  let request, closed = false;
  const blocked = IndexedDBJournal.open({ journalId: "blocked", indexedDB: { open() { request = {}; return request; } } });
  request.onblocked();
  await assert.rejects(blocked, /blocked/);
  request.result = { close() { closed = true; } };
  request.onsuccess();
  assert.equal(closed, true);
  await assert.rejects(IndexedDBJournal.open({ journalId: "timeout", openTimeoutMs: 10, indexedDB: { open() { return {}; } } }), /timed out/);
});

test("uploader splits at 500 events, preserves content and replays all records", async () => {
  const journal = new MemoryJournal();
  for (let i = 0; i < 501; i++) journal.append(line(`id-${i}`, { content: "é" }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.mode, "same-origin");
    if (url.endsWith("/config")) return json(config);
    calls.push(options.body);
    return json(acknowledgment(options.body));
  };
  assert.deepEqual(await uploadJournal(journal, { origin: "http://127.0.0.1:4000", fetchImpl }), { events: 501, batches: 2, collectorId: config.collector_id });
  await uploadJournal(journal, { origin: "http://127.0.0.1:4000", fetchImpl });
  assert.equal(calls[0], calls[2]);
  assert.equal(calls[1], calls[3]);
  assert.equal(calls[0] + calls[1], journal.exportNDJSON());
});

test("retry after a later batch failure replays the acknowledged prefix with unchanged IDs", async () => {
  const journal = new MemoryJournal();
  for (let i = 0; i < 501; i++) journal.append(line(`stable-${i}`));
  let fail = true, count = 0;
  const delivered = new Set(), batches = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/config")) return json(config);
    batches.push(options.body);
    if (++count === 2 && fail) return json({}, 503);
    const ack = acknowledgment(options.body);
    for (const id of ack.acknowledged_event_ids) delivered.add(id);
    return json(ack);
  };
  const options = { origin: "https://app.test", fetchImpl };
  await assert.rejects(uploadJournal(journal, options), /HTTP 503/);
  assert.equal(delivered.size, 500);
  fail = false;
  await uploadJournal(journal, options);
  assert.equal(delivered.size, 501);
  assert.equal(batches[0], batches[2]);
  assert.equal(batches[1], batches[3]);
  assert.equal(journal.stats.events, 501);
});

test("uploader honors exact UTF-8 byte boundary and rejects oversized events before networking", async () => {
  const limit = 1024 * 1024, journal = new MemoryJournal();
  const fixed = line("a", { text: "" });
  journal.append(line("a", { text: "x".repeat(limit - Buffer.byteLength(fixed)) }));
  journal.append(line("b", { text: "漢" }));
  const sizes = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/config")) return json(config);
    sizes.push(Buffer.byteLength(options.body));
    return json(acknowledgment(options.body));
  };
  await uploadJournal(journal, { origin: "https://app.test", fetchImpl });
  assert.equal(sizes[0], limit);
  assert.equal(sizes.length, 2);
  const oversized = new MemoryJournal();
  oversized.append(line("big", { text: "x".repeat(limit) }));
  await assert.rejects(uploadJournal(oversized, { origin: "https://app.test", fetchImpl: () => { throw new Error("must not fetch"); } }), /1 MiB/);
});

test("uploader rejects partial, foreign, malformed and oversized ACKs without deletion", async () => {
  const journal = new MemoryJournal(); journal.append(line("retained"));
  const bad = [
    () => json({ ...config, acknowledged_event_ids: [] }),
    () => json({ ...config, collector_id: "other", acknowledged_event_ids: ["retained"] }),
    () => new Response("not json"),
    () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    () => json({}, 507),
    () => json(null),
  ];
  for (const response of bad) {
    await assert.rejects(uploadJournal(journal, { origin: "https://app.test", fetchImpl: async (url) => url.endsWith("/config") ? json(config) : response() }));
    assert.equal(journal.exportNDJSON(), line("retained"));
  }
  await assert.rejects(uploadJournal(journal, { origin: "https://app.test", basePath: "https://evil.test", fetchImpl: async () => json(config) }), /same-origin/);
  await assert.rejects(uploadJournal(journal, { origin: "https://user:password@app.test", fetchImpl: async () => json(config) }), /origin/);
});

test("uploader times out a stalled fetch and propagates persistence failure without networking", async () => {
  const journal = new MemoryJournal(); journal.append(line("retained"));
  await assert.rejects(uploadJournal(journal, { origin: "https://app.test", timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }), /timed out/);
  await assert.rejects(uploadJournal({ flush() { throw new Error("disk full"); } }, { origin: "https://app.test", fetchImpl: () => { throw new Error("must not fetch"); } }), /disk full/);
});

async function relayServer(t, options = {}) {
  const directory = temp(t), collector = await startCollector({ directory: join(directory, "collector"), port: 0 });
  t.after(() => collector.close());
  const connectionFile = join(directory, "connection.json");
  writeFileSync(connectionFile, JSON.stringify(collector.connections[0]));
  let relay;
  const server = http.createServer((req, res) => relay(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  relay = createNetworkLogRelay({ connectionFile, origin, ...options });
  return { origin, collector, connectionFile, fetchImpl: (url, request = {}) => fetch(url, {
    ...request, headers: { ...request.headers, ...(request.method === "POST" ? { Origin: origin } : {}) },
  }) };
}

test("real relay and collector retain capture, replay without duplicates, and expose no pairing token", async (t) => {
  const { origin, collector, fetchImpl } = await relayServer(t);
  const journal = new MemoryJournal();
  const fixture = readFileSync(new URL("../examples/success.ndjson", import.meta.url), "utf8");
  for (const value of fixture.trim().split("\n")) journal.append(value + "\n");
  const result = await uploadJournal(journal, { origin, fetchImpl });
  assert.equal(collector.store.cursor, result.events);
  await uploadJournal(journal, { origin, fetchImpl });
  assert.equal(collector.store.cursor, result.events);
  assert.equal(journal.exportNDJSON(), fixture);
  const response = await fetch(origin + "/__network_log/config");
  assert.deepEqual(await response.json(), { version: 1, collector_id: collector.connections[0].collector_id });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("relay checks Host, Origin, route, type, size, event count and does not grant CORS", async (t) => {
  const { origin } = await relayServer(t);
  const path = origin + "/__network_log/events", body = line("a");
  for (const [options, status] of [
    [{ method: "POST", headers: { Origin: "http://evil.test", "Content-Type": "application/x-ndjson" }, body }, 403],
    [{ method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body }, 403],
    [{ method: "OPTIONS", headers: { Origin: "http://evil.test" } }, 403],
    [{ method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body }, 415],
    [{ method: "POST", headers: { Origin: origin, "Content-Type": "application/x-ndjson", "Content-Encoding": "gzip" }, body }, 415],
    [{ method: "POST", headers: { Origin: origin, "Content-Type": "application/x-ndjson" }, body: body.repeat(501) }, 413],
    [{ method: "POST", headers: { Origin: origin, "Content-Type": "application/x-ndjson" }, body: "x".repeat(1024 * 1024 + 1) }, 413],
  ]) {
    const response = await fetch(path, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    await response.arrayBuffer();
  }
  assert.equal((await fetch(path + "?alternate=1")).status, 404);
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.request(origin + "/__network_log/config", { headers: { Host: "evil.test" } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.once("error", reject); request.end();
  });
  assert.equal(foreignHost, 403);
});

test("relay forwards only paired headers, refuses redirects and hides upstream errors", async (t) => {
  let mode = "redirect", forwarded;
  const { origin } = await relayServer(t, { fetchImpl: async (url, options) => {
    forwarded = { url, options };
    return mode === "redirect" ? new Response(null, { status: 302, headers: { Location: "http://evil.test" } }) : json({ error: "private-token-reflection" }, 500);
  } });
  const request = { method: "POST", headers: { Origin: origin, Cookie: "private-app-cookie", Authorization: "Bearer wrong-browser-token", "Content-Type": "application/x-ndjson" }, body: line("a") };
  assert.equal((await fetch(origin + "/__network_log/events", request)).status, 502);
  assert.equal(forwarded.options.redirect, "manual");
  assert.deepEqual(Object.keys(forwarded.options.headers).sort(), ["Authorization", "Content-Type"]);
  assert.notEqual(forwarded.options.headers.Authorization, request.headers.Authorization);
  mode = "error";
  const response = await fetch(origin + "/__network_log/events", request);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-token-reflection/);
});

test("relay enforces ACK bound and timeout", async (t) => {
  let mode = "large";
  const { origin } = await relayServer(t, { timeoutMs: 20, fetchImpl: async (_url, options) => {
    if (mode === "large") return new Response("x".repeat(2 * 1024 * 1024 + 1));
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("secret error details")), { once: true }));
  } });
  const request = { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-ndjson" }, body: line("a") };
  const large = await fetch(origin + "/__network_log/events", request);
  assert.equal(large.status, 502);
  assert.match(await large.text(), /2 MiB/);
  mode = "slow";
  const slow = await fetch(origin + "/__network_log/events", request);
  assert.equal(slow.status, 502);
  assert.doesNotMatch(await slow.text(), /secret error details/);
});

test("relay permits only two simultaneous upstream uploads", async (t) => {
  const pending = [];
  const { origin, collector } = await relayServer(t, { fetchImpl: () => new Promise((resolve) => pending.push(resolve)) });
  const request = { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-ndjson" }, body: line("a") };
  const first = fetch(origin + "/__network_log/events", request), second = fetch(origin + "/__network_log/events", request);
  for (let i = 0; pending.length < 2 && i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  assert.equal((await fetch(origin + "/__network_log/events", request)).status, 429);
  for (const resolve of pending) resolve(json({ version: 1, collector_id: collector.connections[0].collector_id, acknowledged_event_ids: ["a"] }));
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test("relay pairing rejects non-loopback and credential-bearing endpoints", (t) => {
  const connectionFile = join(temp(t), "connection.json");
  for (const endpoint of ["http://localhost:4319", "https://127.0.0.1:4319", "http://127.0.0.1.evil.test", "http://user:pass@127.0.0.1", "http://127.0.0.1/?token=secret"]) {
    writeFileSync(connectionFile, JSON.stringify({ version: 1, endpoint, token: "device-token", collector_id: "collector" }));
    assert.throws(() => createNetworkLogRelay({ connectionFile, origin: "http://127.0.0.1:4000" }), /loopback/);
  }
});
