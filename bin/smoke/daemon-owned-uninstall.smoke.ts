/** Uninstall observes the shipped daemon's death, not only its supervisor's acknowledgement. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { queryDaemon } from "../daemon/client.js";
import { excludeLifetime, holdLifetime } from "../daemon/lifetime.js";

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

type Mode = "owned" | "native-stop" | "stopped" | "foreground" | "changed-source" | "foreign-receipt" | "native-refusal";
for (const mode of ["owned", "native-stop", "stopped", "foreground", "changed-source", "foreign-receipt", "native-refusal"] as const satisfies readonly Mode[]) {
  const root = mkdtempSync(join(tmpdir(), "dou-"));
  const home = join(root, "home"), config = join(root, "config"), rt = join(root, "rt"), native = join(root, "native");
  for (const path of [home, config, rt, native]) mkdirSync(path, { mode: 0o700 });
  const effects = join(root, "effects");
  const env = { ...process.env, HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: rt, PATH: `${native}:${process.env.PATH}`, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
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
  writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nimport { appendFileSync, readFileSync } from 'node:fs';\nconst args=process.argv.slice(2).join(' ');\nif(args==='--user show-environment') console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});\nelse {appendFileSync(${JSON.stringify(effects)},args+'\\n');${mode === "native-refusal" ? "process.exit(1);" : ""}${mode === "native-stop" ? `if(args.includes(' stop '))process.kill(Number(readFileSync(${JSON.stringify(pidFile)},'utf8')),'SIGTERM');` : ""}}\n`, { mode: 0o700 });
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
    writeFileSync(pidFile, String(pid));
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
