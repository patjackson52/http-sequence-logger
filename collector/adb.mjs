import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
const execFile = promisify(execFileCallback);
export class LineFollower {
  constructor() {
    this.previousLength = 0;
    this.prefixDigest = digest(Buffer.alloc(0));
    this.offset = 0;
  }
  read(buffer) {
    if (
      buffer.length < this.previousLength ||
      digest(buffer.subarray(0, this.previousLength)) !== this.prefixDigest
    )
      this.offset = 0;
    this.previousLength = buffer.length;
    this.prefixDigest = digest(buffer);
    const end = buffer.lastIndexOf(10) + 1;
    if (end <= this.offset) return "";
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(this.offset, end),
    );
    this.offset = end;
    return text;
  }
}
export function androidBridge({
  packageName,
  device,
  adb = "adb",
  run = execFile,
}) {
  if (!/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(packageName))
    throw new Error("Invalid Android application ID");
  if (!device || /[\r\n\0]/.test(device))
    throw new Error("Choose an explicit ADB device serial with --device");
  const invoke = (args, options = {}) =>
    run(adb, ["-s", device, ...args], {
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "buffer",
      ...options,
    });
  const followers = new Map();
  return {
    async pair(connection) {
      const port = new URL(connection.endpoint).port;
      await invoke(["reverse", `tcp:${port}`, `tcp:${port}`]);
      // Controlled shell program; connection JSON travels through stdin, never shell interpolation.
      await new Promise((ok, fail) => {
        const child = execFileCallback(
          adb,
          [
            "-s",
            device,
            "shell",
            "run-as",
            packageName,
            "sh",
            "-c",
            "'umask 077; mkdir -p files/network-log; cat > files/network-log/connection.json'",
          ],
          { timeout: 10000 },
          (error) => (error ? fail(error) : ok()),
        );
        child.stdin.end(JSON.stringify(connection));
      });
    },
    async poll(ingest) {
      const { stdout } = await invoke([
        "exec-out",
        "run-as",
        packageName,
        "ls",
        "files/captures",
      ]);
      const names = stdout
        .toString("utf8")
        .split(/\r?\n/)
        .filter((x) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ndjson$/.test(x));
      if (names.length > 1000)
        throw new Error(
          "Too many capture files; export or remove old app captures",
        );
      for (const name of followers.keys())
        if (!names.includes(name)) followers.delete(name);
      for (const name of names) {
        const result = await invoke([
          "exec-out",
          "run-as",
          packageName,
          "cat",
          `files/captures/${name}`,
        ]);
        let follower = followers.get(name);
        if (!follower) {
          follower = new LineFollower();
          followers.set(name, follower);
        }
        const before = {
          previousLength: follower.previousLength,
          prefixDigest: follower.prefixDigest,
          offset: follower.offset,
        };
        const text = follower.read(result.stdout);
        if (!text) continue;
        try {
          let batch = "",
            count = 0;
          for (const line of text.split("\n").filter(Boolean)) {
            if (
              batch &&
              (Buffer.byteLength(batch) + Buffer.byteLength(line) + 1 >
                1024 * 1024 ||
                count === 500)
            ) {
              ingest(batch);
              batch = "";
              count = 0;
            }
            batch += line + "\n";
            count++;
          }
          if (batch) ingest(batch);
        } catch (error) {
          Object.assign(follower, before);
          throw error;
        }
      }
    },
  };
}
