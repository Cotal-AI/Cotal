import { boot, cotal, join, check, freshCfg, seedDir, writeJson, listNames, track, finishScenario, spawn, existsSync } from "./harness.js";
import { acquireReconcileLock, markSeedChildLive, seedChildStatus, clearChildMarker, writePendingChildMarker } from "../../src/seed/lock.js";
import { processStartToken } from "@cotal-ai/workspace";
import { randomBytes } from "node:crypto";

const previousConfig = process.env.XDG_CONFIG_HOME;
try {
  const cfg = track(freshCfg());
  listNames(cfg);
  process.env.XDG_CONFIG_HOME = cfg;
  const nonce = randomBytes(12).toString("hex");
  const marker = join(seedDir(cfg), "reconcile.child.json");
  const pending = (extra = {}) => {
    writeJson(join(seedDir(cfg), "reconcile.cursor.json"), { nonce, package: "hermes", phase: "add" });
    writeJson(marker, { state: "pending", parentPid: 2147483646, nonce, ts: 1, ...extra });
  };
  for (const args of [["ext", "seed", "--repair"], ["update"], ["config", "unset", "color", "--user"]]) {
    pending();
    const result = cotal(cfg, args);
    check(`released marker: ${args.join(" ")} recovers`, result.status === 0 && /cleared an interrupted connector seed child marker/.test(result.stderr), result);
    check("stale marker removed", !existsSync(marker));
  }
  pending({ parentPid: process.pid });
  const reused = boot(cfg);
  check("live reused PID without matching lock is not the parent", reused.status === 0 && !existsSync(marker), reused);

  const lock = acquireReconcileLock();
  try {
    writePendingChildMarker(lock.nonce);
    check("pending under matching active lock blocks", seedChildStatus().kind === "live");
    clearChildMarker();
    let refused = false;
    try { markSeedChildLive(lock.nonce, process.pid); } catch { refused = true; }
    check("child refuses publication after pending marker clears", refused && !existsSync(marker));
  } finally { lock.release(); }

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    pending();
    writeJson(marker, { state: "live", parentPid: 2147483646, nonce, ts: 1, childPid: child.pid, childStart: processStartToken(child.pid!) });
    const live = cotal(cfg, ["ext", "seed", "--repair"]);
    check("live child with dead parent blocks", live.status !== 0 && /still installing/.test(live.stderr) && existsSync(marker), live);
  } finally {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await exited;
  }
  const ended = cotal(cfg, ["ext", "seed", "--repair"]);
  check("recovery proceeds after live child exits", ended.status === 0, ended);
  pending({ ts: Date.now() });
  const started = Date.now();
  check("recent pending marker waits through publication grace", seedChildStatus().kind === "stale" && Date.now() - started >= 9900);
  writeJson(marker, { state: "unknown" });
  const corrupt = boot(cfg);
  check("unprovable marker still refuses", corrupt.status !== 0 && /mid-flight/.test(corrupt.stderr), corrupt);
} finally {
  if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfig;
  finishScenario();
}
