import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  appendFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../collector/store.mjs";
import { startCollector } from "../collector/server.mjs";
import { LineFollower, androidBridge } from "../collector/adb.mjs";
import { CollectorClient } from "../viewer/src/collector-client.mjs";
const fixture = readFileSync(
  new URL("../examples/success.ndjson", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n");
const event = JSON.parse(fixture[0]);
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "capture-transfer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function store(t, limits) {
  const s = new CaptureStore(temp(t), limits);
  t.after(() => s.close());
  return s;
}
const line = (e) => JSON.stringify(e) + "\n";
test("durable ACK, replay deduplication and identity survive restart", (t) => {
  const s = store(t);
  const ack = s.ingest(fixture.slice(0, 3).join("\n") + "\n");
  assert.equal(ack.accepted, 3);
  assert.equal(ack.recordings[0].highest_contiguous_sequence, 3);
  const id = s.config.collector_id;
  s.close();
  const restored = new CaptureStore(s.directory);
  t.after(() => restored.close());
  assert.equal(restored.config.collector_id, id);
  assert.equal(restored.cursor, 3);
  assert.equal(
    restored.ingest(fixture.slice(0, 3).join("\n") + "\n").duplicates,
    3,
  );
  assert.equal(restored.cursor, 3);
});
test("conflicting IDs, sequences and recording identity reject a whole batch", (t) => {
  const s = store(t);
  s.ingest(fixture[0] + "\n");
  const mutated = { ...event, timestamp: "2026-01-01T00:00:00.000Z" };
  for (const bad of [
    mutated,
    { ...event, event_id: "11111111-1111-4111-8111-111111111111" },
    { ...JSON.parse(fixture[2]), session_id: "different-session" },
  ]) {
    assert.throws(
      () => s.ingest(fixture[1] + "\n" + line(bad)),
      (e) => e.status === 409,
    );
    assert.equal(s.cursor, 1);
  }
  assert.equal(s.ingest(fixture[1] + "\n").accepted, 1);
});
test("canonical duplicates, out-of-order contiguous sequences and bounded journal", (t) => {
  const s = store(t, { journalEvents: 2 });
  s.ingest(fixture[1] + "\n");
  assert.equal(s.recordings.get(event.recording_id).contiguous, 0);
  const reversed = Object.fromEntries(Object.entries(event).reverse());
  assert.equal(s.ingest(line(reversed) + line(event)).duplicates, 1);
  assert.equal(s.recordings.get(event.recording_id).contiguous, 2);
  assert.throws(
    () => s.ingest(fixture[2] + "\n"),
    (e) => e.status === 507,
  );
  assert.equal(s.cursor, 2);
});
test("partial tail recovery, malformed batches and cursor checks", (t) => {
  const s = store(t);
  s.ingest(fixture[0] + "\n");
  s.close();
  appendFileSync(s.path, '{"partial":');
  const restored = new CaptureStore(s.directory);
  t.after(() => restored.close());
  assert.equal(restored.recoveredPartial, true);
  assert.equal(restored.cursor, 1);
  assert.ok(readFileSync(s.path, "utf8").endsWith("\n"));
  for (const text of ["{}\n", fixture[1], "\n", "oops\n"])
    assert.throws(
      () => restored.ingest(text),
      (e) => e.status === 400,
    );
  assert.throws(
    () => restored.page(99),
    (e) => e.status === 400,
  );
});
test("ADB framing buffers partial UTF-8 and replays replaced or truncated files", () => {
  const f = new LineFollower(),
    buf = Buffer.from("a\n漢字\nb\n");
  assert.equal(f.read(buf.subarray(0, 4)), "a\n");
  assert.equal(f.read(buf.subarray(0, 9)), "漢字\n");
  assert.equal(f.read(buf), "b\n");
  assert.equal(f.read(buf), "");
  assert.equal(f.read(Buffer.from("c\n")), "c\n");
  assert.equal(f.read(Buffer.from("d\n")), "d\n");
  assert.throws(() => androidBridge({ packageName: "bad;cmd", device: "x" }));
  assert.throws(() => androidBridge({ packageName: "dev.sample" }));
});
test("HTTP separates browser/device roles, validates origin, persists and serves SSE replay", async (t) => {
  const c = await startCollector({ directory: temp(t), port: 0 });
  t.after(() => c.close());
  const request = (path, options = {}) => fetch(c.origin + path, options),
    upload = (text, token = c.connections[0].token) =>
      request("/api/v1/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-ndjson",
        },
        body: text,
      });
  assert.equal((await request("/api/v1/events")).status, 401);
  assert.equal(
    (
      await request("/api/v1/events", {
        headers: { Authorization: `Bearer ${c.connections[0].token}` },
      })
    ).status,
    401,
  );
  assert.equal((await upload(fixture[0] + "\n", c.browserToken)).status, 401);
  assert.equal(
    (
      await request("/api/v1/health", {
        headers: { Origin: "https://foreign.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise((ok, fail) => {
      http
        .get(
          c.origin + "/api/v1/health",
          { headers: { Host: "foreign.test" } },
          (res) => {
            res.resume();
            ok(res.statusCode);
          },
        )
        .on("error", fail);
    }),
    403,
  );
  const controller = new AbortController();
  const stream = await request("/api/v1/stream", {
      headers: { Authorization: `Bearer ${c.browserToken}` },
      signal: controller.signal,
    }),
    reader = stream.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /event: ready/,
  );
  assert.equal((await upload(fixture[0] + "\n")).status, 200);
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /event: changed/,
  );
  controller.abort();
  const page = await (
    await request("/api/v1/events?after=0", {
      headers: { Authorization: `Bearer ${c.browserToken}` },
    })
  ).json();
  assert.equal(page.lines.length, 1);
  assert.equal(page.cursor, 1);
  assert.equal((await upload(Buffer.from([255, 10]))).status, 400);
  assert.equal((await upload("x".repeat(1024 * 1024 + 1))).status, 413);
  const download = await request("/api/v1/download", {
    headers: { Authorization: `Bearer ${c.browserToken}` },
  });
  assert.equal(await download.text(), fixture[0] + "\n");
});
test("viewer catches up after connection loss without duplicate capture events", async (t) => {
  const dir = temp(t);
  let c = await startCollector({ directory: dir, port: 0 });
  const port = new URL(c.origin).port,
    origin = c.origin;
  const states = [],
    captures = [];
  const client = new CollectorClient({
    token: c.browserToken,
    fetcher: (path, options) => fetch(origin + path, options),
    retryMs: 20,
    onStatus: (s) => states.push(s.state),
    onCapture: (text, count) => captures.push({ text, count }),
  });
  t.after(async () => {
    client.stop();
    await c.close();
  });
  const run = client.run();
  c.ingest(fixture[0] + "\n");
  await until(() => captures.at(-1)?.count === 1);
  await c.close();
  await until(() => states.includes("reconnecting"));
  c = await startCollector({ directory: dir, port: Number(port) });
  c.ingest(fixture[1] + "\n");
  await until(() => captures.at(-1)?.count === 2);
  assert.equal(captures.at(-1).text, fixture.slice(0, 2).join("\n") + "\n");
  client.stop();
  await run;
});
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((ok) => setTimeout(ok, 20));
  }
}
test("one process owns a journal and a clean close permits reopening", (t) => {
  const s = store(t);
  assert.throws(
    () => new CaptureStore(s.directory),
    /already has a running collector/,
  );
  s.close();
  const reopened = new CaptureStore(s.directory);
  t.after(() => reopened.close());
  assert.equal(reopened.cursor, 0);
});
test("ADB watcher retries rejected batches without advancing its file offset", async (t) => {
  let calls = 0,
    reject = true;
  const text = Buffer.from(fixture[0] + "\n");
  const bridge = androidBridge({
    packageName: "dev.sample",
    device: "device",
    run: async (_cmd, args) => ({
      stdout: args.includes("ls") ? Buffer.from("capture.ndjson\n") : text,
    }),
  });
  const ingest = () => {
    calls++;
    if (reject) throw new Error("storage full");
  };
  await assert.rejects(bridge.poll(ingest), /storage full/);
  reject = false;
  await bridge.poll(ingest);
  await bridge.poll(ingest);
  assert.equal(calls, 2);
});
test("HTTPS listener offers paired ingestion only and refuses browser capture reads", async (t) => {
  const { localCertificate } = await import("../collector/tls.mjs");
  const https = await import("node:https");
  const directory = temp(t),
    tls = {
      ...localCertificate(directory, "127.0.0.1"),
      port: 0,
      bind: "127.0.0.1",
    };
  const c = await startCollector({ directory, port: 0, tls });
  t.after(() => c.close());
  const request = (path, method = "GET", body = "") =>
    new Promise((ok, fail) => {
      const req = https.request(
        c.connections[1].endpoint + path,
        {
          method,
          ca: readFileSync(tls.cert),
          headers: {
            Authorization: `Bearer ${method === "POST" ? c.connections[1].token : c.browserToken}`,
            "Content-Type": "application/x-ndjson",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => ok(res.statusCode));
        },
      );
      req.on("error", fail);
      req.end(body);
    });
  assert.equal(await request("/api/v1/events", "POST", fixture[0] + "\n"), 200);
  assert.equal(await request("/api/v1/events"), 404);
  assert.equal(await request("/api/v1/pairing"), 404);
  assert.equal(await request("/api/v1/viewer-session"), 404);
  assert.equal(await request("/"), 404);
  assert.match(c.connections[1].certificate_sha256, /^[a-f0-9]{64}$/);
});

