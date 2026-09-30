import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startCollector } from './server.mjs';
import { localCertificate } from './tls.mjs';
import { adbPath, watchAndroid, SAMPLE_PACKAGE } from './android-live.mjs';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildViewer() {
  const { build } = await import('vite');
  await build({ configFile: resolve(repoRoot, 'viewer/vite.config.mjs'), logLevel: 'warn' });
}
export function openViewer(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Open the viewer at ${url}`));
  child.unref();
}
export async function startDesktopCollector(options = {}) {
  const directory = resolve(repoRoot, options.dir || 'artifacts/collector');
  const tls = options.lan ? { ...localCertificate(directory, options.lan), port: options.tlsPort || 4320 } : null;
  const collector = await startCollector({ directory, port: options.port || 4319, tls });
  let watcher;
  try {
    for (const [i, connection] of collector.connections.entries()) writeFileSync(resolve(directory, i ? 'connection-lan.json' : 'connection-loopback.json'), JSON.stringify(connection, null, 2) + '\n', { mode: 0o600 });
    console.log(`Viewer: ${collector.viewerURL}\nCapture: ${collector.store.path}`);
    if (options.android !== false) watcher = await watchAndroid({ collector, packageName: options.android || SAMPLE_PACKAGE, device: options.device || process.env.ANDROID_SERIAL, adb: adbPath(options.adb) });
    if (options.open) openViewer(collector.viewerURL);
    return { collector, async close() { await watcher?.close(); await collector.close(); } };
  } catch (error) { await watcher?.close(); await collector.close(); throw error; }
}
