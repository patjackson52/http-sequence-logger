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

async function request(fetchImpl, url, options, timeoutMs, signal) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          ...options, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error", mode: "same-origin",
        });
        if (response.status !== 200) {
          response.body?.cancel().catch(() => {});
          throw Object.assign(new Error(`Relay rejected delivery (HTTP ${response.status})`), {status: response.status});
        }
        return readJSON(response);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Relay request timed out")); }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Source registration precedes capture, so zero-event pages appear in the viewer. */
export async function uploadJournal(journal, { basePath = "/__network_log", fetchImpl = globalThis.fetch, origin = globalThis.location?.origin, timeoutMs = 10_000, appId = "web-app", environmentName = "Browser", collectorId, signal } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof fetchImpl !== "function") throw new TypeError("Invalid transfer options");
  const base = route(basePath, origin), identity = journal.identity;
  signal?.throwIfAborted();
  const config = await request(fetchImpl, base + "/register", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ ...identity, app_id: appId, environment_name: environmentName, origin, version: 2, platform: "web", registration_id: identity.journal_id })}, timeoutMs, signal);
  signal?.throwIfAborted();
  if (config?.version !== 2 || typeof config.collector_id !== "string" || typeof config.source_id !== "string" || typeof config.handle !== "string") throw new Error("Relay returned invalid source registration");
  if (collectorId && collectorId !== config.collector_id) throw new Error("Another collector selected; select it explicitly");
  let after = journal.getDeliveryCursor(config.collector_id, config.source_id), events = 0, batches = 0;
  for (;;) {
    signal?.throwIfAborted();
    const page = await journal.readPage(after);
    if (!page.lines.length) break;
    const ids = page.lines.map(line => { const event = JSON.parse(line); if (typeof event.event_id !== "string" || !event.event_id) throw new Error("Journal requires stable event IDs"); return event.event_id; });
    const ack = await request(fetchImpl, base + "/events", {method: "POST", headers: {"Content-Type": "application/x-ndjson", "X-Network-Log-Handle": config.handle}, body: page.lines.join("")}, timeoutMs, signal);
    signal?.throwIfAborted();
    if (ack.version !== 2 || ack.collector_id !== config.collector_id || ack.source_id !== config.source_id || !Array.isArray(ack.acknowledged_event_ids) || ids.some(id => !ack.acknowledged_event_ids.includes(id))) throw new Error("Collector acknowledgment identity is invalid or incomplete");
    await journal.acknowledge(config.collector_id, config.source_id, page.next);
    after = page.next; events += ids.length; batches++;
  }
  if (!events) await request(fetchImpl, base + "/presence", {method:"POST", headers:{"Content-Type":"application/json", "X-Network-Log-Handle":config.handle},body:JSON.stringify({instance_id:identity.instance_id})}, timeoutMs, signal);
  return {events, batches, collectorId:config.collector_id, sourceId:config.source_id};
}

/** One foreground drain; append notifications and an idle heartbeat wake it. */
export function startJournalDelivery(journal, options = {}) {
  let stopped = false, running = false, dirty = true, timer, retryDelay = 1000, collectorId = options.collectorId;
  const controller = new AbortController();
  const status = options.onStatus || (() => {});
  async function drain() {
    if (stopped || running) { dirty = true; return; }
    running = true; clearTimeout(timer);
    try {
      do {
        dirty = false;
        const result = await uploadJournal(journal, {...options, collectorId, signal:controller.signal});
        if (stopped) return;
        retryDelay = 10000; collectorId = result.collectorId; status({state: result.events ? "delivering" : "ready", ...result});
      } while (dirty && !stopped);
    } catch (error) { retryDelay = [401,403,409,507].includes(error.status) ? 30000 : 1000; if (!stopped) status({state:"backlog", error:error.message}); }
    finally { running = false; if (!stopped) timer = setTimeout(drain, retryDelay); }
  }
  const unsubscribe = journal.subscribe(() => { dirty = true; queueMicrotask(drain); });
  queueMicrotask(drain);
  return { wake: drain, stop() { stopped = true; controller.abort(); clearTimeout(timer); unsubscribe(); } };
}
