import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { BIN, HOST_ENV, cotal, freshCfg, track, check, finishScenario, spawn, existsSync, readFileSync, join, dirname } from "./harness.js";

try {
  const cfg = track(freshCfg());
  const seeded = cotal(cfg, ["ext", "seed"]);
  assert.equal(seeded.status, 0, seeded.stderr);
  check("npm signal control: initial seed succeeds", seeded.status === 0);
  const root = cotal(cfg, ["ext", "root"]);
  assert.equal(root.status, 0, root.stderr);
  const config = dirname(root.stdout.trim());
  const path = join(config, ".extensions.lock.npm-child");
  check("npm signal control: successful seed clears its marker", !existsSync(path));

  for (const signal of ["SIGKILL", "SIGTERM"] as const) {
    const child = spawn(process.execPath, [BIN, "ext", "seed", "--force"], {
      env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", status => resolve(status));
    });
    try {
      let marker: { phase: string; pid: number; owner: number; intermediary: boolean } | undefined;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        if (existsSync(path)) {
          const current = JSON.parse(readFileSync(path, "utf8")) as typeof marker;
          if (current?.phase === "live") { marker = current; break; }
        }
        await sleep(5);
      }
      assert.ok(marker, `seed must reach its real npm child: ${output}`);
      const seedChild = JSON.parse(readFileSync(join(config, "seed", "reconcile.child.json"), "utf8")) as { childPid: number; parentPid: number };
      assert.equal(seedChild.parentPid, child.pid, "only interrupt the npm child of this seed");
      assert.equal(marker.owner, seedChild.childPid);
      assert.equal(marker.intermediary, false, "POSIX spawns npm directly");
      process.kill(marker.pid, signal);
      check(`${signal}: interrupted seed fails`, await closed !== 0, output);
      assert.throws(() => process.kill(marker.pid, 0), { code: "ESRCH" });
      check(`${signal}: npm marker is released after close`, !existsSync(path));
      const repaired = cotal(cfg, ["ext", "seed", "--repair"]);
      check(`${signal}: repair succeeds without manual marker removal`, repaired.status === 0, repaired.stderr);
      const inventory = cotal(cfg, ["ext", "list"]);
      check(`${signal}: repaired inventory has every connector`, inventory.status === 0 &&
        ["claude", "opencode", "codex", "hermes", "jcode", "pi"].every(name => inventory.stdout.includes(`connector:${name}`)), inventory);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    }
  }
} finally {
  finishScenario();
}