test("failed download does not terminate the collector", async (t) => {
  const c = await startCollector({ directory: temp(t), port: 0 });
  t.after(() => c.close());
  c.ingest(fixture[0] + "\n");
  unlinkSync(c.store.path);
  await assert.rejects(async () => {
    const response = await fetch(c.origin + "/api/v1/download", {
      headers: { Authorization: `Bearer ${c.browserToken}` },
    });
    await response.arrayBuffer();
  });
  assert.equal((await fetch(c.origin + "/api/v1/health")).status, 200);
  assert.throws(() => c.ingest(fixture[1] + "\n"), (error) => error.status === 503);
});
test("valid maximum-length ID batch fits the native 2 MiB acknowledgment limit", (t) => {
  const s = store(t), ended = JSON.parse(fixture.at(-1));
  for (const character of ["a", "漢"]) {
    const records = Array.from({ length: 500 }, (_, i) => ({
      ...ended,
      sequence: 1,
      event_id: `${character}-event-${i}`.padEnd(512, character),
      recording_id: `${character}-record-${i}`.padEnd(512, "r"),
    }));
    // Unicode IDs use fewer events when needed to stay within the 1 MiB request bound.
    while (Buffer.byteLength(records.map(line).join("")) > 1024 * 1024) records.pop();
    const ack = s.ingest(records.map(line).join("")),
      size = Buffer.byteLength(JSON.stringify(ack));
    assert.ok(size > 512 * 1024);
    assert.ok(size <= 2 * 1024 * 1024);
    assert.equal(ack.accepted, records.length);
  }
});
