import http from "node:http";
import https from "node:https";
import { timingSafeEqual, createHash, X509Certificate } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { readFileSync, createReadStream } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureStore, TransferError } from "./store.mjs";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};
function authenticated(req, token) {
  const actual = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const reply = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
export async function awaitExportDrain(res, deadline) {
  if (res.destroyed) return;
  await new Promise((ok, fail) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      res.off("drain", drain);
      res.off("close", close);
      res.off("error", error);
    };
    const drain = () => {
      cleanup();
      ok();
    };
    const close = () => {
      cleanup();
      ok();
    };
    const error = (e) => {
      cleanup();
      fail(e);
    };
    timer = setTimeout(
      () => error(new TransferError(408, "Export deadline exceeded")),
      Math.max(1, deadline - Date.now()),
    );
    timer.unref();
    res.once("drain", drain);
    res.once("close", close);
    res.once("error", error);
  });
}
async function body(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit)
      throw new TransferError(413, "Batch exceeds byte limit");
    chunks.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new TransferError(400, "Body must be valid UTF-8");
  }
}
async function controlJSON(req) {
  if (
    (req.headers["content-type"] || "").split(";")[0].trim() !==
    "application/json"
  )
    throw new TransferError(415, "Use application/json");
  let value;
  try {
    value = JSON.parse(await body(req, 16384));
  } catch (error) {
    if (error.status) throw error;
    throw new TransferError(400, "Invalid control JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TransferError(400, "Control JSON must be an object");
  const pending = [[value, 0]];
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (depth > 16)
      throw new TransferError(400, "Control JSON nesting too deep");
    if (node && typeof node === "object") {
      const entries = Object.values(node);
      if (entries.length > 64)
        throw new TransferError(400, "Control JSON has too many fields");
      for (const child of entries) pending.push([child, depth + 1]);
    }
  }
  return value;
}
export async function startCollector({
  directory,
  port = 4319,
  viewerDirectory = fileURLToPath(new URL("../viewer/dist", import.meta.url)),
  tls = null,
  limits = {},
  testCommitGate,
  testClock,
  testFilesystemFaults,
  exportTimeoutMs = 120000,
} = {}) {
  const store = new CaptureStore(directory, limits, {
    testCommitGate,
    testClock,
    testFilesystemFaults,
  });
  await store.ready;
  const subscribers = new Set();
  let server, secureServer;
  let origin;
  const connections = [];
  const adapterStatus = {};
  let uploads = 0,
    exports = 0,
    controls = 0;
  const sourceUploads = new Map();
  const bearer = (req) =>
    (req.headers.authorization || "").replace(/^Bearer /, "");
  const hint = () => ({
    collector_id: store.config.collector_id,
    event_cursor: store.cursor,
    cursor: store.cursor,
    registry_revision: store.registryRevision,
  });
  const publish = () => {
    for (const res of subscribers) {
      if (res.writableLength > 64 * 1024) {
        res.destroy();
        continue;
      }
      res.write(`event: changed\ndata: ${JSON.stringify(hint())}\n\n`);
    }
  };
  async function handle(req, res, lan = false) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    let controlReserved = false;
    try {
      const listenerOrigin = lan
        ? `https://${tls.host.includes(":") ? "[" + tls.host + "]" : tls.host}:${secureServer.address().port}`
        : origin;
      const permittedHosts = lan
        ? [new URL(listenerOrigin).host]
        : [new URL(origin).host, `localhost:${server.address().port}`];
      if (!permittedHosts.includes(req.headers.host))
        throw new TransferError(403, "Unrecognized collector host");
      const browserOrigin = `http://${req.headers.host}`;
      if (
        req.headers.origin &&
        req.headers.origin !== (lan ? origin : browserOrigin)
      )
        throw new TransferError(403, "Unrecognized browser origin");
      if (!req.url.startsWith("/") || req.url.startsWith("//"))
        throw new TransferError(400, "Use origin-form request targets");
      const url = new URL(req.url, origin);
      const route = url.pathname;
      if (req.method === "POST" && route !== "/api/v2/events") {
        if (controls >= 8) {
          res.setHeader("Retry-After", "1");
          throw new TransferError(429, "Control capacity busy");
        }
        controls++;
        controlReserved = true;
      }
      if (req.method === "POST" && route === "/api/v2/register") {
        const metadata = await controlJSON(req);
        const result = await store.register(bearer(req), metadata);
        reply(res, 200, { ...result, endpoint: listenerOrigin });
        publish();
        return;
      }
      if (req.method === "POST" && route === "/api/v2/presence") {
        const result = await store.presence(
          bearer(req),
          await controlJSON(req),
        );
        reply(res, 200, result);
        publish();
        return;
      }
      if (req.method === "POST" && route === "/api/v2/events") {
        const token = bearer(req);
        if (uploads >= 8) {
          res.setHeader("Retry-After", "1");
          throw new TransferError(429, "Collector upload capacity busy");
        }
        if (
          (req.headers["content-type"] || "").split(";")[0].trim() !==
          "application/x-ndjson"
        )
          throw new TransferError(415, "Use application/x-ndjson");
        uploads++;
        let source_id;
        try {
          source_id = (await store.authorize(token)).source_id;
          const count = sourceUploads.get(source_id) || 0;
          if (count >= 2) {
            source_id = null;
            res.setHeader("Retry-After", "1");
            throw new TransferError(429, "Source upload capacity busy");
          }
          sourceUploads.set(source_id, count + 1);
          const result = await store.ingest(
            token,
            await body(req, store.limits.batchBytes),
          );
          reply(res, 200, result);
          publish();
        } finally {
          uploads--;
          if (source_id) {
            sourceUploads.set(
              source_id,
              (sourceUploads.get(source_id) || 1) - 1,
            );
            if (!sourceUploads.get(source_id)) sourceUploads.delete(source_id);
          }
        }
        return;
      }
      if (lan)
        throw new TransferError(
          404,
          "LAN listener only accepts paired capture uploads",
        );
      if (req.method === "GET" && route === "/api/v2/health") {
        reply(res, 200, {
          version: 2,
          service: "http-sequence-logger",
          automatic_viewer: true,
          collector_id: store.config.collector_id,
          live: true,
          ...hint(),
          adapters: adapterStatus,
          storage: {
            sqlite_version: store.config.sqlite_version,
            queued_bytes: store.bytes,
            queued_jobs: store.jobs,
            directory: store.directory,
            limits: store.limits,
          },
        });
        return;
      }
      if (req.method === "GET" && route === "/api/v2/bootstrap") {
        // A top-level navigation, image, foreign page or untrusted Host cannot
        // acquire credentials. Browser scripts cannot set Sec-Fetch-* headers.
        if (
          req.headers["sec-fetch-site"] !== "same-origin" ||
          req.headers["sec-fetch-mode"] !== "same-origin" ||
          req.headers["x-network-log-viewer"] !== "1"
        )
          throw new TransferError(
            403,
            "Open the viewer on this collector's local address",
          );
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        reply(res, 200, {
          version: 2,
          collector_id: store.config.collector_id,
          token: store.config.browser_token,
        });
        return;
      }
      if (req.method === "POST" && route.startsWith("/api/v2/admin/")) {
        if (!authenticated(req, store.config.browser_token))
          throw new TransferError(
            401,
            "Local administrator authorization required",
          );
        if (
          req.headers["sec-fetch-site"] !== "same-origin" ||
          req.headers["x-network-log-viewer"] !== "1"
        )
          throw new TransferError(403, "Use the trusted local viewer");
        const data = await controlJSON(req);
        let result;
        if (route === "/api/v2/admin/enrollment")
          result = await store.ticket(data);
        else if (route === "/api/v2/admin/revoke")
          result = await store.revoke(data.source_id);
        else if (route === "/api/v2/admin/rotate")
          result = await store.rotate(data.source_id);
        else if (route === "/api/v2/admin/backup")
          result = await store.backup();
        else throw new TransferError(404, "Unknown administration route");
        reply(res, 200, result);
        publish();
        return;
      }
      if (route.startsWith("/api/")) {
        if (!authenticated(req, store.config.browser_token))
          throw new TransferError(401, "Reconnect to the local collector");
        if (req.method !== "GET")
          throw new TransferError(405, "Method not allowed");
        const int = (name, fallback) => {
          const v = url.searchParams.get(name);
          if (v == null) return fallback;
          if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
            throw new TransferError(400, `Invalid ${name}`);
          return Number(v);
        };
        const query = {
          after: int("after", 0),
          high_water: int("high_water", undefined),
          source_id: url.searchParams.get("source_id") || undefined,
          session_namespace:
            url.searchParams.get("session_namespace") || undefined,
          session_id: url.searchParams.get("session_id") || undefined,
        };
        if (route === "/api/v2/events") {
          reply(res, 200, await store.page(query));
          return;
        }
        if (route === "/api/v2/sessions") {
          reply(
            res,
            200,
            await store.sessions({
              ...query,
              limit: int("limit", 100),
              latest: url.searchParams.get("latest") === "true",
            }),
          );
          return;
        }
        if (route === "/api/v2/sources") {
          reply(
            res,
            200,
            await store.sources({
              after: url.searchParams.get("after") || "",
              limit: int("limit", 1000),
              registry_revision: int("registry_revision", undefined),
            }),
          );
          return;
        }
        if (route === "/api/v2/pairing") {
          reply(res, 200, { connections });
          return;
        }
        if (route === "/api/v2/status") {
          reply(res, 200, {
            ...(await store.status()),
            adapters: adapterStatus,
          });
          return;
        }
        if (route === "/api/v2/download") {
          if (exports >= 2) throw new TransferError(429, "Too many exports");
          exports++;
          try {
            const H = store.cursor;
            res.writeHead(200, {
              "Content-Type": "application/x-ndjson",
              "Content-Disposition": 'attachment; filename="capture.ndjson"',
            });
            let after = 0;
            const deadline = Date.now() + exportTimeoutMs;
            while (after < H && !res.destroyed) {
              if (Date.now() > deadline) throw new Error("Export timeout");
              const page = await store.page({ ...query, after, high_water: H });
              after = page.next_after;
              for (const line of page.lines)
                if (!res.write(line + "\n"))
                  await awaitExportDrain(res, deadline);
            }
            if (!res.destroyed) res.end();
          } finally {
            exports--;
          }
          return;
        }
        if (route === "/api/v2/stream") {
          if (subscribers.size >= 32)
            throw new TransferError(429, "Too many live viewers");
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders();
          subscribers.add(res);
          res.write(`event: ready\ndata: ${JSON.stringify(hint())}\n\n`);
          const timer = setInterval(() => res.write(": heartbeat\n\n"), 15000);
          timer.unref();
          res.on("close", () => {
            clearInterval(timer);
            subscribers.delete(res);
          });
          return;
        }
        throw new TransferError(404, "Unknown collector route");
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw new TransferError(405, "Method not allowed");
      const root = await realpath(viewerDirectory).catch(() => null);
      if (!root) {
        reply(res, 503, {
          error: "Build the viewer with npm run build:viewer first",
        });
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(route);
      } catch {
        throw new TransferError(400, "Invalid path");
      }
      const target = await realpath(
        resolve(root, "." + (pathname === "/" ? "/index.html" : pathname)),
      ).catch(() => null);
      if (!target || !target.startsWith(root + sep))
        throw new TransferError(404, "File not found");
      let content = await readFile(target);
      if (extname(target) === ".html")
        content = Buffer.from(
          content
            .toString("utf8")
            .replace(
              "</head>",
              '<meta name="network-log-collector" content="1"></head>',
            ),
        );
      res.setHeader(
        "Content-Type",
        mime[extname(target)] || "application/octet-stream",
      );
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else
        reply(res, error.status || 500, {
          error: error.status
            ? error.message
            : "Collector failed to process the request",
        });
    } finally {
      if (controlReserved) controls--;
    }
  }
  server = http.createServer((req, res) => handle(req, res));
  server.maxConnections = 96;
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(port, "127.0.0.1", ok);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    const connection = {
      version: 2,
      endpoint: origin,
      enrollment_token: (
        await store.ticket({ principal: "native-pairing", max_sources: 1 })
      ).enrollment_token,
      collector_id: store.config.collector_id,
      certificate_sha256: null,
    };
    connections.push(connection);
    if (tls) {
      const cert = readFileSync(tls.cert);
      const fingerprint = createHash("sha256")
        .update(new X509Certificate(cert).raw)
        .digest("hex");
      secureServer = https.createServer(
        { key: readFileSync(tls.key), cert, minVersion: "TLSv1.2" },
        (req, res) => handle(req, res, true),
      );
      secureServer.requestTimeout = 15000;
      secureServer.headersTimeout = 10000;
      await new Promise((ok, fail) => {
        secureServer.once("error", fail);
        secureServer.listen(tls.port ?? 4320, tls.bind ?? "::", ok);
      });
      connections.push({
        ...connection,
        endpoint: `https://${tls.host.includes(":") ? "[" + tls.host + "]" : tls.host}:${secureServer.address().port}`,
        certificate_sha256: fingerprint,
      });
    }
  } catch (error) {
    server?.close();
    secureServer?.close();
    await store.close();
    throw error;
  }
  let expireTask;
  const presenceTimer = setInterval(() => {
    if (expireTask) return;
    expireTask = store
      .expirePresence()
      .then((result) => {
        if (result.changed) publish();
      })
      .catch(() => {})
      .finally(() => {
        expireTask = null;
      });
  }, 10000);
  presenceTimer.unref();
  let closePromise;
  return {
    store,
    origin,
    connections,
    browserToken: store.config.browser_token,
    viewerURL: `${origin}/`,
    setAdapterStatus(name, status) {
      adapterStatus[name] = { ...status };
      publish();
    },
    setDeviceStatus(status) {
      adapterStatus.android = { ...status };
      publish();
    },
    async enroll(metadata, principal = "local", scope = {}) {
      const ticket = await store.ticket({ principal, scope });
      const result = await store.register(ticket.enrollment_token, {
        version: 2,
        ...metadata,
      });
      publish();
      const { enrollment_token, ...base } = connections[0];
      return { ...base, ...result };
    },
    async ingest(token, text, checkpoint) {
      const result = await store.ingest(token, text, checkpoint);
      publish();
      return result;
    },
    close() {
      return (closePromise ??= (async () => {
        clearInterval(presenceTimer);
        await expireTask;
        for (const res of subscribers) res.end();
        await Promise.all(
          [server, secureServer].filter(Boolean).map(
            (s) =>
              new Promise((ok) => {
                s.close(ok);
                s.closeAllConnections();
              }),
          ),
        );
        await store.close();
      })());
    },
  };
}
