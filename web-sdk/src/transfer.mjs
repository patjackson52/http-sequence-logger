const encoder = new TextEncoder();
const BATCH_BYTES = 1024 * 1024;
const ACK_BYTES = 2 * 1024 * 1024;

function route(basePath, origin) {
  if (typeof basePath !== "string" || !/^\/[A-Za-z0-9_/-]+$/.test(basePath) || basePath.startsWith("//"))
    throw new TypeError("basePath must be a same-origin absolute path");
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new TypeError("origin must be an HTTP(S) origin");
  return url.origin + basePath.replace(/\/+$/, "");
}

async function readJSON(response) {
  if (!response.body) throw new Error("Relay response body is unavailable");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ACK_BYTES) throw new Error("Relay response exceeds the 2 MiB limit");
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)); }
    catch { throw new Error("Relay returned invalid JSON"); }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function request(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          ...options, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", mode: "same-origin",
        });
        if (response.status !== 200) {
          response.body?.cancel().catch(() => {});
          throw new Error(`Relay rejected delivery (HTTP ${response.status})`);
        }
        return readJSON(response);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Relay request timed out")); }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Explicit foreground delivery. Replays the retained journal; never deletes it. */
export async function uploadJournal(journal, { basePath = "/__network_log", fetchImpl = globalThis.fetch, origin = globalThis.location?.origin, timeoutMs = 10_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be positive");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable");
  const base = route(basePath, origin);
  await journal.flush();
  const capture = journal.exportNDJSON();
  // Events appended while the first barrier was pending are included in this snapshot.
  await journal.flush();
  if (capture && !capture.endsWith("\n")) throw new Error("Journal must contain complete NDJSON lines");
  const batches = [];
  let lines = [], ids = [], bytes = 0, events = 0;
  for (const line of capture ? capture.slice(0, -1).split("\n") : []) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("Journal contains invalid JSON"); }
    if (typeof event?.event_id !== "string" || !event.event_id || event.event_id.length > 512)
      throw new Error("Journal event requires a stable event_id");
    const size = encoder.encode(line + "\n").byteLength;
    if (size > BATCH_BYTES) throw new Error("A journal event exceeds the 1 MiB batch limit");
    if (ids.length === 500 || bytes + size > BATCH_BYTES) {
      batches.push({ body: lines.join(""), ids }); lines = []; ids = []; bytes = 0;
    }
    lines.push(line + "\n"); ids.push(event.event_id); bytes += size; events++;
  }
  if (ids.length) batches.push({ body: lines.join(""), ids });
  const config = await request(fetchImpl, base + "/config", { method: "GET" }, timeoutMs);
  if (config?.version !== 1 || typeof config.collector_id !== "string" || !config.collector_id || config.collector_id.length > 512)
    throw new Error("Relay returned invalid collector configuration");
  for (const batch of batches) {
    const ack = await request(fetchImpl, base + "/events", { method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body: batch.body }, timeoutMs);
    if (ack?.version !== 1 || ack.collector_id !== config.collector_id || !Array.isArray(ack.acknowledged_event_ids))
      throw new Error("Collector acknowledgment identity is invalid");
    const acknowledged = new Set(ack.acknowledged_event_ids);
    if (batch.ids.some((id) => !acknowledged.has(id)))
      throw new Error("Collector did not acknowledge every submitted event");
  }
  return { events, batches: batches.length, collectorId: config.collector_id };
}
