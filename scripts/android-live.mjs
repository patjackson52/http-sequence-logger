#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename, isAbsolute } from "node:path";
import {
  adbPath,
  connectedDevices,
  selectDevice,
  SAMPLE_PACKAGE,
} from "../collector/android-live.mjs";
import {
  buildViewer,
  openViewer,
  repoRoot,
  startDesktopCollector,
} from "../collector/runtime.mjs";

const args = process.argv.slice(2),
  options = {
    open: true,
    run: "success",
    dir: "artifacts/collector-v2",
    port: 4319,
  };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log(
      "npm run android:live — build/install the debug sample, pair USB, open the live viewer, and run a sign-in.\nOptional: --device SERIAL --adb PATH --port PORT --dir PATH --recovery --no-run --no-open\nRequires Node dependencies (npm ci), JDK 17, Android SDK 35, and an authorized USB device or emulator.",
    );
    process.exit(0);
  }
  if (args[i] === "--no-open") {
    options.open = false;
    continue;
  }
  if (args[i] === "--no-run") {
    options.run = null;
    continue;
  }
  if (args[i] === "--recovery") {
    options.run = "recovery";
    continue;
  }
  if (
    !["--device", "--adb", "--port", "--dir"].includes(args[i]) ||
    !args[i + 1] ||
    args[i + 1].startsWith("--")
  )
    throw new Error(`Unknown or missing option: ${args[i]}`);
  options[args[i].slice(2)] = args[++i];
}
options.port = Number(options.port);
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
  throw new Error("Invalid port");
const adb = adbPath(options.adb),
  origin = `http://127.0.0.1:${options.port}`;
let runtime;
function run(command, argv, env = process.env) {
  return new Promise((ok, fail) => {
    const child = spawn(command, argv, {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    });
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${command} exited with ${code}`)),
    );
  });
}
try {
  const device = selectDevice(
    await connectedDevices(adb),
    options.device || process.env.ANDROID_SERIAL,
  );
  console.log(`Device: ${device.label} (${device.serial})`);
  // A running collector can be reused only when it owns this exact local directory.
  const health = await fetch(origin + "/api/v2/health", {
    signal: AbortSignal.timeout(1500),
    redirect: "error",
  })
    .then((r) => r.json())
    .catch(() => null);
  let connection;
  if (health) {
    if (health.service !== "http-sequence-logger" || !health.automatic_viewer)
      throw new Error(
        `Restart the collector at ${origin} to use automatic live setup.`,
      );
    try {
      connection = JSON.parse(
        readFileSync(
          resolve(repoRoot, options.dir, "connection-loopback.json"),
          "utf8",
        ),
      );
      if (
        connection.collector_id !== health.collector_id ||
        connection.endpoint !== origin
      )
        throw new Error();
    } catch {
      throw new Error(
        `Port ${options.port} belongs to another collector directory. Use its --dir PATH or choose another --port.`,
      );
    }
  }
  const env = { ...process.env };
  if (
    !env.ANDROID_HOME &&
    !env.ANDROID_SDK_ROOT &&
    isAbsolute(adb) &&
    basename(dirname(adb)) === "platform-tools"
  )
    env.ANDROID_HOME = dirname(dirname(adb));
  if (!env.JAVA_HOME) {
    const java = [
      "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
      "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    ].find(existsSync);
    if (java) env.JAVA_HOME = java;
  }
  console.log("Building Android debug sample…");
  await run(
    resolve(repoRoot, "android/gradlew"),
    ["-p", "android", ":app:assembleDebug", "--console=plain"],
    env,
  );
  await run(adb, [
    "-s",
    device.serial,
    "install",
    "-r",
    resolve(repoRoot, "android/app/build/outputs/apk/debug/app-debug.apk"),
  ]);
  console.log("Building viewer…");
  await buildViewer();
  if (!connection) {
    runtime = await startDesktopCollector({
      ...options,
      open: false,
      device: device.serial,
      adb,
      android: SAMPLE_PACKAGE,
    });
    connection = runtime.collector.connections[0];
  } else console.log(`Using running collector: ${origin}/`);

  if (options.open) openViewer(origin + "/");
  await run(adb, [
    "-s",
    device.serial,
    "shell",
    "am",
    "start",
    "-W",
    "--activity-single-top",
    "-n",
    `${SAMPLE_PACKAGE}/dev.networklog.app.MainActivity`,
    ...(options.run ? ["--es", "networklog.run", options.run] : []),
  ]);
  console.log(
    `Live viewer: ${origin}/\nUSB pairing is automatic. Refresh the viewer normally; no special link or pasted JSON is needed.`,
  );
  if (runtime)
    console.log("Collector running. Keep this command open; Ctrl+C stops it.");
} catch (error) {
  await runtime?.close();
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${options.port} is already in use. Stop that process or choose --port.`
      : error.message,
  );
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await runtime?.close();
    process.exit(0);
  });
