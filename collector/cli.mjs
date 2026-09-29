#!/usr/bin/env node
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { startCollector } from "./server.mjs";
import { localCertificate } from "./tls.mjs";
import { androidBridge } from "./adb.mjs";
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log(
      "npm run collector -- [--dir artifacts/collector] [--port 4319] [--lan HOST] [--tls-port 4320] [--android APPLICATION_ID --device SERIAL] [--adb PATH]\nAndroid: configures ADB reverse and private pairing, then watches files/captures/*.ndjson as a fallback.\niOS/Wi-Fi: use --lan with the desktop LAN IP/hostname, then paste connection-lan.json in the app.",
    );
    process.exit(0);
  }
  if (
    ![
      "--dir",
      "--port",
      "--lan",
      "--tls-port",
      "--android",
      "--device",
      "--adb",
    ].includes(args[i]) ||
    !args[i + 1]
  )
    throw new Error(`Unknown or missing option: ${args[i]}`);
  options[args[i].slice(2)] = args[++i];
}
const directory = resolve(options.dir || "artifacts/collector");
function port(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error("Invalid port");
  return number;
}
const tls = options.lan
  ? {
      ...localCertificate(directory, options.lan),
      port: port(options["tls-port"], 4320),
    }
  : null;
const collector = await startCollector({
  directory,
  port: port(options.port, 4319),
  tls,
});
for (const [i, connection] of collector.connections.entries())
  writeFileSync(
    resolve(directory, i ? "connection-lan.json" : "connection-loopback.json"),
    JSON.stringify(connection, null, 2) + "\n",
    { mode: 0o600 },
  );
console.log(
  `Viewer: ${collector.viewerURL}\nCapture: ${collector.store.path}\nPairing files: ${directory}/connection-*.json`,
);
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    stopped = true;
    await collector.close();
    process.exit(0);
  });
if (options.android) {
  const bridge = androidBridge({
    packageName: options.android,
    device: options.device,
    adb: options.adb,
  });
  try {
    await bridge.pair(collector.connections[0]);
    console.log(
      "Android paired through ADB reverse. Watching private capture files.",
    );
  } catch (error) {
    console.error(`Android pairing unavailable: ${error.message}`);
  }
  let lastError = "";
  async function poll() {
    if (stopped) return;
    try {
      await bridge.poll((text) => collector.ingest(text));
      if (lastError) console.log("Android file watch reconnected.");
      lastError = "";
    } catch (error) {
      if (error.message !== lastError)
        console.error(`Android file watch: ${error.message}`);
      lastError = error.message;
    }
    if (!stopped) setTimeout(poll, 1500).unref();
  }
  poll();
}
