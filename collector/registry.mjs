import { open, mkdir, lstat, rename, unlink, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
export const activeManifestPath = () =>
  resolve(homedir(), ".http-sequence-logger/active.json");
export const registrationID = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function parsePrivateJSON(value) {
  const text = typeof value === "string"
    ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  try { return JSON.parse(text); }
  catch (error) {
    // V8 parser diagnostics may include credential-bearing input fragments.
    if (error instanceof SyntaxError) throw new SyntaxError("Invalid private JSON");
    throw error;
  }
}
export async function privateJSON(path, limit = 16384) {
  const s = await lstat(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.size > limit ||
    (process.getuid && s.uid !== process.getuid()) ||
    s.mode & 0o077
  )
    throw new Error("Unsafe private JSON file");
  const fd = await open(path, "r");
  try {
    const f = await fd.stat();
    if (f.ino !== s.ino || f.dev !== s.dev)
      throw new Error("Private file changed");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await fd.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("Private JSON exceeds limit");
    return parsePrivateJSON(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
  } finally {
    await fd.close();
  }
}
export async function atomicJSON(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tmp = resolve(parent, `.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = await open(tmp, "wx", 0o600);
    await fd.writeFile(JSON.stringify(value) + "\n");
    await fd.sync();
    await fd.close();
    fd = null;
    await rename(tmp, path);
    const dir = await open(parent, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await fd?.close();
    await unlink(tmp).catch(() => {});
  }
}
export async function confined(root, relative) {
  if (
    typeof relative !== "string" ||
    relative.length > 512 ||
    relative.startsWith("/") ||
    relative.split(/[\\/]/).some((x) => x === ".." || x === "")
  )
    throw new Error("Unsafe capture path");
  const resolved = await realpath(resolve(root, relative));
  const base = await realpath(root);
  if (!resolved.startsWith(base + sep))
    throw new Error("Capture escapes container");
  const s = await lstat(resolved);
  if (!s.isFile()) throw new Error("Capture is not regular");
  return resolved;
}
export async function publishManifest(collector, path = activeManifestPath()) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const ds = await lstat(dirname(path));
  if (
    ds.isSymbolicLink() ||
    (process.getuid && ds.uid !== process.getuid()) ||
    ds.mode & 0o077
  )
    throw new Error("Unsafe active manifest directory");
  let old;
  try {
    old = await privateJSON(path);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (old) {
    if (!Number.isInteger(old.pid) || old.pid < 1)
      throw new Error("Invalid manifest owner");
    try {
      process.kill(old.pid, 0);
      return {
        active: false,
        path,
        reason: "Another collector selected",
        close: async () => {},
      };
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  const instance_id = randomUUID();
  let stopped = false,
    timer,
    closePromise;
  const lockPath = path + ".owner";
  const lockValue = { pid: process.pid, instance_id };
  let inactiveReason = "Another collector selected";
  async function claim() {
    try {
      const fd = await open(lockPath, "wx", 0o600);
      try {
        await fd.writeFile(JSON.stringify(lockValue));
        await fd.sync();
      } finally {
        await fd.close();
      }
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let owner;
      try {
        owner = await privateJSON(lockPath);
      } catch (readError) {
        if (readError.code === "ENOENT") return claim();
        if (readError instanceof SyntaxError) {
          inactiveReason =
            "Active manifest owner is incomplete or invalid; retry or choose a fresh --manifest path";
          return false;
        }
        throw readError;
      }
      if (!Number.isInteger(owner.pid) || owner.pid < 1)
        throw new Error("Invalid manifest lock owner");
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
      }
      // Only one process may reclaim a dead owner. Re-read inside this gate:
      // another claimant may already have replaced the owner read above.
      const reclaimPath = lockPath + ".reclaim";
      let gate;
      try {
        gate = await open(reclaimPath, "wx", 0o600);
      } catch (gateError) {
        if (gateError.code !== "EEXIST") throw gateError;
        const reclaimer = await privateJSON(reclaimPath).catch((readError) => {
          if (readError instanceof SyntaxError || readError.code === "ENOENT")
            return null;
          throw readError;
        });
        if (!reclaimer) return false;
        if (!Number.isInteger(reclaimer.pid) || reclaimer.pid < 1)
          throw new Error("Invalid manifest reclamation owner");
        try {
          process.kill(reclaimer.pid, 0);
          return false;
        } catch (probe) {
          if (probe.code !== "ESRCH") throw probe;
          throw new Error(
            "Active manifest reclamation was interrupted; choose a fresh --manifest path",
          );
        }
      }
      try {
        await gate.writeFile(JSON.stringify(lockValue));
        await gate.sync();
        const current = await privateJSON(lockPath).catch((readError) => {
          if (readError.code === "ENOENT") return null;
          throw readError;
        });
        if (current) {
          if (!Number.isInteger(current.pid) || current.pid < 1)
            throw new Error("Invalid manifest lock owner");
          try {
            process.kill(current.pid, 0);
            return false;
          } catch (probe) {
            if (probe.code !== "ESRCH") throw probe;
          }
          await unlink(lockPath);
        }
        return await claim();
      } finally {
        await gate.close();
        await unlink(reclaimPath);
      }
    }
  }
  if (!(await claim()))
    return {
      active: false,
      path,
      reason: inactiveReason,
      close: async () => {},
    };
  let publication = Promise.resolve();
  function publish() {
    publication = publication
      .catch(() => {})
      .then(async () => {
        if (stopped) return;
        const ticket = await collector.store.ticket({
          principal: "local-relay",
          max_sources: 128,
        });
        if (stopped) return;
        const owner = await privateJSON(lockPath);
        if (owner.instance_id !== instance_id)
          throw new Error("Active manifest ownership changed");
        await atomicJSON(path, {
          version: 2,
          collector_id: collector.store.config.collector_id,
          instance_id,
          pid: process.pid,
          endpoint: collector.origin,
          ...ticket,
        });
      });
    return publication;
  }
  try {
    await publish();
  } catch (e) {
    try {
      const owner = await privateJSON(lockPath);
      if (owner.instance_id === instance_id) await unlink(lockPath);
    } catch {}
    throw e;
  }
  timer = setInterval(
    () => {
      if (!stopped) publish().catch(() => {});
    },
    5 * 60 * 1000,
  );
  timer.unref();
  return {
    active: true,
    path,
    instance_id,
    close() {
      return (closePromise ??= (async () => {
        stopped = true;
        clearInterval(timer);
        await publication.catch(() => {});
        for (const ownedPath of [path, lockPath]) {
          try {
            const current = await privateJSON(ownedPath);
            if (current.instance_id === instance_id) await unlink(ownedPath);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }
      })());
    },
  };
}
export function descriptor(value, platform, app) {
  if (
    !value ||
    value.version !== 2 ||
    value.platform !== platform ||
    value.app_id !== app ||
    typeof value.installation_id !== "string" ||
    value.installation_id.length > 256 ||
    !value.installation_id ||
    value.journal_directory !== "journals"
  )
    throw new Error("Invalid opt-in source descriptor");
  return value;
}

// The native installation budget already records all allocated generations.
// Consult it before enumeration can silently omit a deleted retained directory.
export function validateGenerationInventory(value, names) {
  if (value === undefined) return [];
  if (
    !value || value.version !== 2 ||
    !value.reservations || typeof value.reservations !== "object" ||
    Array.isArray(value.reservations)
  ) throw new Error("Invalid installation journal inventory");
  const entries = Object.entries(value.reservations);
  if (entries.length > 128) throw new Error("Journal inventory exceeds generation limit");
  const available = new Set(names);
  for (const [name, bytes] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) ||
        !Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("Invalid installation journal inventory");
    if (!available.has(name))
      throw new Error(`Retained journal generation missing: ${name}; restore the generation or export remaining history`);
  }
  return entries.map(([name]) => name);
}
