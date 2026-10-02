import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  descriptor,
  privateJSON,
  atomicJSON,
  confined,
  registrationID,
  validateGenerationInventory,
} from "./registry.mjs";
import { followJournal } from "./follower.mjs";
const exec = promisify(execFile);
const run = (cmd, args, signal) =>
  exec(cmd, args, { timeout: 10000, maxBuffer: 1024 * 1024, signal });
export async function simulatorDevices(signal) {
  return JSON.parse(
    (await run("xcrun", ["simctl", "list", "devices", "--json"], signal))
      .stdout,
  ).devices;
}
export async function simulatorApps(udid, signal) {
  const plist = (await run("xcrun", ["simctl", "listapps", udid], signal))
    .stdout;
  const output = await new Promise((ok, fail) => {
    const child = execFile(
      "plutil",
      ["-convert", "json", "-o", "-", "-"],
      { timeout: 10000, maxBuffer: 1024 * 1024, signal },
      (e, stdout) => (e ? fail(e) : ok(stdout)),
    );
    child.stdin.end(plist);
  });
  return Object.keys(JSON.parse(output));
}
export async function watchSimulators({
  collector,
  device,
  bundleID,
  interval = 2000,
}) {
  let stopped = false,
    timer,
    running;
  const cancellation = new AbortController();
  const status = (name, value) => {
    if (!stopped) collector.setAdapterStatus(name, value);
  };
  const cache = new Map(),
    connections = new Map(),
    recoverableErrors = new Map();
  async function pairingFile(base, name) {
    try {
      return await privateJSON(resolve(base, name));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async function source(sim, app) {
    let activeConnection;
    try {
      const container = (
        await run(
          "xcrun",
          ["simctl", "get_app_container", sim.udid, app, "data"],
          cancellation.signal,
        )
      ).stdout.trim();
      const base = resolve(
        container,
        "Library/Application Support/HTTPSequenceLogger",
      );
      if ((await realpath(base)) !== base)
        throw new Error("Unsafe descriptor root");
      const raw = await privateJSON(resolve(base, "source.json"));
      const md = descriptor(raw, "ios", app);
      const identity = await realpath(container);
      const key = `${sim.udid}:${app}:${md.installation_id}`;
      const manual = await pairingFile(base, "pairing.json");
      const selected =
        manual || (await pairingFile(base, "pairing-local.json"));
      if (
        selected?.collector_id &&
        selected.collector_id !== collector.store.config.collector_id
      )
        throw new Error("Another collector selected");
      if (manual?.enrollment_token && !manual.source_token)
        throw new Error(
          "Selected app enrollment pending; open app to register",
        );
      const metadata = {
        version: 2,
        platform: "ios",
        environment_id: `simulator:${sim.udid}`,
        environment_name: sim.name,
        app_id: app,
        installation_id: md.installation_id,
        instance_id: md.instance_id,
        registration_id: registrationID([sim.udid, app, md.installation_id]),
      };
      let connection = connections.get(key);
      if (
        selected?.source_token &&
        selected.source_token !== connection?.source_token
      ) {
        const verified = await collector.store.bindLocal(
          selected.source_token,
          metadata,
        );
        if (verified.source_id !== selected.source_id)
          throw new Error("Pairing source identity conflict");
        connection = {
          ...selected,
          endpoint: collector.origin,
          certificate_sha256: null,
        };
      }
      if (!connection) {
        connection = await collector.enroll(
          metadata,
          `simulator:${sim.udid}:${app}`,
          {
            platform: "ios",
            app_id: app,
            installation_id: md.installation_id,
            environment_id: metadata.environment_id,
          },
        );
        const verified = await collector.store.bindLocal(
          connection.source_token,
          metadata,
        );
        if (verified.source_id !== connection.source_id)
          throw new Error("Pairing source identity conflict");
      }
      connections.set(key, connection);
      activeConnection = connection;
      const existing = await pairingFile(base, "pairing-local.json");
      if (
        existing?.source_id !== connection.source_id ||
        existing?.source_token !== connection.source_token ||
        existing?.endpoint !== connection.endpoint ||
        existing?.certificate_sha256 !== connection.certificate_sha256
      )
        await atomicJSON(resolve(base, "pairing-local.json"), connection);
      const inventory = await privateJSON(
        resolve(base, "journal-budget.json"),
      ).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const dir = await realpath(resolve(base, "journals")).catch((error) => {
        if (error.code === "ENOENT") return resolve(base, "journals");
        throw error;
      });
      if (!dir.startsWith(base + "/"))
        throw new Error("Unsafe journal directory");
      const names = (
        await readdir(dir).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        })
      ).filter((n) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(n));
      if (names.length > 128) throw new Error("Journal count exceeds limit");
      const expected = new Set(validateGenerationInventory(inventory, names));
      for (const name of names) {
        if (stopped) break;
        const path = await confined(
          base,
          `journals/${name}/capture.ndjson`,
        ).catch((error) => {
          if (expected.has(name) && error.code === "ENOENT")
            throw new Error(
              `Retained journal capture missing: ${name}; restore the generation or export remaining history`,
            );
          throw error;
        });
        const metaPath = await confined(base, `journals/${name}/journal.json`);
        const j = await privateJSON(metaPath);
        if (
          j.version !== 2 ||
          j.journal_id !== name ||
          j.generation !== name ||
          j.capture !== "capture.ndjson" ||
          !Number.isSafeInteger(j.durable_bytes) ||
          j.durable_bytes < 0
        )
          throw new Error("Invalid journal publication");
        const fd = await open(path, "r");
        try {
          const stat = await fd.stat();
          if (!stat.isFile() || stat.size < j.durable_bytes)
            throw new Error("Capture publication exceeds file");
          await followJournal({
            collector,
            connection,
            key: name,
            generation: j.generation,
            durableBytes: j.durable_bytes,
            identity: `${identity}:${stat.dev}:${stat.ino}`,
            read: async (offset, count) => {
              const out = Buffer.alloc(count);
              const r = await fd.read(out, 0, count, offset);
              return out.subarray(0, r.bytesRead);
            },
          });
        } finally {
          await fd.close();
        }
      }
      const previous = recoverableErrors.get(connection.source_id);
      if (previous) {
        await collector.store.sourceReconciled(
          connection.source_token,
          previous,
        );
        recoverableErrors.delete(connection.source_id);
      }
    } catch (e) {
      if (activeConnection && e.status !== 507 && e.status !== 401)
        recoverableErrors.set(
          activeConnection.source_id,
          e.message.slice(0, 1024),
        );
      if (activeConnection)
        await collector.store
          .sourceStatus(
            activeConnection.source_id,
            e.status === 507
              ? "Storage full"
              : e.status === 401
                ? "Permission required"
                : e.message.includes("Another collector")
                  ? "Another collector selected"
                  : "Backlog retained",
            e.message.slice(0, 1024),
          )
          .catch(() => {});
      if (e.code !== "ENOENT")
        status("ios-simulator", {
          state: "waiting",
          reason: e.message,
        });
    }
  }
  async function tick() {
    try {
      const sims = Object.values(await simulatorDevices(cancellation.signal))
        .flat()
        .filter((s) => s.state === "Booted" && (!device || s.udid === device));
      status("ios-simulator", {
        state: recoverableErrors.size ? "waiting" : "ready",
        reason: recoverableErrors.values().next().value || `${sims.length} booted simulators`,
        devices: sims.map((s) => ({ udid: s.udid, name: s.name })),
      });
      const work = [];
      for (const sim of sims) {
        try {
          let c = cache.get(sim.udid);
          if (!c || Date.now() - c.at > 10000) {
            const apps = (
              await simulatorApps(sim.udid, cancellation.signal)
            ).filter((a) => !bundleID || bundleID === a);
            if (apps.length > 1000)
              throw new Error(
                `App candidate limit exceeded (${apps.length}); use --ios BUNDLE_ID to narrow discovery`,
              );
            c = { at: Date.now(), apps };
            cache.set(sim.udid, c);
          }
          status(`ios-simulator:${sim.udid}`, {
            state: "ready",
            reason: `${c.apps.length} installed app candidates`,
          });
          for (const app of c.apps) work.push(() => source(sim, app));
        } catch (error) {
          status(`ios-simulator:${sim.udid}`, {
            state: "waiting",
            reason: error.message,
          });
        }
      }
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, work.length) }, async () => {
          while (index < work.length && !stopped) await work[index++]();
        }),
      );
    } catch (e) {
      status("ios-simulator", {
        state: "unavailable",
        reason: `Tool unavailable or Xcode permission required: ${e.message}`,
      });
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          running = tick();
        }, interval);
    }
  }
  running = tick();
  return {
    async close() {
      stopped = true;
      cancellation.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
