// Node-only development middleware. Never import this module into browser source.
import { readFileSync, statSync } from "node:fs";

const BATCH_BYTES = 1024 * 1024, ACK_BYTES = 2 * 1024 * 1024;
function problem(status, message) { return Object.assign(new Error(message), { status }); }
function reply(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}
function readRequest(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const finish = (error) => {
      clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("error", failed); req.off("aborted", failed);
      if (error) {
        // An interrupted/oversized upload can emit a later stream error while draining.
        req.once("error", () => {});
        req.resume(); reject(error);
      }
      else resolve(Buffer.concat(chunks));
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > BATCH_BYTES) finish(problem(413, "Batch exceeds 1 MiB"));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () => finish(problem(400, "Request body was interrupted"));
    const timer = setTimeout(() => finish(problem(408, "Request body timed out")), timeoutMs);
    req.on("data", data); req.once("end", end); req.once("error", failed); req.once("aborted", failed);
  });
}
async function readResponse(response) {
  if (!response.body) throw problem(502, "Collector response body is unavailable");
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ACK_BYTES) throw problem(502, "Collector acknowledgment exceeds 2 MiB");
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw problem(502, "Collector returned invalid JSON"); }
  } catch (error) { reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Read pairing once at startup. Mount only on a development server bound to loopback. */
export function createNetworkLogRelay({ connectionFile, origin, basePath = "/__network_log", timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
  let connection;
  try {
    if (statSync(connectionFile).size > 16 * 1024) throw new Error();
    connection = JSON.parse(readFileSync(connectionFile, "utf8"));
  } catch { throw new Error("Could not read the private collector connection file"); }
  let endpoint, frontend;
  try { endpoint = new URL(connection.endpoint); frontend = new URL(origin); }
  catch { throw new Error("Invalid collector or frontend origin"); }
  if (connection.version !== 1 || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
      endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
      ![endpoint.origin, endpoint.origin + "/"].includes(connection.endpoint) ||
      (connection.certificate_sha256 !== null && connection.certificate_sha256 !== undefined) ||
      typeof connection.token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(connection.token) ||
      typeof connection.collector_id !== "string" || !connection.collector_id || connection.collector_id.length > 512)
    throw new Error("Relay requires a valid loopback HTTP collector connection");
  if (!["http:", "https:"].includes(frontend.protocol) || frontend.username || frontend.password || frontend.pathname !== "/" || frontend.search || frontend.hash)
    throw new Error("Relay requires an HTTP(S) frontend origin");
  if (!/^\/[A-Za-z0-9_/-]+$/.test(basePath) || basePath.startsWith("//"))
    throw new Error("Relay basePath must be an absolute path");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Relay timeout must be positive");
  basePath = basePath.replace(/\/+$/, "");
  let inFlight = 0;
  return async function networkLogRelay(req, res, next = () => reply(res, 404, { error: "Not found" })) {
    if (req.url !== basePath && !req.url?.startsWith(basePath + "/")) { next(); return; }
    let entered = false;
    try {
      if (req.headers.host !== frontend.host) throw problem(403, "Unrecognized frontend host");
      if (req.headers.origin && req.headers.origin !== frontend.origin) throw problem(403, "Unrecognized frontend origin");
      if (req.method === "GET" && req.url === basePath + "/config") {
        reply(res, 200, { version: 1, collector_id: connection.collector_id }); return;
      }
      if (req.url !== basePath + "/events") throw problem(404, "Unknown relay route");
      if (req.method !== "POST") throw problem(405, "Relay accepts POST uploads");
      if (req.headers.origin !== frontend.origin) throw problem(403, "Same-origin browser uploads are required");
      if ((req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/x-ndjson" ||
          (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity"))
        throw problem(415, "Use uncompressed application/x-ndjson");
      if (inFlight >= 2) throw problem(429, "Relay already has two active uploads");
      inFlight++; entered = true;
      const raw = await readRequest(req, timeoutMs);
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
      catch { throw problem(400, "Batch must be valid UTF-8"); }
      if (!text || !text.endsWith("\n")) throw problem(400, "Batch must contain complete NDJSON lines");
      let count = 0;
      for (const character of text) if (character === "\n" && ++count > 500) throw problem(413, "Batch exceeds 500 events");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", disconnected);
      try {
        const response = await fetchImpl(endpoint.origin + "/api/v1/events", {
          method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/x-ndjson" },
          body: raw, redirect: "manual", signal: controller.signal,
        });
        if (response.status !== 200) {
          response.body?.cancel().catch(() => {});
          const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
          throw problem(status, `Collector rejected upload (HTTP ${response.status})`);
        }
        const ack = await readResponse(response);
        if (ack?.version !== 1 || ack.collector_id !== connection.collector_id || !Array.isArray(ack.acknowledged_event_ids))
          throw problem(502, "Collector acknowledgment identity is invalid");
        reply(res, 200, ack);
      } finally { clearTimeout(timer); res.off("close", disconnected); }
    } catch (error) {
      reply(res, error.status || 502, { error: error.status ? error.message : "Collector delivery failed or timed out; capture was retained" });
    } finally { if (entered) inFlight--; }
  };
}
