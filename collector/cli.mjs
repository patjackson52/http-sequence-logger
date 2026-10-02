#!/usr/bin/env node
import { buildViewer, startDesktopCollector } from "./runtime.mjs";
const args = process.argv.slice(2),
  options = {};
const subcommand = ["status", "doctor"].includes(args[0]) ? args.shift() : null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log(
      `Network Log Lab collector — local capture storage and live viewer
Usage (from the repository root, Node 24.13.x, after npm ci):
  npm start -- [options]                 Build viewer, collect, and open browser
  npm run collector -- [options]        Build viewer and collect
  npm run collector -- status [--manifest PATH]
  npm run collector -- doctor [--manifest PATH] [--adb PATH]
  npm run collector -- --help

status reports active-manifest connectivity as JSON; doctor also checks adb/Xcode.
Both are read-only and return 0 even when live=false; inspect the JSON report.
Neither starts a collector, repairs pairing, or prints credentials.

Start options:
  --dir PATH           Capture/state directory (default artifacts/collector-v2;
                       relative paths resolve from this checkout)
  --port PORT          Loopback HTTP/viewer port (default 4319)
  --android PACKAGE    Filter to actual installed debug application ID
  --device SERIAL      Filter Android discovery (default ANDROID_SERIAL or all)
  --adb PATH           Override adb executable (otherwise SDK/PATH discovery)
  --ios BUNDLE_ID      Filter simulator apps by installed bundle ID
  --simulator UDID     Filter booted simulator discovery
  --no-android         Disable Android discovery
  --no-ios             Disable simulator discovery
  --lan HOST           Enable paired HTTPS for this DNS name or IP
  --tls-port PORT      HTTPS port with --lan (default 4320)
  --bonjour            Advertise HTTPS candidates; pairing is still explicit
  --manifest PATH      Publish/select a private active manifest (also diagnostics)
  --no-activate        Do not publish an active manifest
  --open / --no-open   Open/suppress browser (npm start adds --open)
  --help               Show help without building or starting services

Participating apps need capture hooks and debug bootstrap. Discovery does not
install/instrument apps or boot simulators. npm run android:live installs the sample.
Open http://127.0.0.1:4319/ normally; reader bootstrap/reconnect is automatic.
Capture schema 1.2; transfer version 2. State/pairing files contain private keys
or credentials; export sanitized NDJSON with Save capture instead of sharing them.
Ctrl+C stops this collector. It cannot take over an active owner.
Guide: collector/README.md; connection and file map: docs/integration/TRANSPORT.md`,
    );
    process.exit(0);
  }
  if (args[i] === "--no-activate") {
    options.activate = false;
    continue;
  }
  if (args[i] === "--bonjour") {
    options.bonjour = true;
    continue;
  }
  if (args[i] === "--no-ios") {
    options.ios = false;
    continue;
  }
  if (args[i] === "--no-android") {
    options.android = false;
    continue;
  }
  if (args[i] === "--open" || args[i] === "--no-open") {
    options.open = args[i] === "--open";
    continue;
  }
  if (
    ![
      "--dir",
      "--port",
      "--android",
      "--device",
      "--adb",
      "--lan",
      "--tls-port",
      "--ios",
      "--simulator",
      "--manifest",
    ].includes(args[i]) ||
    !args[i + 1] ||
    args[i + 1].startsWith("--")
  )
    throw new Error(`Unknown or missing option: ${args[i]}`);
  const key = args[i].slice(2);
  options[key === "tls-port" ? "tlsPort" : key] = args[++i];
}
for (const key of ["port", "tlsPort"])
  if (options[key] != null) {
    options[key] = Number(options[key]);
    if (
      !Number.isInteger(options[key]) ||
      options[key] < 1 ||
      options[key] > 65535
    )
      throw new Error("Invalid port");
  }
if (subcommand) {
  const { privateJSON, activeManifestPath } = await import("./registry.mjs");
  let report = {
    node: process.version,
    manifest: options.manifest || activeManifestPath(),
  };
  try {
    const m = await privateJSON(report.manifest);
    const r = await fetch(m.endpoint + "/api/v2/health", {
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    report = {
      ...report,
      collector_id: m.collector_id,
      endpoint: m.endpoint,
      live: r.ok,
      ...(await r.json()),
    };
  } catch (e) {
    report = {
      ...report,
      live: false,
      reason: e.message,
      next_action: "Start collector or select an explicit private manifest",
    };
  }
  if (subcommand === "doctor") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execute = promisify(execFile);
    const { adbPath } = await import("./android-live.mjs");
    report.tools = await Promise.all(
      [
        ["adb", adbPath(options.adb), ["version"]],
        ["xcode", "xcodebuild", ["-version"]],
      ].map(async ([name, cmd, args]) => {
        try {
          return {
            name,
            version: (
              await execute(cmd, args, { timeout: 2000, maxBuffer: 16384 })
            ).stdout.trim(),
          };
        } catch (e) {
          return { name, status: "Tool unavailable", reason: e.message };
        }
      }),
    );
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
await buildViewer();
let runtime;
try {
  runtime = await startDesktopCollector(options);
} catch (error) {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${options.port || 4319} is already in use. Open http://127.0.0.1:${options.port || 4319}/ or stop that collector before starting another.`
      : error.message,
  );
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await runtime.close();
    process.exit(0);
  });
