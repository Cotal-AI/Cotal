import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { BIN, HOST_ENV, boot, bootArgs, cotal, join, check, freshCfg, seedDir, writeJson, listNames, track, finishScenario, spawn, existsSync, readFileSync, rmSync } from "./harness.js";
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
  for (const args of [["ext", "seed", "--repair"], ["update"], bootArgs]) {
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
    const remove = cotal(cfg, ["ext", "remove", "@cotal-ai/web"], { COTAL_SKIP_CONNECTOR_SEED: "1" });
    check("ext remove refuses the live child under the prefix writer lock",
      remove.status !== 0 && /still installing/.test(remove.stderr) && existsSync(marker), remove);
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
  const skip = { COTAL_SKIP_CONNECTOR_SEED: "1" };
  const ambiguousRemove = cotal(cfg, ["ext", "remove", "@cotal-ai/web"], skip);
  check("ext remove with seed skipped still refuses ambiguous child custody",
    ambiguousRemove.status === 1 && /mid-flight/.test(ambiguousRemove.stderr) && existsSync(marker), ambiguousRemove);
  rmSync(marker);
  const cursor = join(seedDir(cfg), "reconcile.cursor.json");
  const recovery = join(seedDir(cfg), "reconcile.recovery.json");
  const savedCursor = readFileSync(cursor, "utf8");
  const interruptedRemove = cotal(cfg, ["ext", "remove", "@cotal-ai/connector-codex"], skip);
  check("ext remove with seed skipped keeps main's removal behavior with a stopped interruption",
    interruptedRemove.status === 0 && interruptedRemove.stdout.includes("removed @cotal-ai/connector-codex") && readFileSync(cursor, "utf8") === savedCursor, interruptedRemove);
  rmSync(cursor);
  writeJson(recovery, { repairAllSeeded: true });
  const savedRecovery = readFileSync(recovery, "utf8");
  const recoveryRemove = cotal(cfg, ["ext", "remove", "@cotal-ai/pi"], skip);
  check("ext remove with seed skipped keeps main's removal behavior with a recovery journal",
    recoveryRemove.status === 0 && recoveryRemove.stdout.includes("removed @cotal-ai/pi") && readFileSync(recovery, "utf8") === savedRecovery, recoveryRemove);

  if (process.platform !== "win32") for (const args of [["ext", "seed"], ["ext", "seed", "--repair"]]) {
    const cfg = track(freshCfg());
    const invocation = args.join(" ");
    const command = spawn(process.execPath, [BIN, ...args], {
      env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1", DO_NOT_TRACK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", signalled = false;
    command.stdout.on("data", chunk => { stdout += chunk; });
    command.stderr.on("data", chunk => {
      stderr += chunk;
      if (!signalled && stderr.includes("seed store payload (claude)")) signalled = command.kill("SIGTERM");
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      command.once("error", reject);
      command.once("close", resolve);
    });
    check(`SIGTERM to ${invocation} exits 143 before starting a second install`, signalled && status === 143 &&
      stderr.includes("Reconciling built-in claude@") && !stderr.includes("Reconciling built-in opencode@") &&
      stderr.includes(`Connector seed interrupted. Run \`cotal ${invocation}\` to finish seeding.`) &&
      !stdout.includes("connectors reconciled") && !existsSync(join(seedDir(cfg), "stamp.json")), { status, stdout, stderr });
    const retry = cotal(cfg, args);
    check(`retry completes a cancelled ${invocation}`, retry.status === 0 && retry.stderr.includes("Reconciling built-in opencode@") &&
      retry.stdout.includes("connectors reconciled"), retry);
  }

  if (process.platform === "linux") for (const signal of ["SIGKILL", "SIGTERM"] as const) {
    const cfg = track(freshCfg());
    const npmMarker = join(cfg, "cotal", ".extensions.lock.npm-child");
    const command = spawn(process.execPath, [BIN, "ext", "seed", "--force"], {
      env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" }, stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    command.stderr?.on("data", chunk => { output += chunk; });
    const closed = new Promise<number | null>((resolve, reject) => {
      command.once("error", reject);
      command.once("close", resolve);
    });
    const read = (path: string) => {
      try { return readFileSync(path, "utf8"); }
      catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return ""; throw error; }
    };
    let npmPid: number | undefined;
    try {
      for (let deadline = Date.now() + 60_000; Date.now() < deadline && command.exitCode === null && command.signalCode === null; await sleep(5)) {
        const row = JSON.parse(read(npmMarker) || "null");
        const seed = JSON.parse(read(join(seedDir(cfg), "reconcile.child.json")) || "null");
        if (row?.phase !== "live" || seed?.parentPid !== command.pid || seed?.childPid !== row.owner) continue;
        if (!/npm.*install|\0install\0/.test(read(`/proc/${row.pid}/cmdline`))) continue;
        process.kill(row.pid, signal);
        npmPid = row.pid;
        break;
      }
      assert.ok(npmPid, `seed did not start its real npm child: ${output}`);
      check(`${signal}: interrupted seed fails without asking to remove a marker`, await closed === 1 && !/remove the marker/.test(output), output);
      assert.throws(() => process.kill(npmPid!, 0), { code: "ESRCH" });
      check(`${signal}: dead direct npm group leaves no marker`, !existsSync(npmMarker));
      const repaired = cotal(cfg, ["ext", "seed", "--repair"]);
      check(`${signal}: repair succeeds without manual marker removal`, repaired.status === 0, repaired);
    } finally {
      if (command.exitCode === null && command.signalCode === null) command.kill("SIGTERM");
      await closed;
    }
  }
} finally {
  if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfig;
  finishScenario();
}
