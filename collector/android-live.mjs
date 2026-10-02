import { execFile as callback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  descriptor,
  registrationID,
  validateGenerationInventory,
  parsePrivateJSON,
} from "./registry.mjs";
import { followJournal } from "./follower.mjs";
const execute = promisify(callback);
export const SAMPLE_PACKAGE = "dev.networklog.sample"; // sample installer only; never discovery default
const validPackage = (value) =>
  typeof value === "string" &&
  value.length <= 255 &&
  /^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(value);
// One remote command checks a bounded group. Every scan probes again, so an
// existing app initializing its descriptor needs no package-cache invalidation.
export function androidDescriptorProbeCommand(packages) {
  if (
    !packages.length ||
    packages.length > 32 ||
    packages.some((p) => !validPackage(p))
  )
    throw new Error("Invalid Android descriptor probe candidates");
  const path = "no_backup/HTTPSequenceLogger/source.json";
  const test = `test ! -L no_backup && test ! -L no_backup/HTTPSequenceLogger && test ! -L ${path} && if [ ! -e ${path} ]; then printf N; else printf P; fi`;
  const command =
    "printf D; " +
    packages
      .map((pkg) =>
        `r=$(run-as ${pkg} --user 0 sh -c '${test}' 2>&1 | head -c 513); case \"$r\" in N|'run-as:'*'not debuggable'*|'run-as:'*'unknown package'*|'run-as:'*'package not an application'*) ;; *) printf '${pkg}\\n' ;; esac`,
      )
      .join("; ");
  if (Buffer.byteLength(command) > 32768)
    throw new Error("Android descriptor probe command exceeds limit");
  return command;
}
export function decodeAndroidDescriptorCandidates(raw, packages) {
  if (raw.length > 16384 || raw[0] !== 68)
    throw new Error("Invalid Android descriptor probe result");
  const names = new TextDecoder("utf-8", { fatal: true })
    .decode(raw.subarray(1))
    .split(/\r?\n/)
    .filter(Boolean);
  const candidates = new Set(packages);
  if (
    names.length > packages.length ||
    new Set(names).size !== names.length ||
    names.some((p) => !validPackage(p) || !candidates.has(p))
  )
    throw new Error("Invalid Android descriptor probe result");
  return names;
}
// exec-out can report host success even when the remote shell fails. The marker
// distinguishes an absent control file from an existing empty/unsafe file.
export function decodeAndroidControl(raw) {
  if (raw.length === 1 && raw[0] === 78) return null;
  if (raw[0] !== 70) {
    const message = raw.toString("utf8");
    if (/^run-as:/i.test(message)) throw new Error(message.trim());
    throw new Error("Unsafe or unavailable private file");
  }
  const value = raw.subarray(1);
  if (value.length > 16384)
    throw new Error("Private control file exceeds limit");
  new TextDecoder("utf-8", { fatal: true }).decode(value);
  return value;
}
export function decodeAndroidJournalNames(raw) {
  if (raw.length === 1 && raw[0] === 78) return [];
  if (raw[0] !== 68) throw new Error("Unsafe or unavailable journal directory");
  const names = new TextDecoder("utf-8", { fatal: true })
    .decode(raw.subarray(1))
    .split(/\r?\n/)
    .filter(Boolean);
  if (names.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)))
    throw new Error("Invalid journal directory listing");
  if (names.length > 128)
    throw new Error(
      "Journal count limit exceeded; generations retained, collection paused",
    );
  return names;
}
export function adbPath(explicit) {
  if (explicit) return explicit;
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
    join(homedir(), "Android/Sdk"),
  ].filter(Boolean);
  return (
    roots.map((r) => join(r, "platform-tools", "adb")).find(existsSync) || "adb"
  );
}
export function parseDevices(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized)\b(.*)$/);
    return m
      ? [
          {
            serial: m[1],
            state: m[2],
            emulator: m[1].startsWith("emulator-"),
            label: (m[3].match(/\bmodel:(\S+)/)?.[1] || m[1]).replaceAll(
              "_",
              " ",
            ),
          },
        ]
      : [];
  });
}
export async function connectedDevices(adb = adbPath(), signal) {
  return parseDevices(
    (
      await execute(adb, ["devices", "-l"], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        signal,
      })
    ).stdout,
  );
}
export function selectDevice(devices, serial) {
  const candidates = devices.filter(
    (d) => d.state === "device" && (!serial || d.serial === serial),
  );
  if (candidates.length !== 1)
    throw new Error("Choose one explicit device for sample installation");
  return candidates[0];
}
export async function watchAndroid({
  collector,
  packageName,
  device,
  adb = adbPath(),
  interval = 1000,
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
  const invoke = (serial, args, maxBuffer = 1024 * 1024) =>
    execute(adb, ["-s", serial, ...args], {
      timeout: 10000,
      maxBuffer,
      encoding: "buffer",
      signal: cancellation.signal,
    });
  const guard = (path) => {
    if (
      !/^no_backup\/HTTPSequenceLogger\/[a-zA-Z0-9._\/-]+$/.test(path) ||
      path.includes("..")
    )
      throw new Error("Unsafe Android path");
    const parts = path.split("/");
    return parts
      .map((_, i) => `test ! -L ${parts.slice(0, i + 1).join("/")}`)
      .join(" && ");
  };
  const read = async (serial, pkg, path) => {
    const raw = (
      await invoke(serial, [
        "exec-out",
        "run-as",
        pkg,
        "--user",
        "0",
        "sh",
        "-c",
        `${guard(path)} && if [ ! -e ${path} ]; then printf N; elif [ ! -f ${path} ]; then printf U; else printf F; head -c 16385 ${path}; fi`,
      ])
    ).stdout;
    return decodeAndroidControl(raw);
  };
  async function pairingFile(serial, pkg, name) {
    const raw = await read(serial, pkg, `no_backup/HTTPSequenceLogger/${name}`);
    if (!raw) return null;
    if (raw.length > 16384) throw new Error("Pairing exceeds limit");
    return parsePrivateJSON(raw);
  }
  async function selectedPairing(serial, pkg) {
    const manual = await pairingFile(serial, pkg, "pairing.json");
    return {
      manual,
      selected:
        manual || (await pairingFile(serial, pkg, "pairing-local.json")),
    };
  }
  async function pair(serial, pkg, connection) {
    const port = new URL(connection.endpoint).port;
    const routes = (
      await invoke(serial, ["reverse", "--list"])
    ).stdout.toString();
    const route = `tcp:${port}`;
    if (
      !routes
        .split(/\r?\n/)
        .some(
          (line) =>
            line.trim().split(/\s+/).slice(-2).join(" ") ===
            `${route} ${route}`,
        )
    )
      await invoke(serial, ["reverse", "--no-rebind", route, route]);
    const saved = await pairingFile(serial, pkg, "pairing-local.json");
    if (
      saved?.source_id === connection.source_id &&
      saved?.source_token === connection.source_token &&
      saved?.endpoint === connection.endpoint &&
      saved?.certificate_sha256 === connection.certificate_sha256
    )
      return;
    await new Promise((ok, fail) => {
      const child = spawn(
        adb,
        [
          "-s",
          serial,
          "shell",
          "run-as",
          pkg,
          "--user",
          "0",
          "sh",
          "-c",
          "'umask 077; cat > no_backup/HTTPSequenceLogger/pairing-local.tmp && sync && mv no_backup/HTTPSequenceLogger/pairing-local.tmp no_backup/HTTPSequenceLogger/pairing-local.json && sync'",
        ],
        { stdio: ["pipe", "ignore", "pipe"], signal: cancellation.signal },
      );
      const timeout = setTimeout(() => {
        child.kill();
        fail(new Error("Pairing command timed out"));
      }, 10000);
      child.on("error", fail);
      child.on("exit", (code) => {
        clearTimeout(timeout);
        code === 0 ? ok() : fail(new Error("Pairing write failed"));
      });
      child.stdin.end(JSON.stringify(connection));
    });
  }
  async function source(d, pkg) {
    let activeConnection;
    try {
      const raw = await read(
        d.serial,
        pkg,
        "no_backup/HTTPSequenceLogger/source.json",
      ).catch((e) => {
        if (
          /not debuggable|unknown package|package not an application/i.test(
            e.message,
          )
        )
          return null;
        throw e;
      });
      if (!raw || /^run-as:/i.test(raw.toString("utf8"))) return;
      if (raw.length > 16384) throw new Error("Descriptor exceeds limit");
      const md = descriptor(parsePrivateJSON(raw), "android", pkg);
      const key = `${d.serial}:${pkg}:${md.installation_id}`;
      const { manual, selected } = await selectedPairing(d.serial, pkg);
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
        platform: "android",
        environment_id: `adb:${d.serial}:user:0`,
        environment_name: d.label,
        app_id: pkg,
        installation_id: md.installation_id,
        instance_id: md.instance_id,
        registration_id: registrationID([d.serial, pkg, md.installation_id]),
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
          `adb:${d.serial}:${pkg}`,
          {
            platform: "android",
            app_id: pkg,
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
      await pair(d.serial, pkg, connection);
      const budget = await read(
        d.serial,
        pkg,
        "no_backup/HTTPSequenceLogger/journal-budget.json",
      );
      const names = decodeAndroidJournalNames(
        (
          await invoke(d.serial, [
            "exec-out",
            "run-as",
            pkg,
            "--user",
            "0",
            "sh",
            "-c",
            `${guard("no_backup/HTTPSequenceLogger/journals")} && if [ ! -e no_backup/HTTPSequenceLogger/journals ]; then printf N; elif [ ! -d no_backup/HTTPSequenceLogger/journals ]; then printf U; else printf D; ls -1 no_backup/HTTPSequenceLogger/journals; fi`,
          ])
        ).stdout,
      );
      const expected = new Set(
        validateGenerationInventory(
          budget ? parsePrivateJSON(budget) : undefined,
          names,
        ),
      );
      for (const name of names) {
        if (stopped) break;
        const root = `no_backup/HTTPSequenceLogger/journals/${name}`;
        const raw = await read(d.serial, pkg, `${root}/journal.json`);
        if (!raw) throw new Error("Journal metadata not yet published");
        if (raw.length > 16384)
          throw new Error("Journal metadata exceeds limit");
        const j = parsePrivateJSON(raw);
        if (
          j.version !== 2 ||
          j.journal_id !== name ||
          j.generation !== name ||
          j.capture !== "capture.ndjson" ||
          !Number.isSafeInteger(j.durable_bytes) ||
          j.durable_bytes < 0
        )
          throw new Error("Invalid journal publication");
        const stat = (
          await invoke(d.serial, [
            "exec-out",
            "run-as",
            pkg,
            "--user",
            "0",
            "sh",
            "-c",
            `${guard(root + "/capture.ndjson")} && stat -c %d:%i:%s ${root}/capture.ndjson`,
          ])
        ).stdout
          .toString()
          .trim();
        if (!/^\d+:\d+:\d+$/.test(stat))
          throw new Error(
            expected.has(name)
              ? `Retained journal capture missing or unsafe: ${name}; restore the generation or export remaining history`
              : "Invalid journal file identity",
          );
        if (Number(stat.split(":")[2]) < j.durable_bytes)
          throw new Error("Capture publication exceeds file");
        await followJournal({
          collector,
          connection,
          key: name,
          generation: j.generation,
          durableBytes: j.durable_bytes,
          identity: `${md.installation_id}:${stat.split(":").slice(0, 2).join(":")}`,
          read: async (offset, count) => {
            const command = `${guard(root + "/capture.ndjson")} && tail -c +${offset + 1} ${root}/capture.ndjson | head -c ${count}`;
            return (
              await invoke(d.serial, [
                "exec-out",
                "run-as",
                pkg,
                "--user",
                "0",
                "sh",
                "-c",
                command,
              ])
            ).stdout;
          },
        });
      }
      const previous = recoverableErrors.get(connection.source_id);
      if (previous) {
        await collector.store.sourceReconciled(
          connection.source_token,
          previous,
        );
        recoverableErrors.delete(connection.source_id);
      }
    } catch (error) {
      if (activeConnection && error.status !== 507 && error.status !== 401)
        recoverableErrors.set(
          activeConnection.source_id,
          error.message.slice(0, 1024),
        );
      if (activeConnection)
        await collector.store
          .sourceStatus(
            activeConnection.source_id,
            error.status === 507
              ? "Storage full"
              : error.status === 401
                ? "Permission required"
                : error.message.includes("Another collector")
                  ? "Another collector selected"
                  : "Backlog retained",
            error.message.slice(0, 1024),
          )
          .catch(() => {});
      if (
        !/not debuggable|No such file|unknown package|package not found|package not an application/i.test(
          error.message,
        )
      )
        status("android", {
          state: "waiting",
          reason: error.message,
        });
    }
  }
  async function tick() {
    try {
      const devices = (await connectedDevices(adb, cancellation.signal)).filter(
        (d) => !device || d.serial === device,
      );
      const authorized = devices.filter((d) => d.state === "device");
      status("android", {
        state: authorized.length && !recoverableErrors.size ? "ready" : "waiting",
        reason: recoverableErrors.values().next().value || (devices.some((d) => d.state === "unauthorized")
          ? "Permission required"
          : `${authorized.length} authorized devices`),
        devices,
      });
      let work = [];
      for (const d of authorized) {
        try {
          let c = cache.get(d.serial);
          if (!c || Date.now() - c.at > 10000) {
            const text = (
              await invoke(d.serial, [
                "shell",
                "cmd",
                "package",
                "list",
                "packages",
                "--user",
                "0",
              ])
            ).stdout.toString();
            const packages = text
              .split(/\r?\n/)
              .map((x) => x.replace(/^package:/, "").trim())
              .filter(
                (x) =>
                  validPackage(x) &&
                  (!packageName || x === packageName),
              );
            if (packages.length > 1000)
              throw new Error(
                `Package candidate limit exceeded (${packages.length}); use --android PACKAGE to narrow discovery`,
              );
            c = { at: Date.now(), packages };
            cache.set(d.serial, c);
          }
          status(`android:${d.serial}`, {
            state: "ready",
            reason: `${c.packages.length} package candidates for Android user 0`,
          });
          for (let offset = 0; offset < c.packages.length; offset += 32) {
            const batch = c.packages.slice(offset, offset + 32);
            work.push(async () => {
              try {
                const raw = (
                  await invoke(
                    d.serial,
                    ["exec-out", "sh", "-c", androidDescriptorProbeCommand(batch)],
                    16385,
                  )
                ).stdout;
                for (const pkg of decodeAndroidDescriptorCandidates(raw, batch)) {
                  if (stopped) break;
                  await source(d, pkg);
                }
              } catch (error) {
                status(`android:${d.serial}`, {
                  state: "waiting",
                  reason: error.message,
                });
              }
            });
          }
        } catch (error) {
          status(`android:${d.serial}`, {
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
    } catch (error) {
      status("android", {
        state: error.code === "ENOENT" ? "unavailable" : "waiting",
        reason:
          error.code === "ENOENT"
            ? "Tool unavailable: Android platform-tools"
            : error.message,
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
