import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startCollector } from "./server.mjs";
import { localCertificate } from "./tls.mjs";
import { adbPath, watchAndroid } from "./android-live.mjs";

import { watchSimulators } from "./ios-simulator.mjs";
import { advertiseCollector } from "./bonjour.mjs";
import { publishManifest } from "./registry.mjs";
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function buildViewer() {
  const { build } = await import("vite");
  await build({
    configFile: resolve(repoRoot, "viewer/vite.config.mjs"),
    logLevel: "warn",
  });
}
export function openViewer(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`Open the viewer at ${url}`));
  child.unref();
}
export async function startDesktopCollector(options = {}) {
  const directory = resolve(repoRoot, options.dir || "artifacts/collector-v2");
  const tls = options.lan
    ? {
        ...localCertificate(directory, options.lan),
        port: options.tlsPort || 4320,
      }
    : null;
  const collector = await startCollector({
    directory,
    port: options.port || 4319,
    tls,
  });
  let watcher, simulators, manifest, advertisement;
  try {
    for (const [i, connection] of collector.connections.entries())
      writeFileSync(
        resolve(
          directory,
          i ? "connection-lan.json" : "connection-loopback.json",
        ),
        JSON.stringify(connection, null, 2) + "\n",
        { mode: 0o600 },
      );
    if (options.activate !== false) {
      manifest = await publishManifest(collector, options.manifest);
      if (!manifest.active) {
        collector.setAdapterStatus("active-manifest", {
          state: "waiting",
          reason: `${manifest.reason}; this collector is inactive for default relays`,
          next_action:
            "Use an explicit private manifest or stop the active owner",
        });
        console.warn(
          `Collector is inactive for default relays: ${manifest.path}: ${manifest.reason}. Select an explicit manifest for this collector.`,
        );
      }
    } else
      collector.setAdapterStatus("active-manifest", {
        state: "inactive",
        reason:
          "Started with --no-activate; use explicit producer/relay configuration",
      });
    console.log(
      `Viewer: ${collector.viewerURL}\nCapture: ${collector.store.path}`,
    );
    if (options.android !== false)
      watcher = await watchAndroid({
        collector,
        packageName: options.android || undefined,
        device: options.device || process.env.ANDROID_SERIAL,
        adb: adbPath(options.adb),
      });
    if (options.ios !== false)
      simulators = await watchSimulators({
        collector,
        device: options.simulator,
        bundleID: options.ios,
      });
    advertisement = advertiseCollector(collector, { enabled: options.bonjour });
    if (options.open) openViewer(collector.viewerURL);
    let closePromise;
    return {
      collector,
      close() {
        return (closePromise ??= (async () => {
          await watcher?.close();
          await simulators?.close();
          await manifest?.close();
          await advertisement?.close();
          await collector.close();
        })());
      },
    };
  } catch (error) {
    await watcher?.close();
    await simulators?.close();
    await manifest?.close();
    await advertisement?.close();
    await collector.close();
    throw error;
  }
}
