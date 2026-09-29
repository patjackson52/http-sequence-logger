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
export async function startCollector({
  directory,
  port = 4319,
  viewerDirectory = fileURLToPath(new URL("../viewer/dist", import.meta.url)),
  tls = null,
  limits = {},
} = {}) {
  const store = new CaptureStore(directory, limits);
  const subscribers = new Set();
  let server, secureServer;
  let origin;
  const connections = [];
  const publish = () => {
    for (const res of subscribers) {
      if (res.writableLength > 64 * 1024) {
        res.destroy();
        continue;
      }
      res.write(
        `event: changed\ndata: ${JSON.stringify({ collector_id: store.config.collector_id, cursor: store.cursor })}\n\n`,
      );
    }
  };
  async function handle(req, res, lan = false) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    try {
      const listenerOrigin = lan
        ? `https://${tls.host.includes(":") ? "[" + tls.host + "]" : tls.host}:${secureServer.address().port}`
        : origin;
      const permittedHosts = lan
        ? [new URL(listenerOrigin).host]
        : [new URL(origin).host, `localhost:${server.address().port}`];
      if (!permittedHosts.includes(req.headers.host))
        throw new TransferError(403, "Unrecognized collector host");
      if (req.headers.origin && req.headers.origin !== origin)
        throw new TransferError(403, "Unrecognized browser origin");
      if (!req.url.startsWith("/") || req.url.startsWith("//"))
        throw new TransferError(400, "Use origin-form request targets");
      const url = new URL(req.url, origin);
      const route = url.pathname;
      if (req.method === "POST" && route === "/api/v1/events") {
        if (!authenticated(req, store.config.device_token))
          throw new TransferError(401, "Pair the app with this collector");
        if (
          (req.headers["content-type"] || "").split(";")[0].trim() !==
          "application/x-ndjson"
        )
          throw new TransferError(415, "Use application/x-ndjson");
        const result = store.ingest(await body(req, store.limits.batchBytes));
        reply(res, 200, result);
        if (result.accepted) publish();
        return;
      }
      if (lan)
        throw new TransferError(
          404,
          "LAN listener only accepts paired capture uploads",
        );
      if (req.method === "GET" && route === "/api/v1/health") {
        reply(res, 200, {
          version: 1,
          collector_id: store.config.collector_id,
          live: true,
          recovered_partial_tail: store.recoveredPartial,
        });
        return;
      }
      if (route.startsWith("/api/")) {
        if (!authenticated(req, store.config.browser_token))
          throw new TransferError(
            401,
            "Open the viewer link printed by the collector",
          );
        if (req.method !== "GET")
          throw new TransferError(405, "Method not allowed");
        if (route === "/api/v1/events") {
          const after = url.searchParams.get("after") ?? "0";
          if (!/^\d+$/.test(after))
            throw new TransferError(400, "Invalid capture cursor");
          reply(res, 200, store.page(Number(after)));
          return;
        }
        if (route === "/api/v1/pairing") {
          reply(res, 200, { connections });
          return;
        }
        if (route === "/api/v1/download") {
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson",
            "Content-Disposition": 'attachment; filename="capture.ndjson"',
          });
          createReadStream(store.path).pipe(res);
          return;
        }
        if (route === "/api/v1/stream") {
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
          res.write(
            `event: ready\ndata: ${JSON.stringify({ collector_id: store.config.collector_id, cursor: store.cursor })}\n\n`,
          );
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
      const content = await readFile(target);
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
      if (res.headersSent) res.destroy();
      else
        reply(res, error.status || 500, {
          error: error.status
            ? error.message
            : "Collector failed to process the request",
        });
    }
  }
  server = http.createServer((req, res) => handle(req, res));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(port, "127.0.0.1", ok);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    const connection = {
      version: 1,
      endpoint: origin,
      token: store.config.device_token,
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
        secureServer.listen(tls.port ?? 4320, tls.bind ?? "0.0.0.0", ok);
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
    store.close();
    throw error;
  }
  return {
    store,
    origin,
    connections,
    browserToken: store.config.browser_token,
    viewerURL: `${origin}/#collector=${store.config.browser_token}`,
    ingest(text) {
      const result = store.ingest(text);
      if (result.accepted) publish();
      return result;
    },
    async close() {
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
      store.close();
    },
  };
}
