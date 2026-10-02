import { execFileSync } from "node:child_process";

// Inspect only this process's bounded ancestry. `comm` excludes arguments,
// which may contain credentials. This is provenance, not a privacy-policy test.
export function launchContext() {
  const ancestry = [];
  const seen = new Set();
  let pid = process.pid;
  let incomplete = false;
  for (let depth = 0; depth < 8 && pid > 0; depth++) {
    if (seen.has(pid)) { incomplete = true; break; }
    seen.add(pid);
    try {
      const output = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "ppid=", "-o", "comm="], {
        encoding: "utf8", timeout: 1000, maxBuffer: 16384, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const match = /^(\d+)\s+([^\r\n]+)$/.exec(output);
      if (!match) { incomplete = true; break; }
      const parent = Number(match[1]);
      if (!Number.isSafeInteger(parent) || parent < 0) { incomplete = true; break; }
      ancestry.push({ pid, parent_pid: parent, executable: match[2] });
      pid = parent;
    } catch { incomplete = true; break; }
  }
  if (pid > 0) incomplete = true;
  return {
    ancestry,
    incomplete,
    apple_terminal_ancestor: ancestry.slice(1).some(entry => /\/Terminal\.app\/Contents\/MacOS\/Terminal$/.test(entry.executable)),
    scope: "Observed executable names of this process and up to seven ancestors; no arguments or unrelated process inventory. Ancestry does not establish macOS network-permission attribution.",
  };
}
