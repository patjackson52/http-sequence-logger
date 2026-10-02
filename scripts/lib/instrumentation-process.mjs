import { spawn } from "node:child_process";

// Only the helper directly spawned by this acceptance harness is terminated.
// ADB servers and Gradle daemons remain outside this ownership boundary.
export function runOwnedProcess(command, args, {
  cwd, env, input, timeout = 120000, terminationGrace = 1000,
  outputLimit = 32 * 1024 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [], stderr = [];
    let bytes = 0, failure, closed = false, killTimer, closeTimer;
    const clearTimers = () => {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer);
    };
    const output = () => ({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    const stop = (error) => {
      if (closed || failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        closeTimer = setTimeout(() => {
          // Descendants can retain inherited pipes after the owned helper exits.
          // Closing our pipe ends lets close be observed without owning those descendants.
          child.stdin?.destroy(); child.stdout.destroy(); child.stderr.destroy();
          if (child.exitCode === null && child.signalCode === null) {
            clearTimers();
            reject(new AggregateError([failure, new Error("Owned helper did not exit after SIGKILL")],
              `${command} cleanup deadline exceeded`, { cause: failure }));
          }
        }, terminationGrace);
      }, terminationGrace);
    };
    const collect = (chunks, chunk) => {
      if (bytes + chunk.length > outputLimit) {
        stop(new Error(`${command} output exceeded ${outputLimit} bytes`));
        return;
      }
      bytes += chunk.length; chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    const timer = setTimeout(() => stop(new Error(`${command} timed out`)), timeout);
    child.once("error", stop);
    child.once("close", (code, signal) => {
      closed = true; clearTimers();
      const result = { code, signal, ...output() };
      if (failure) { Object.assign(failure, { exitCode: code, signal, ...output() }); reject(failure); }
      else resolve(result);
    });
    if (input !== undefined) {
      child.stdin.once("error", stop);
      child.stdin.end(input);
    }
  });
}

export async function finishOwnedCleanup(actions, primaryError) {
  const errors = [];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length) {
    const all = primaryError ? [primaryError, ...errors] : errors;
    throw new AggregateError(all,
      "Instrumentation cleanup failed: " + all.map((error) => error.message).join("; "),
      primaryError ? { cause: primaryError } : undefined);
  }
  if (primaryError) throw primaryError;
}
