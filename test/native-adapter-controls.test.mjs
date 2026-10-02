import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
for (const platform of ["android", "ios"])
  for (const kind of ["missing", "arbitrary", "inventory", ...(platform === "android" ? ["route"] : [])])
    test(`${platform} ${kind} control preserves history and retains its diagnostic during native push`, async t => {
      const dir = await mkdtemp(tmpdir() + "/native-controls-");
      t.after(() => rm(dir, { recursive: true, force: true }));
      const { stdout } = await promisify(execFile)(process.execPath,
        [fileURLToPath(new URL("fixtures/native-adapter-process.mjs", import.meta.url)), dir, platform, kind],
        { timeout: 25000, maxBuffer: 65536 });
      const evidence = JSON.parse(stdout.trim());
      assert.equal(evidence.first_reconciliation_bound, true);
      assert.equal(evidence.clone_rejected_before_restart, true);
      assert.equal(evidence.preserved, true);
      assert.equal(evidence.checkpoint_recovered, true);
      assert.equal(evidence.diagnostic_survived_push, true);
    });
