/** Uninstall observes the shipped daemon's death, not only its supervisor's acknowledgement. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock } from "@cotal-ai/core";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths, type DaemonPaths } from "../daemon/endpoint.js";
import { managerViaDaemon, openVerified, queryDaemon } from "../daemon/client.js";
import { requestInstalledDaemon } from "../daemon/install.js";
import { excludeLifetime, holdLifetime } from "../daemon/lifetime.js";
import { waitForInstalledDaemonGeneration } from "../daemon/update-generation.js";

if (process.platform !== "linux") skipSuite("owned uninstall: recording Linux supervisor required");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = join(repo, "bin/dist/cotal.js");
const barrierRoot = mkdtempSync(join(tmpdir(), "dou-lock-"));
const barrierPath = join(barrierRoot, "daemon.lock");
const holder = holdLifetime(barrierPath);
const original = readFileSync(barrierPath, "utf8");
assert.throws(() => excludeLifetime(barrierPath), { code: "LOCK_HELD" });
assert.equal(readFileSync(barrierPath, "utf8"), original, "refused exclusion preserves live identity record");
holder.release();
const before = readFileSync(barrierPath, "utf8");
const exclusion = excludeLifetime(barrierPath);
try {
  assert.throws(() => holdLifetime(barrierPath), { code: "LOCK_HELD" });
  assert.equal(readFileSync(barrierPath, "utf8"), before, "exclusion never writes a holder record");
} finally { exclusion.release(); }
console.log("PASS native lifetime exclusion blocks starters and preserves records");

async function checkRepairLock(paths: DaemonPaths, pid: number, env: NodeJS.ProcessEnv) {
  const path = join(paths.state, "service-repair.lock");
  const stop = async (commit = false) => {
    const socket = await openVerified({ paths });
    try { return await requestInstalledDaemon(socket, "daemon-stop", commit); }
    finally { socket.destroy(); }
  };
  const own = acquireLock(path);
  try { assert.equal((await stop()).pid, pid, "the lock owner's stop is prepared but not committed"); }
  finally { own.release(); }

  const advisory = pathToFileURL(join(repo, "packages/core/dist/advisory-lock.js")).href;
  const repair = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireLock } from ${JSON.stringify(advisory)};
    const held = acquireLock(process.argv[1]);
    process.stdin.resume();
    process.stdin.once('end', () => held.release());
  `, path], { env, stdio: ["pipe", "ignore", "inherit"] });
  const exited = new Promise<number | null>(resolve => repair.once("close", resolve));
  try {
    for (let i = 0; !existsSync(path); i++) {
      assert.ok(i < 200 && repair.exitCode === null, "a different process acquired the repair lock");
      await delay(25);
    }
    const record = readFileSync(path, "utf8");
    assert.equal(JSON.parse(record).pid, repair.pid);
    assert.ok(!existsSync(join(paths.state, "service-repair.json")));
    assert.ok(!existsSync(join(paths.state, "service-policy-repair.json")));
    await assert.rejects(stop(), /provenance is still unknown/);
    await assert.rejects(stop(true), /no verified native launch provenance/);
    console.log("PASS a different repair lock owner prevents stop and the daemon does not cache the owner's earlier approval");

    await managerViaDaemon({ paths }, { op: "managers-prepare-restart" });
    try {
      const ready = await queryDaemon({ paths });
      assert.ok(ready.ok && ready.result.update?.restartEvidence?.prepared);
      const { COTAL_HOME, XDG_RUNTIME_DIR } = process.env;
      process.env.COTAL_HOME = env.COTAL_HOME!;
      process.env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR!;
      try {
        // The installed-service preflight has already passed; exercise the actual activation wait and stop handshake.
        await assert.rejects(waitForInstalledDaemonGeneration("0.0.0-update", {
          installed: () => true, restartPrepared: true, timeoutMs: 10_000, quiet: true,
        }), /pinned daemon refused daemon-stop: DEPENDENCY_UNAVAILABLE: .*provenance is still unknown/);
      } finally {
        if (COTAL_HOME === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = COTAL_HOME;
        if (XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = XDG_RUNTIME_DIR;
      }
      const after = await queryDaemon({ paths });
      assert.ok(after.ok && after.result.pid === pid && after.result.update?.restartEvidence?.prepared);
      assert.equal(readFileSync(path, "utf8"), record, "neither stop caller changed the repair lock");
      console.log("PASS prepared update activation refuses a foreign repair lock and leaves the original daemon answering");
    } finally { await managerViaDaemon({ paths }, { op: "managers-abort-restart" }); }
  } finally {
    repair.stdin.end();
    assert.equal(await exited, 0);
  }
}

type Mode = "owned" | "native-stop" | "stopped" | "foreground" | "changed-source" | "foreign-receipt" | "native-refusal";
for (const mode of ["owned", "native-stop", "stopped", "foreground", "changed-source", "foreign-receipt", "native-refusal"] as const satisfies readonly Mode[]) {
  const root = mkdtempSync(join(tmpdir(), "dou-"));
  const home = join(root, "home"), config = join(root, "config"), rt = join(root, "rt"), native = join(root, "native");
  for (const path of [home, config, rt, native]) mkdirSync(path, { mode: 0o700 });
  const effects = join(root, "effects");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: rt, PATH: `${native}:${process.env.PATH}`, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
  const paths = daemonPaths(env, home);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const unitPath = join(config, "systemd/user/cotal-daemon.service");
  mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
  const source = `[Service]\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${process.execPath}" "${entry}" daemon serve\nRestart=always\n`;
  writeFileSync(unitPath, source, { mode: 0o600 });
  const receiptFile = join(paths.state, "service-unit.json");
  const receipt = { v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: new Date().toISOString() };
  writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
  // Model the measured boundary: the owned supervisor acknowledges removal, but its
  // launcher child remains outside its custody, serving the actual endpoint.
  const pidFile = join(root, "owned-pid");
  writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nimport { appendFileSync, existsSync, readFileSync } from 'node:fs';\nconst args=process.argv.slice(2).join(' ');\nif(args==='--user show-environment') { ${mode === "owned" ? `if(!existsSync(${JSON.stringify(pidFile)}))process.exit(1);` : ""} console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)}); }\nelse {appendFileSync(${JSON.stringify(effects)},args+'\\n');${mode === "native-refusal" ? "process.exit(1);" : ""}${mode === "native-stop" ? `if(args.includes(' stop '))process.kill(Number(readFileSync(${JSON.stringify(pidFile)},'utf8')),'SIGTERM');` : ""}}\n`, { mode: 0o700 });
  const daemonEntry = mode === "foreground" ? entry : join(repo, "bin/dist/daemon-native.js");
  const daemon = spawn(process.execPath, [daemonEntry, "daemon", "serve"], { env, cwd: root, stdio: "ignore" });
  try {
    let pid: number | undefined;
    for (let i = 0; ; i++) {
      try { const reply = await queryDaemon({ paths }); if (reply.ok) { pid = reply.result.pid; break; } } catch { /* wait for actual endpoint */ }
      assert.ok(i < 200, "shipped daemon ready");
      await delay(25);
    }
    assert.equal(pid, daemon.pid, "the actual launched process owns the endpoint");
    const daemonLog = join(paths.state, "daemon.log");
    if (mode === "owned") {
      // Make the uninstaller exercise stop-time verification, not a cached startup success.
      for (let i = 0; !readFileSync(daemonLog, "utf8").includes("native ownership unknown: observation-failed"); i++) {
        assert.ok(i < 200, "startup ownership observation failed while the supervisor was unavailable");
        await delay(25);
      }
    }
    writeFileSync(pidFile, String(pid));
    if (mode === "owned") {
      await checkRepairLock(paths, pid, env);
      assert.equal(readFileSync(unitPath, "utf8"), source);
      assert.equal(readFileSync(receiptFile, "utf8"), JSON.stringify(receipt));
      assert.ok(!existsSync(effects), "foreign repair lock refusals leave the native service unchanged");
    }
    if (mode === "stopped") await killAndAwaitExit(daemon, "SIGTERM");
    if (mode === "changed-source") writeFileSync(unitPath, `${source}# changed\n`);
    if (mode === "foreign-receipt") writeFileSync(receiptFile, JSON.stringify({ ...receipt, unit: "foreign.service" }));
    const command = spawn(process.execPath, [entry, "daemon", "uninstall", "--yes", "--json"], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    command.stdout.on("data", b => output += b);
    command.stderr.on("data", b => output += b);
    const code = await new Promise<number | null>(resolve => command.once("exit", resolve));
    if (mode === "owned" || mode === "native-stop" || mode === "stopped") {
      assert.equal(code, 0, output);
      if (mode === "owned") assert.match(readFileSync(daemonLog, "utf8"), /native ownership owned: verified/, "uninstall verifies ownership while holding the repair lock");
      let answering = false;
      try { answering = (await queryDaemon({ paths })).ok; }
      catch (error) { assert.equal((error as { code?: string }).code, "NOT_RUNNING"); }
      assert.equal(answering, false, "owned uninstall must not report removed while the original shipped daemon still answers");
      assert.ok(daemon.exitCode !== null || daemon.signalCode !== null, "the exact owned process exited before removed was reported");
      assert.ok(!existsSync(unitPath) && !existsSync(receiptFile), "source and receipt removed after shutdown");
      console.log(mode === "stopped" ? "PASS installed stopped daemon uninstalls under lifetime exclusion" : "PASS shipped native-entry uninstall confirms endpoint and exact process absence despite supervisor child-lifetime gap");
    } else {
      assert.notEqual(code, 0, output);
      assert.ok(existsSync(unitPath) && existsSync(receiptFile), `${mode}: uncertain or unowned removal retains source and receipt`);
      if (mode !== "native-refusal") {
        const reply = await queryDaemon({ paths });
        assert.ok(reply.ok && reply.result.pid === pid, `${mode}: same daemon remains answering`);
        assert.ok(!existsSync(effects), `${mode}: refusal before native effects`);
      } else {
        assert.ok(existsSync(effects), output);
        assert.match(readFileSync(effects, "utf8"), /stop cotal-daemon.service/);
        const reply = await queryDaemon({ paths });
        assert.ok(reply.ok && reply.result.pid === pid, "failed native removal does not commit daemon shutdown");
      }
      console.log(`PASS shipped uninstall ${mode} refuses and retains ownership evidence`);
    }
  } finally {
    await killAndAwaitExit(daemon, "SIGTERM");
    console.log(`Retained ${mode} uninstall fixture: ${root}`);
  }
}
