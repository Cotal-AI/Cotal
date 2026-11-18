import assert from "node:assert/strict";
import { once } from "node:events";
import { BIN, HOST_ENV, check, cotal, existsSync, finishScenario, freshCfg, join, readJson, spawn, track } from "./harness.js";

try {
  if (process.platform !== "win32") {
    const cfg = track(freshCfg());
    const marker = join(cfg, "cotal", ".extensions.lock.npm-child");
    for (const signal of ["SIGKILL", "SIGTERM"] as const) {
      const child = spawn(process.execPath, [BIN, "ext", "seed", "--force"], {
        env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", bytes => { output += bytes; });
      child.stderr.on("data", bytes => { output += bytes; });
      const closed = once(child, "close");
      try {
        const deadline = Date.now() + 60_000;
        let npmPid: number | undefined;
        while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
          if (existsSync(marker)) {
            const record = readJson(marker) as { phase: string; pid?: number; intermediary?: boolean };
            if (record.phase === "live") {
              assert.equal(record.intermediary, false);
              npmPid = record.pid;
              break;
            }
          }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.ok(npmPid, `the seed publishes its real npm child: ${output}`);
        process.kill(npmPid, signal);
        assert.notEqual((await closed)[0], 0, "the interrupted seed still reports failure");
        assert.throws(() => process.kill(npmPid, 0), { code: "ESRCH" }, "npm was reaped before repair");
        assert.equal(existsSync(marker), false, "observed direct-child exit leaves no ambiguous marker");
        const repair = cotal(cfg, ["ext", "seed", "--repair"]);
        assert.equal(repair.status, 0, repair.stderr);
        assert.equal(existsSync(marker), false);
        check(`seed npm ${signal}: failed seed reported, child reaped, repair succeeded`, true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          // Only terminate the npm process journaled by this fixture's seed.
          if (existsSync(marker)) {
            const record = readJson(marker) as { phase: string; pid?: number };
            if (record.phase === "live" && record.pid) {
              try { process.kill(record.pid, "SIGKILL"); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            }
          }
          await closed;
        }
      }
    }
  }
} finally {
  finishScenario();
}
