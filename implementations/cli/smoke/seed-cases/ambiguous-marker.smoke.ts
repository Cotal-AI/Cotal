import { boot, cotal, join, check, freshCfg, seedDir, writeJson, listNames, track, finishScenario, spawn, existsSync } from "./harness.js";
import { processStartToken } from "@cotal-ai/workspace";

try {
  const cfg = track(freshCfg());
  listNames(cfg);
  const marker = join(seedDir(cfg), "reconcile.child.json");
  const pending = (extra = {}) => {
    writeJson(join(seedDir(cfg), "reconcile.cursor.json"), { nonce: "orphan-smoke", package: "hermes", phase: "add" });
    writeJson(marker, { state: "pending", parentPid: 2147483646, nonce: "orphan-smoke", parentStart: processStartToken(process.pid), ts: 1, ...extra });
  };
  if (process.platform === "linux") {
    for (const args of [["ext", "seed", "--repair"], ["update"], ["sync"]]) {
      pending();
      const result = cotal(cfg, args);
      check(`dead parent: ${args.join(" ")} recovers`, result.status === 0 && /cleared an interrupted connector seed child marker/.test(result.stderr), result);
      check("stale marker removed", !existsSync(marker));
    }
    pending({ parentPid: process.pid, parentStart: String(BigInt(processStartToken(process.pid)!) - 1n) });
    const reused = boot(cfg);
    check("reused parent PID is not the recorded parent", reused.status === 0 && !existsSync(marker), reused);

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: { ...process.env, COTAL_EXT_SEEDING: "orphan-smoke" }, stdio: "ignore",
    });
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      pending();
      const live = cotal(cfg, ["ext", "seed", "--repair"]);
      check("dead parent with live pending child blocks", live.status !== 0 && /still installing/.test(live.stderr) && existsSync(marker), live);
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
    const ended = cotal(cfg, ["ext", "seed", "--repair"]);
    check("recovery proceeds after child exits", ended.status === 0 && !existsSync(marker), ended);
  }
  pending({ parentPid: process.pid, parentStart: processStartToken(process.pid) });
  const liveParent = boot(cfg);
  check("live parent still blocks", liveParent.status !== 0 && /still installing/.test(liveParent.stderr), liveParent);
  writeJson(marker, { state: "unknown" });
  const corrupt = boot(cfg);
  check("unprovable marker still refuses", corrupt.status !== 0 && /mid-flight/.test(corrupt.stderr), corrupt);
} finally {
  finishScenario();
}
