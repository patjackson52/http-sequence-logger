#!/usr/bin/env node
import { buildViewer, startDesktopCollector } from "./runtime.mjs";
const args = process.argv.slice(2),
  options = {};
const subcommand = ["status", "doctor"].includes(args[0]) ? args.shift() : null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log(
      "npm start — build the viewer, start live streaming and discover all participating Android apps and booted iOS simulators.\nnpm run android:live — also build/install/run the sample.\nOptions: --dir PATH --port PORT --android PACKAGE --device SERIAL --adb PATH --lan HOST --tls-port PORT --no-android --no-ios --ios BUNDLE_ID --simulator UDID --manifest PATH --no-activate --bonjour --open --no-open\nThe plain viewer URL connects automatically. USB pairing and forwarding recover after reconnect.",
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
