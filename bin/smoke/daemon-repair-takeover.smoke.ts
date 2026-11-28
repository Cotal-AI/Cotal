/** Repair moves the background service from another Cotal installation to this one and keeps every
 *  record: sign-in, this computer's identity and each space's service records. A failed start of
 *  this installation's service puts the other one back. Uninstall still erases the same records. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { lockExclusiveNb } from "@cotal-ai/seat";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { queryDaemon } from "../daemon/client.js";

if (process.platform !== "linux") skipSuite("daemon repair takeover: recording Linux supervisor required");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = join(repo, "bin/dist/cotal.js");
const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
mkdirSync(join(repo, ".repro-tmp"), { recursive: true, mode: 0o700 });

/** Every regular file under `root`, relative path to content digest, so a count and a byte check are one read. */
function files(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) found.set(relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

/** The records a move must keep: sign-in sessions, computer identities and each space's service records. */
const SEEDED = [
  ["daemon/accounts/0123456789abcdef/computer.json", { v: 1, kind: "cotal-account-computer", machineId: "4f1d2c3b-0000-4000-8000-000000000001" }],
  ["daemon/account-spaces.json", { v: 1, spaces: { team: { owner: "owner-1", id: "sp_team", revision: 3 } } }],
  ["daemon/space.7465616d/service-connect.json", { v: 1, space: "team" }],
  ["daemon/space.7465616d/register-request.json", { v: 1, kind: "cotal-daemon-register-request", space: "team", instanceId: "i1", requestId: "0".repeat(32), bodyDigest: "x" }],
  ["daemon/space.7465616d/service-identity.json", { v: 1, space: "team" }],
  ["daemon/space.6f74686572/service-connect.json", { v: 1, space: "other" }],
  ["idp/session.json", { v: 1, sub: "user-1" }],
] as const;
function seedRecords(home: string): void {
  for (const [path, body] of SEEDED) {
    mkdirSync(join(home, dirname(path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, path), JSON.stringify(body), { mode: 0o600 });
  }
}

/** A second installation: the same built CLI in another folder, as an app bundle or npm would place
 *  it. It shares this checkout's installed dependencies through a link, so only its entry differs. */
function otherInstallation(): string {
  const other = mkdtempSync(join(repo, ".repro-tmp", "other-install-"));
  cpSync(join(repo, "bin/dist"), join(other, "dist"), { recursive: true });
  cpSync(join(repo, "bin/package.json"), join(other, "package.json"));
  symlinkSync(realpathSync(join(repo, "bin/node_modules")), join(other, "node_modules"), "dir");
  return join(other, "dist/cotal.js");
}

type Mode = "moved" | "rolled-back" | "declined" | "uninstall-erases" | "app-change-running" | "ejected";
for (const mode of ["uninstall-erases", "declined", "app-change-running", "moved", "rolled-back", "ejected"] as const satisfies readonly Mode[]) {
  const root = mkdtempSync(join(tmpdir(), "drt-"));
  const home = join(root, "home"), config = join(root, "config"), rt = join(root, "rt"), native = join(root, "native");
  for (const path of [home, config, rt, native]) mkdirSync(path, { mode: 0o700 });
  const effects = join(root, "effects");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, USER: "smoke", LOGNAME: "smoke", COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: rt, PATH: `${native}:${process.env.PATH}`, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
  const paths = daemonPaths(env, home);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  seedRecords(home);
  const otherEntry = mode === "uninstall-erases" ? entry : otherInstallation();
  const unitPath = join(config, "systemd/user/cotal-daemon.service");
  for (const dir of [join(config, "systemd"), dirname(unitPath)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const source = `[Service]\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${process.execPath}" "${otherEntry}" daemon serve\nRestart=always\n`;
  writeFileSync(unitPath, source, { mode: 0o600 });
  const receiptFile = join(paths.state, "service-unit.json");
  writeFileSync(receiptFile, JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
  // The recording supervisor: `start` launches whichever installation the unit file names now, and
  // `stop` ends the process it started. In rolled-back mode this installation's start is refused once.
  const pidFile = join(root, "pid"), refusedOnce = join(root, "refused-once");
  writeFileSync(join(native, "systemctl"), `#!${process.execPath}
import * as fs from 'node:fs'; import * as cp from 'node:child_process';
const args=process.argv.slice(2).join(' ');
if(args==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});process.exit(0)}
fs.appendFileSync(${JSON.stringify(effects)},args+'\\n');
if(args.endsWith(' stop cotal-daemon.service')){try{process.kill(Number(fs.readFileSync(${JSON.stringify(pidFile)},'utf8')),'SIGTERM')}catch{}process.exit(0)}
if(args.endsWith(' start cotal-daemon.service')){
  const unit=fs.readFileSync(${JSON.stringify(unitPath)},'utf8');
  const exec=/^ExecStart=(.*)$/m.exec(unit)[1].match(/"[^"]*"|\\S+/g).map(s=>s.replace(/^"|"$/g,''));
  if(${JSON.stringify(mode === "rolled-back")}&&!exec[exec.indexOf('daemon')-1].includes('other-install')&&!fs.existsSync(${JSON.stringify(refusedOnce)})){fs.writeFileSync(${JSON.stringify(refusedOnce)},'1');process.exit(0)}
  const native=exec[exec.indexOf('daemon')-1].replace(/cotal\\.js$/,'daemon-native.js');
  const child=cp.spawn(exec[0],[native,...exec.slice(exec.indexOf('daemon'))],{env:process.env,detached:true,stdio:'ignore'});
  fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();
}
process.exit(0)
`, { mode: 0o700 });
  writeFileSync(join(native, "loginctl"), `#!${process.execPath}\nconsole.log('Linger=yes')\n`, { mode: 0o700 });
  const daemon: ChildProcess = spawn(process.execPath, [join(dirname(otherEntry), "daemon-native.js"), "daemon", "serve"], { env, cwd: root, stdio: "ignore", detached: true });
  writeFileSync(pidFile, String(daemon.pid));
  const run = async (args: string[]) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
    const code = await new Promise<number | null>(done => child.once("exit", done));
    return { code, output, json: (() => { try { return JSON.parse(output); } catch { return undefined; } })() };
  };
  try {
    for (let i = 0; ; i++) {
      try { const reply = await queryDaemon({ paths }); if (reply.ok) break; } catch { /* wait for the other installation's daemon */ }
      assert.ok(i < 2400, "the other installation's daemon answers");
      await delay(25);
    }
    // Stop is refused until the daemon has verified its own native launch; on a busy host that
    // observation can take seconds, so wait for its one log line before driving uninstall or a move.
    const log = join(paths.state, "daemon.log");
    for (let i = 0; !(existsSync(log) && /native ownership (owned|not-owned|unknown)/.test(readFileSync(log, "utf8"))); i++) {
      assert.ok(i < 2400, "the daemon finished its native ownership check");
      await delay(25);
    }
    const before = files(home);
    const records = SEEDED.map(([path]) => path as string);
    assert.equal(records.filter(path => before.has(path)).length, 7, `seven seeded records survive the other daemon's startup: ${[...before.keys()].join(", ")}`);
    if (mode === "ejected") {
      // The disk image that held the other copy was ejected: its program is gone and nothing answers.
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* already gone */ }
      await killAndAwaitExit(daemon, "SIGTERM").catch(() => undefined);
      rmSync(dirname(dirname(otherEntry)), { recursive: true, force: true });
      for (let i = 0; ; i++) {
        try { await queryDaemon({ paths }); } catch { break; }
        assert.ok(i < 2400, "the other copy's service is gone");
        await delay(25);
      }
      const plan = await run(["daemon", "repair", "--json"]);
      assert.equal(plan.code, 0, plan.output);
      const owner = plan.json.result.steps.find((step: { step: string }) => step.step === "service-owner");
      assert.equal(owner.outcome, "fix", "a copy that can't run is moved, not refused for its unknown version");
      assert.equal(owner.consent, "takeover");
      assert.equal(owner.found, "The background service points at a copy of Cotal that can't run from where it is now.");
      const applied = await run(["daemon", "repair", "--apply", plan.json.result.digest, "--yes", "--json"]);
      assert.equal(applied.code, 0, applied.output);
      const reply = await queryDaemon({ paths });
      assert.ok(reply.ok && reply.result.version === version, "this app's service answers at this version");
      assert.ok(readFileSync(unitPath, "utf8").includes(`"${entry}"`), "the unit now names this installation");
      const after = files(home);
      assert.equal(records.filter(path => after.get(path) === before.get(path)).length, 7, "every record kept byte for byte");
      console.log("PASS a service whose copy was ejected moves to this app, answers at this version, and keeps 7/7 records");
      continue;
    }
    if (mode === "uninstall-erases") {
      const removed = await run(["daemon", "uninstall", "--yes", "--json"]);
      assert.equal(removed.code, 0, removed.output);
      const after = files(home);
      const kept = records.filter(path => after.get(path) === before.get(path));
      assert.equal(kept.length, 3, `uninstall keeps sign-in, identity and the account list only: ${kept.join(", ")}`);
      console.log("PASS uninstall still erases 4 of 7 space service records (the reason a move must not use it)");
      continue;
    }
    const plan = await run(["daemon", "repair", "--json"]);
    assert.equal(plan.code, 0, plan.output);
    const owner = plan.json.result.steps.find((step: { step: string }) => step.step === "service-owner");
    assert.equal(owner.outcome, "fix"); assert.equal(owner.consent, "takeover"); assert.equal(owner.owner.kind, "cli");
    assert.ok(!existsSync(effects), "planning ran no native command");
    if (mode === "declined") {
      const refused = await run(["daemon", "repair", "--apply", plan.json.result.digest, "--json"]);
      assert.equal(refused.code, 2, refused.output);
      assert.equal(refused.json.error.cause.code, "CONSENT_REQUIRED");
      assert.ok(!existsSync(effects), "a takeover without consent runs no native command");
      assert.equal((await queryDaemon({ paths })).ok, true, "the other installation's service still answers");
      assert.equal(readFileSync(unitPath, "utf8"), source, "its unit is unchanged");
      console.log("PASS takeover without consent changes nothing and stops nothing");
      continue;
    }
    if (mode === "app-change-running") {
      // An agent-app install holds the shared admission gate; a move must wait, never cut it off.
      const gate = openSync(join(paths.state, "agent-app.lock"), constants.O_RDWR | constants.O_CREAT, 0o600);
      assert.ok(lockExclusiveNb(gate), "the smoke holds the agent-app gate");
      try {
        const blocked = await run(["daemon", "repair", "--apply", plan.json.result.digest, "--yes", "--json"]);
        assert.equal(blocked.code, 2, blocked.output);
        assert.equal(blocked.json.error.code, "LIFECYCLE_BLOCKED");
        assert.ok(!existsSync(effects), "a move during an app change runs no native command");
        assert.equal(readFileSync(unitPath, "utf8"), source, "the other installation's unit is unchanged");
        assert.equal((await queryDaemon({ paths })).ok, true, "its service keeps answering");
      } finally { closeSync(gate); }
      console.log("PASS a move waits for a running agent-app change and changes nothing");
      continue;
    }
    const applied = await run(["daemon", "repair", "--apply", plan.json.result.digest, "--yes", "--json"]);
    const after = files(home);
    const kept = records.filter(path => after.get(path) === before.get(path));
    assert.equal(kept.length, 7, `every record kept byte for byte: ${records.filter(path => after.get(path) !== before.get(path)).join(", ")}`);
    const reply = await queryDaemon({ paths });
    assert.ok(reply.ok);
    if (mode === "moved") {
      assert.equal(applied.code, 0, applied.output);
      assert.equal(reply.result.version, version);
      assert.ok(readFileSync(unitPath, "utf8").includes(`"${entry}"`), "the unit now names this installation");
      assert.ok(!readFileSync(unitPath, "utf8").includes("other-install"), "and not the other one");
      console.log(`PASS takeover moved the service and kept ${kept.length}/7 records with the same computer identity`);
    } else {
      assert.equal(applied.code, 2, applied.output);
      assert.equal(applied.json.error.cause.code, "MOVE_ROLLED_BACK");
      assert.match(applied.json.error.message, /the previous service was restored and started again, and the agents it ran were stopped and do not start again by themselves/, "the rollback says what stopped");
      assert.equal(readFileSync(unitPath, "utf8"), source, "the previous unit was restored byte for byte");
      assert.ok(readFileSync(unitPath, "utf8").includes("other-install"), "the other installation runs the service again");
      console.log(`PASS a failed start restored the other installation's service and kept ${kept.length}/7 records`);
    }
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* already gone */ }
    await killAndAwaitExit(daemon, "SIGTERM").catch(() => undefined);
    // The copied installation is this run's own scratch; the fixture home stays for diagnosis.
    if (otherEntry !== entry) rmSync(dirname(dirname(otherEntry)), { recursive: true, force: true });
    console.log(`Retained ${mode} takeover fixture: ${root}`);
  }
}
