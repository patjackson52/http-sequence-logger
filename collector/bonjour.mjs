import { spawn } from "node:child_process";
/** Optional OS DNS-SD advertisement. TXT never carries enrollment or read credentials. */
export function advertiseCollector(
  collector,
  {
    enabled = false,
    name = "HTTP Sequence Logger",
    spawnProcess = spawn,
    shutdownMs = 1000,
  } = {},
) {
  if (!enabled) return { close: async () => {} };
  const connection = collector.connections.find((c) =>
    c.endpoint.startsWith("https:"),
  );
  if (!connection)
    throw new Error("Bonjour advertisement requires explicit LAN HTTPS mode");
  if (process.platform !== "darwin") {
    collector.setAdapterStatus("bonjour", {
      state: "unavailable",
      reason: "Tool unavailable: dns-sd advertisement requires macOS",
    });
    return { close: async () => {} };
  }
  const endpoint = new URL(connection.endpoint);
  const child = spawnProcess(
    "/usr/bin/dns-sd",
    [
      "-R",
      name,
      "_nlog._tcp",
      "local.",
      endpoint.port,
      "version=2",
      `collector_id=${connection.collector_id}`,
      `hostname=${endpoint.hostname}`,
    ],
    { stdio: "ignore" },
  );
  let stopped = false,
    finished = false;
  const closed = new Promise((ok) => {
    const complete = () => {
      finished = true;
      ok();
    };
    child.once("close", complete);
    child.on("error", () => {
      if (!child.pid) complete();
    });
  });
  child.on("error", (error) =>
    collector.setAdapterStatus("bonjour", {
      state: "unavailable",
      reason: error.message,
    }),
  );
  child.on("exit", (code) => {
    if (!stopped)
      collector.setAdapterStatus("bonjour", {
        state: "unavailable",
        reason: `Advertisement exited (${code})`,
      });
  });
  collector.setAdapterStatus("bonjour", {
    state: "ready",
    reason: "Advertising HTTPS collector candidates; pairing establishes trust",
  });
  return {
    async close() {
      stopped = true;
      if (finished) return;
      child.kill("SIGTERM");
      let timer;
      const stoppedInTime = await Promise.race([
        closed.then(() => true),
        new Promise((ok) => {
          timer = setTimeout(() => ok(false), shutdownMs);
        }),
      ]);
      clearTimeout(timer);
      if (!stoppedInTime) {
        child.kill("SIGKILL");
        await Promise.race([
          closed,
          new Promise((ok) => {
            timer = setTimeout(ok, shutdownMs);
          }),
        ]);
        clearTimeout(timer);
      }
    },
  };
}
