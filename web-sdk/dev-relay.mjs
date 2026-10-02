// Node-only development middleware. Never import this module into browser source.
import { readFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

/** Same-origin development boundary. Collector credentials never reach page code. */
export function createNetworkLogRelay({ connectionFile = join(homedir(), ".http-sequence-logger", "active.json"), origin, basePath = "/__network_log", timeoutMs = 10_000, fetchImpl = globalThis.fetch, authorize, reachable = false } = {}) {
  const frontend = new URL(origin);
  if (!["http:", "https:"].includes(frontend.protocol) || frontend.username || frontend.password || frontend.pathname !== "/" || frontend.search || frontend.hash) throw new Error("Invalid frontend origin");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(frontend.hostname);
  if (reachable && (frontend.protocol !== "https:" || typeof authorize !== "function")) throw new Error("Reachable relay requires HTTPS and authenticated frontend access");
  if (!reachable && !loopback) throw new Error("Non-loopback frontend requires reachable authenticated relay");
  if (!/^\/[A-Za-z0-9_/-]+$/.test(basePath) || basePath.startsWith("//")) throw new Error("Invalid relay path");
  basePath = basePath.replace(/\/+$/, "");
  const grants = new Map(); let collectorId, inFlight = 0;
  function manifest() {
    let connection;
    try {
      const stat = lstatSync(connectionFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw problem(503, "Unsafe private collector manifest");
      connection = JSON.parse(readFileSync(connectionFile, "utf8"));
    } catch (error) { if (error.status) throw error; throw problem(503, "Waiting for collector; start npm start"); }
    const endpoint = new URL(connection.endpoint);
    if (connection.version !== 2 || endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || typeof connection.enrollment_token !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(connection.enrollment_token)) throw problem(503, "Invalid private collector manifest");
    if (collectorId && collectorId !== connection.collector_id) throw problem(409, "Another collector selected; restart relay with explicit manifest");
    collectorId = connection.collector_id;
    return { ...connection, endpoint: endpoint.origin };
  }
  async function upstream(connection, path, token, body, type, res) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const closed = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", closed);
    try {
      const response = await fetchImpl(connection.endpoint + path, { method:"POST", headers:{Authorization:`Bearer ${token}`, "Content-Type":type}, body, redirect:"error", signal:controller.signal });
      if (response.status !== 200) { response.body?.cancel().catch(() => {}); throw problem(response.status >= 400 && response.status < 600 ? response.status : 502, `Collector returned HTTP ${response.status}`); }
      return await readResponse(response);
    } finally { clearTimeout(timer); res.off("close", closed); }
  }
  return async function networkLogRelay(req, res, next = () => reply(res,404,{error:"Not found"})) {
    if (!req.url?.startsWith(basePath + "/")) { next(); return; }
    let entered = false, grantEntered = false, grant;
    try {
      if (req.headers.host !== frontend.host || req.headers.origin !== frontend.origin) throw problem(403,"Exact frontend Host and Origin are required");
      if (req.method !== "POST") throw problem(405,"Use POST");
      const principal = reachable ? await authorize(req) : "local";
      if (typeof principal !== "string" || !principal || principal.length > 512) throw problem(401,"Authenticated frontend session required");
      const connection = manifest();
      if (inFlight >= 8) throw problem(429,"Relay upload capacity reached");
      inFlight++; entered = true;
      const raw = await readRequest(req,timeoutMs);
      const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw problem(415,"Compressed uploads are unsupported");
      for (const [handle, value] of grants) if (Date.now() - value.seen > 10 * 60 * 1000 && !value.inFlight) grants.delete(handle);
      if (req.url === basePath + "/register") {
        if (type !== "application/json" || raw.length > 16384) throw problem(413,"Registration must be bounded JSON");
        let registration; try { registration = JSON.parse(raw); } catch { throw problem(400,"Invalid registration JSON"); }
        if (registration.version !== 2 || registration.platform !== "web" || registration.origin !== frontend.origin) throw problem(400,"Invalid browser registration");
        for (const key of ["journal_id","installation_id","environment_id","instance_id","app_id","registration_id"]) if (typeof registration[key] !== "string" || !registration[key] || registration[key].length > 512) throw problem(400,"Invalid source identity");
        const key = JSON.stringify([principal,registration.app_id,registration.environment_id,registration.installation_id,registration.journal_id]);
        grant = [...grants.values()].find(value => value.key === key);
        if (!grant) {
          if (grants.size >= 128) throw problem(429,"Relay journal limit reached");
          const result = await upstream(connection,"/api/v2/register",connection.enrollment_token,JSON.stringify(registration),"application/json",res);
          if (result.version !== 2 || result.collector_id !== collectorId || typeof result.source_id !== "string" || typeof result.source_token !== "string") throw problem(502,"Invalid source registration response");
          grant = {key,principal,handle:randomUUID(),sourceId:result.source_id,token:result.source_token,inFlight:0}; grants.set(grant.handle,grant);
        }
        grant.seen = Date.now(); reply(res,200,{version:2,collector_id:collectorId,source_id:grant.sourceId,handle:grant.handle}); return;
      }
      grant = grants.get(req.headers["x-network-log-handle"]);
      if (!grant || grant.principal !== principal) throw problem(403,"Journal handle is absent or belongs to another session");
      if (grant.inFlight >= 2) throw problem(429,"Source upload capacity reached");
      grant.inFlight++; grantEntered = true; grant.seen = Date.now();
      if (req.url === basePath + "/events") {
        if (type !== "application/x-ndjson") throw problem(415,"Use application/x-ndjson");
        const text = new TextDecoder("utf-8",{fatal:true}).decode(raw);
        if (!text || !text.endsWith("\n") || text.split("\n").length > 501) throw problem(400,"Use up to 500 complete event lines");
        const ack = await upstream(connection,"/api/v2/events",grant.token,raw,type,res);
        if (ack.version !== 2 || ack.collector_id !== collectorId || ack.source_id !== grant.sourceId || !Array.isArray(ack.acknowledged_event_ids)) throw problem(502,"Invalid collector acknowledgment");
        reply(res,200,ack);
      } else if (req.url === basePath + "/presence") {
        if (type !== "application/json" || raw.length > 16384) throw problem(415,"Use bounded JSON presence");
        reply(res,200,await upstream(connection,"/api/v2/presence",grant.token,raw,type,res));
      } else throw problem(404,"Unknown relay route");
    } catch (error) { reply(res,error.status || 502,{error:error.status ? error.message : "Collector delivery failed; capture retained"}); }
    finally { if (entered) inFlight--; if (grantEntered) grant.inFlight--; }
  };
}
