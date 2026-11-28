import strictAssert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killAndAwaitExit } from "@cotal-ai/smoke-kit";
import { claimUpdateClosureAccess, clearUpdateRecovery, readUpdateRecovery, SEEDED_EXTENSIONS, updateClosureOwner, writeUpdateRecovery } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
import { inspectHostedLaunches, managerViaDaemon, queryDaemon } from "../daemon/client.js";
import { validHostedLaunches, type HostedLaunches } from "../daemon/protocol.js";
import { HostedLaunchSettlementTimeout, waitForHostedLaunches } from "../daemon/update-launch-settlement.js";
import { stagedCustodyDeferral, stagedLaunchDeadline } from "../daemon/execution-preinstall.js";
import { daemonPaths, EndpointRefusal } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";
import { waitForInstalledDaemonGeneration } from "../daemon/update-generation.js";
import { installedDaemonIdentity, preflightInstalledDaemon, reconcileMissingShellRuntime, unitReceiptFile } from "../daemon/install.js";
import { currentParentWaits } from "../daemon/update-entry.js";
import { daemonManagerRoot } from "../daemon/manager.js";
import { executeUpdate, update, updateRuntime, type UpdateRuntime } from "@cotal-ai/cli/update";
import { processStatFields, processStartToken } from "@cotal-ai/seat";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;

await proveLaunchSettlementPolicy();

async function proveLaunchSettlementPolicy(): Promise<void> {
  const name = "_held-name_0123", held = { reserved: 2, held: 1, names: [name] };
  assert.equal(validHostedLaunches(held), true);
  for (const invalid of [null, { ...held, held: 3 }, { ...held, names: [] }, { reserved: 2, held: 2, names: [name, name] }, { ...held, names: ["x\n"] }])
    assert.equal(validHostedLaunches(invalid), false);
  const observation = (reserved: number, instanceId = "original") => ({ instanceId, agentCount: 7, stopImpact: { reservedLaunches: reserved } });
  const ordinary = { reserved: 1, held: 0, names: [] };
  const fixture = (read: (elapsed: number) => ReturnType<typeof observation>, inspect: (elapsed: number) => HostedLaunches | undefined, deadline?: number, start = 0) => {
    let elapsed = start, inspections = 0;
    const lines: string[] = [];
    const run = () => waitForHostedLaunches("example", "original", async () => read(elapsed), async () => { inspections++; return inspect(elapsed); },
      "update --self", line => lines.push(line), { now: () => elapsed, sleep: async ms => { elapsed += ms; } }, deadline);
    return { run, lines, elapsed: () => elapsed, inspections: () => inspections };
  };
  const idle = fixture(() => observation(0), () => { throw new Error("settled seats must not trigger launch inspection"); });
  assert.equal((await idle.run()).agentCount, 7);
  assert.deepEqual(idle.lines, []);
  for (const value of [undefined, ordinary, held]) {
    const settlesAt = value === held ? 400 : 174_000;
    const settling = fixture(t => observation(t < settlesAt ? 1 : 0), t => value && t >= settlesAt ? { reserved: 0, held: 0, names: [] } : value);
    assert.equal((await settling.run()).agentCount, 7);
    assert.equal(settling.elapsed(), settlesAt);
    assert.deepEqual(settling.lines, [value === held ? "Waiting for a held hosted PTY launch to settle in space example." : "Waiting for a hosted spawn to settle in space example."]);
    if (value === undefined) assert.equal(settling.inspections(), 1, "old peers are not queried again");
  }
  const ordinaryDeadline = fixture(() => observation(1), t => t < 500 ? held : ordinary);
  await assert.rejects(ordinaryDeadline.run, error => error instanceof HostedLaunchSettlementTimeout && /retry `(?:pnpm )?cotal update --self`/.test(error.message) && !error.message.includes(name));
  assert.equal(ordinaryDeadline.elapsed(), 180_000);
  assert.equal(ordinaryDeadline.lines.length, 1);
  const heldDeadline = fixture(() => observation(1), () => ({ ...held, reserved: 1 }));
  await assert.rejects(heldDeadline.run, error => error instanceof HostedLaunchSettlementTimeout && error.message.includes(`"${name}"`) && /daemon service-disconnect --space example`/.test(error.message) && error.message.includes("No installed packages were changed"));
  assert.equal(heldDeadline.elapsed(), 15_000);
  assert.equal(heldDeadline.lines.length, 1);
  const mixed = fixture(t => observation(t < 175_000 ? 2 : 0), t => t < 175_000 ? held : { reserved: 0, held: 0, names: [] });
  assert.equal((await mixed.run()).agentCount, 7, "a concurrent hold does not shorten an ordinary launch's readiness window");
  assert.equal(mixed.lines.length, 1);
  const replaced = fixture(t => observation(1, t ? "successor" : "original"), () => undefined);
  await assert.rejects(replaced.run, /identity changed/);
  assert.equal(replaced.inspections(), 1, "do not consult holds after a Manager identity change");

  const legacy = fixture(t => observation(t < 121_000 ? 1 : 0), () => undefined, stagedLaunchDeadline({}, 0), 15_000);
  const deferred = await legacy.run().catch(stagedCustodyDeferral);
  assert.deepEqual(deferred, { disposition: "deferred", occupied: null, hostedSpaces: [], reason: "a hosted spawn is still in progress" });
  assert.equal(legacy.elapsed(), 80_000, "legacy budget includes earlier custody checks and leaves 40 seconds of the released watchdog");
  assert.equal(legacy.lines.length, 1);
  const modern = fixture(t => observation(t < 175_000 ? 1 : 0), () => undefined, stagedLaunchDeadline({ supportsExtendedLaunchWait: true }, 0), 15_000);
  assert.equal((await modern.run()).agentCount, 7);
  assert.equal(modern.elapsed(), 175_000, "an opted-in caller waits beyond the released watchdog");
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "ug-")));
const userRuntime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
const privateRuntime = mkdtempSync("/tmp/cotal-ug-");
if (process.platform === "linux") {
  // Keep the daemon socket private. systemctl can discover its native user transport here.
  for (const name of ["systemd", "bus"]) {
    const source = join(userRuntime, name);
    if (existsSync(source)) symlinkSync(source, join(privateRuntime, name));
  }
}
process.on("exit", () => rmSync(privateRuntime, { recursive: true, force: true }));
process.env.XDG_RUNTIME_DIR = privateRuntime;
process.env.COTAL_HOME = join(root, "home");

type Reply = Awaited<ReturnType<NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"] & {}>>;
const status = (version: string, state?: string): Reply => ({ ok: true, result: { state: "ready", protocol: 1, version, pid: 1,
  managers: state ? [{ space: "alpha", state, pid: 2 }] : [] } } as unknown as Reply);
const refused = (code: string, message: string): Reply => ({ ok: false, error: { code, message } } as unknown as Reply);

/** Answer the wait from a script; a thrown entry stands for an endpoint gap. */
function scripted(steps: (Reply | Error)[]) {
  let calls = 0;
  return { calls: () => calls, query: (async () => {
    const step = steps[Math.min(calls++, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step;
  }) as NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"] };
}

// A daemon that refuses status while its hosted Managers stop and start is still restarting.
{
  const run = scripted([
    refused("MANAGER_UNAVAILABLE", "the daemon could not complete status: hosted Manager parent channel is unavailable"),
    new EndpointRefusal("NOT_RUNNING", "no daemon answers"),
    refused("MANAGER_UNAVAILABLE", "the daemon could not complete status: hosted Manager did not confirm the generation request; retrying without stopping it"),
    status("1.0.0", "answering"),
    status("2.0.0", "starting"),
    status("2.0.0", "answering"),
  ]);
  await waitForInstalledDaemonGeneration("2.0.0", { installed: () => true, query: run.query, timeoutMs: 20_000 });
  assert.equal(run.calls(), 6, "the wait continued through two status refusals, an endpoint gap, the old generation and a starting Manager");
}

// A refusal that never clears ends at the bound and names the daemon's own reason.
{
  const run = scripted([refused("MANAGER_UNAVAILABLE", "the daemon could not complete status: hosted Manager parent channel is unavailable")]);
  await assert.rejects(waitForInstalledDaemonGeneration("2.0.0", { installed: () => true, query: run.query, timeoutMs: 800 }), (error: Error) => {
    assert.match(error.message, /did not become ready within 1s/);
    assert.match(error.message, /MANAGER_UNAVAILABLE the daemon could not complete status: hosted Manager parent channel is unavailable/);
    return true;
  });
  assert.ok(run.calls() >= 2, "the refusal was retried until the bound");
}

// Ownership and authentication refusals still stop the wait at once.
{
  const run = scripted([new EndpointRefusal("PEER_UID_MISMATCH", "another user answers")]);
  await assert.rejects(waitForInstalledDaemonGeneration("2.0.0", { installed: () => true, query: run.query, timeoutMs: 5_000 }), /another user answers/);
  assert.equal(run.calls(), 1);
}

// No recorded service: nothing to wait for and nothing is asked.
{
  const run = scripted([status("1.0.0")]);
  await waitForInstalledDaemonGeneration("2.0.0", { installed: () => false, query: run.query });
  assert.equal(run.calls(), 0);
}

if (process.platform === "linux") {
  const paths = daemonPaths();
  let stops = 0;
  const old = await serveDaemon({ paths, version: "1.0.0",
    updateStatus: () => ({ current: "1.0.0", automatic: false, failures: 0, lastResult: "not checked" }),
    stopAllowed: async () => { stops++; return true; },
  });
  const probe = { installed: () => true, quiet: true, restartPrepared: true };
  try {
    old.generationPending("2.0.0", "entry verification did not confirm its version (exit null)");
    await assert.rejects(waitForInstalledDaemonGeneration("2.0.0", { ...probe, timeoutMs: 800 }), /still runs Cotal 1\.0\.0/);
    assert.equal(stops, 0, "an unprepared daemon is not asked to stop");
    await old.prepareGenerationRestart();
    const waiting = waitForInstalledDaemonGeneration("2.0.0", { ...probe, timeoutMs: 10_000 });
    void waiting.catch(() => {});
    // Exercise the stock local stop handshake. The real native supervisor is covered by the packed upgrade.
    await Promise.race([old.stopped, waiting]);
    assert.equal(stops, 1, "one authenticated stop releases the prepared old generation");
    const replacement = await serveDaemon({ paths, version: "2.0.0" });
    try { await waiting; }
    finally { await replacement.close(); }
  } finally { await old.close(); }
}

if (process.platform === "linux") {
  const directory = join(root, "hosted"), home = join(directory, "home"), project = join(directory, "project"), native = join(directory, "bin");
  const cotalHome = join(home, ".cotal");
  const entry = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
    HOME: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: join(home, ".config"), TMPDIR: directory, CLAUDE_CONFIG_DIR: home,
    PATH: `${native}:${process.env.PATH}`, DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1",
    COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
  };
  const seedDir = join(env.XDG_CONFIG_HOME!, "cotal", "seed");
  for (const dir of [seedDir, join(project, ".cotal"), cotalHome, native]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const authority = JSON.stringify({ everSeeded: Object.keys(SEEDED_EXTENSIONS).filter(name => name !== "claude") });
  for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seedDir, file), authority, { mode: 0o600 });
  writeFileSync(join(native, "claude"), "#!/bin/sh\necho '2.1.330 (Claude Code)'\n", { mode: 0o700 });
  // An existing user MCP entry lets the real Claude setup provider run without plugin installation or an agent.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { cotal: { command: "cotal", args: [] } } }), { mode: 0o600 });
  const seed = spawnSync(process.execPath, [entry, "ext", "seed"], { env, cwd: project, encoding: "utf8", timeout: 180_000 });
  assert.equal(seed.status, 0, `${seed.error ?? ""}\n${seed.stdout}${seed.stderr}`);
  const sharedSkip = hostedSharedSkipReason(env, project);
  if (sharedSkip === undefined) addPtyFixture(entry, project, directory, env);
  else console.log(`Hosted shared PTY cases skipped: ${sharedSkip}`);
  const fixture = new URL("../../implementations/auth/smoke/update-participant.fixture.ts", import.meta.url).href;
  const participant = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", `
    import { prepareUpdateParticipant } from ${JSON.stringify(fixture)};
    import { existsSync, writeFileSync } from 'node:fs';
    const report = {};
    const close = await prepareUpdateParticipant({ env: process.env, project: process.cwd(), cotalHome: process.env.COTAL_HOME, report,
      async beforeManagedEnrollment(name) {
        if (!['update_during_spawn', 'update_staged_spawn'].includes(name)) return;
        const path = ${JSON.stringify(directory)} + '/' + name;
        writeFileSync(path + '.entered', 'entered');
        const deadline = Date.now() + 30_000;
        while (!existsSync(path + '.release')) {
          if (Date.now() >= deadline) throw new Error('enrollment fixture was not released');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      },
    });
    process.stdout.write('HOSTED_PARTICIPANT ' + report.participant.space + '\\n');
    process.stdin.resume();
    process.stdin.once('end', () => void close().catch(error => { console.error(error); process.exitCode = 1; }));
  `], { env, cwd: project, stdio: ["pipe", "pipe", "inherit"] });
  const participantStopped = new Promise<number | null>(resolve => participant.once("close", resolve));
  participant.stdin!.on("error", () => { /* The exit observation reports a failed fixture. */ });
  const priorHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = cotalHome;
  const paths = daemonPaths(env);
  let daemon: ChildProcess | undefined, release: (() => void) | undefined;
  let log = "";
  async function start() {
    daemon = spawn(process.execPath, [entry, "daemon", "serve"], { env, cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    daemon.stdout!.on("data", bytes => { log += String(bytes); });
    daemon.stderr!.on("data", bytes => { log += String(bytes); });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const status = await queryDaemon({ paths, timeoutMs: 1000 }).catch(() => undefined);
      if (status?.ok && status.result.pid === daemon.pid) return;
      if (daemon.exitCode !== null || Date.now() >= deadline) throw new Error(`daemon did not answer: ${log}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    let output = "";
    const space = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`participant fixture did not start: ${output}`)), 20_000);
      void participantStopped.then(() => { clearTimeout(timer); reject(new Error(`participant fixture exited: ${output}`)); });
      participant.stdout!.on("data", bytes => {
        output += String(bytes);
        const match = /^HOSTED_PARTICIPANT (\S+)\n/m.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
    });
    await start();
    const before = await managerViaDaemon({ paths }, { op: "manager-start", space });
    assert.equal(before.state, "answering", JSON.stringify(before));
    const fallback = "Shared PTY custody is unavailable because the Linux user service manager or cgroup v2 is unavailable. Seats run inside the Manager and cannot survive a restart.";
    const managerLog = join(daemonManagerRoot(space, cotalHome), "manager.log");
    if (sharedSkip?.startsWith("the daemon environment cannot reach")) {
      for (let i = 0; i < 20 && (!existsSync(managerLog) || !readFileSync(managerLog, "utf8").includes(fallback)); i++) await briefly();
      assert.ok(existsSync(managerLog));
      assert.equal(readFileSync(managerLog, "utf8").split(fallback).length, 2, "the ineligible Manager logs the actual fallback once");
    }
    if (sharedSkip === undefined) {
      if (existsSync(managerLog)) assert.ok(!readFileSync(managerLog, "utf8").includes(fallback));
      const ctx = { start, daemon: () => daemon!, paths, space, entry, project, home, env };
      if (!("instanceId" in before) || !before.instanceId) throw new Error("the hosted fixture has no Manager instance");
      const instanceId = before.instanceId;
      await withPublicUpdateFixture(ctx, version, async run => {
        await proveUpdateDuringSpawn(ctx, instanceId, directory, run);
        await proveStagedPreinstallDuringSpawn(ctx, instanceId, directory, run);
        await proveHostedPtyFailures(ctx, run);
      });
      await start();
      const restored = await managerViaDaemon({ paths }, { op: "manager-start", space });
      assert.equal(restored.state, "answering", "the fixture restored hosting intent after the ordinary stop cell");
    }
    await killAndAwaitExit(daemon!, "SIGTERM");
    release = claimUpdateClosureAccess();
    writeUpdateRecovery({ previous: "0.0.0", target: version, installed: version, phase: "verified-ready", reason: "waiting for hosted readiness", owner: updateClosureOwner() });
    await start();
    // This is the same wait the updater runs while it still owns the live closure. The new
    // daemon has no inherited transaction environment and must resume its recorded Manager.
    await waitForInstalledDaemonGeneration(version, { installed: () => true, timeoutMs: 20_000 });
    const after = await queryDaemon({ paths });
    assert.ok(after.ok);
    const manager = after.result.managers?.find(row => row.space === space);
    assert.equal(manager?.state, "answering", JSON.stringify(after.result.managers));
    assert.notEqual(manager?.pid, before.pid);
    assert.equal(manager?.connectors?.find(row => row.agent === "claude")?.state, "available", JSON.stringify(manager?.connectors));
    assert.equal(readUpdateRecovery()?.owner?.pid, process.pid, "the updater still holds its transaction when the Manager answers");
  } finally {
    if (release) { clearUpdateRecovery(); release(); }
    try { if (daemon && daemon.exitCode === null && daemon.signalCode === null) await killAndAwaitExit(daemon, "SIGTERM"); }
    finally {
      process.env.COTAL_HOME = priorHome;
      participant.stdin!.end();
      const timer = setTimeout(() => void killAndAwaitExit(participant), 10_000);
      try { assert.equal(await participantStopped, 0, "participant fixture shut down cleanly"); }
      finally { clearTimeout(timer); }
    }
  }
}

if (process.platform !== "linux") console.log("Hosted shared PTY cases skipped: requires Linux and a systemd user manager");

function hostedSharedSkipReason(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { linuxSharedCustodyAvailable } from ${JSON.stringify(import.meta.resolve("@cotal-ai/seat"))};
    process.exitCode = !linuxSharedCustodyAvailable() ? 40 : typeof process.execve !== "function" ? 41 : 0;
  `], { env, cwd, timeout: 10_000, encoding: "utf8" });
  if (probe.status === 40) return "the daemon environment cannot reach a Linux systemd user manager with cgroup v2";
  if (probe.status === 41) return "the daemon's Node does not expose process.execve";
  if (probe.status !== 0) throw new Error(`the hosted shared PTY capability probe did not complete: ${probe.stderr?.trim() ?? ""}`, { cause: probe.error });
  const linger = spawnSync("/usr/bin/loginctl", ["show-user", "--property=Linger", "--value", "--", String(process.getuid?.())], { env, cwd, encoding: "utf8", timeout: 2_000 });
  if (linger.status !== 0 || linger.stdout.trim() !== "yes") return "the test account does not have confirmed linger";
}

function addPtyFixture(entry: string, project: string, directory: string, env: NodeJS.ProcessEnv): void {
  const fixture = join(directory, "shared-fixture");
  mkdirSync(fixture, { mode: 0o700 });
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "cotal-shared-pty-smoke", version: "1.0.0", main: "index.js", type: "module", peerDependencies: { "@cotal-ai/core": "*" } }));
  const seat = join(directory, "hosted-seat.mjs");
  writeFileSync(seat, `import { spawn } from 'node:child_process';
    import { readFileSync, renameSync, writeFileSync } from 'node:fs';
    const [name, proof] = process.argv.slice(2);
    const identity = pid => ({ pid, start: readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ')[19] });
    process.on('SIGHUP', () => {});
    process.on('SIGTERM', () => {
      if (name === 'dead_parent_fallback') { writeFileSync(proof + '.term', 'SIGTERM'); process.exit(0); }
    });
    const detached = name === 'dead_parent_fallback' ? undefined :
      spawn('/usr/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    detached?.unref();
    writeFileSync(proof + '.tmp', JSON.stringify({ child: identity(process.pid), descendant: detached ? identity(detached.pid) : undefined }));
    renameSync(proof + '.tmp', proof);
    setTimeout(() => process.exit(93), 300_000);
  `);
  writeFileSync(join(fixture, "index.js"), `import { registry } from '@cotal-ai/core';
    import { join } from 'node:path';
    registry.register({kind:'connector', name:'shared-pty-smoke', requires:['node'], waitsForOperator:()=> 'test terminal',
    buildLaunch:({name})=>{
      if (['update_during_spawn', 'update_staged_spawn'].includes(name)) throw new Error('ordinary spawn fixture stopped before process launch');
      return {command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(seat)},name,join(${JSON.stringify(directory)},name+'.json')],env:{PATH:'/usr/bin:/bin'}};
    }});`);
  const added = spawnSync(process.execPath, [entry, "ext", "add", fixture], { env, cwd: project, encoding: "utf8", timeout: 90_000 });
  assert.equal(added.status, 0, `${added.error ?? ""}\n${added.stdout}${added.stderr}`);
}

type HostedPtyProof = {
  start(): Promise<void>;
  daemon(): ChildProcess;
  paths: ReturnType<typeof daemonPaths>;
  space: string;
  entry: string;
  project: string;
  home: string;
  env: NodeJS.ProcessEnv;
};

type Lifetime = { pid: number; start: string };
type HostedSeat = { child: Lifetime; descendant?: Lifetime };
type HostedUnit = Lifetime & { scope: string; cgroup: string };
function briefly(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 100));
}

type PublicCommand = { child: ChildProcess; exited: Promise<number | null>; text(): string };
type PublicRun = (args: string[], timeoutMs?: number) => PublicCommand;

function spawnProof(ctx: HostedPtyProof, entry: string, args: string[], env = ctx.env, timeoutMs = 60_000): PublicCommand {
  const child = spawn(process.execPath, [entry, ...args], { env, cwd: ctx.project, stdio: ["ignore", "pipe", "pipe"] });
  let text = "", overflow = false, expired = false;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
    if (overflow) return;
    text += data;
    if (text.length > 256_000) { overflow = true; text = text.slice(0, 256_000); void killAndAwaitExit(child).catch(() => {}); }
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const timeout = setTimeout(() => { expired = true; void killAndAwaitExit(child).catch(() => {}); }, timeoutMs);
  void exited.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
  return { child, exited, text: () => `${text}${overflow ? "\n[fixture output exceeded its limit]" : ""}${expired ? `\n[fixture child exceeded its ${timeoutMs} ms deadline]` : ""}` };
}

async function withPublicUpdateFixture(ctx: HostedPtyProof, version: string, check: (run: PublicRun) => Promise<void>): Promise<void> {
  const registry = createServer((_req, res) => res.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } })));
  await new Promise<void>((resolve, reject) => { registry.once("error", reject); registry.listen(0, "127.0.0.1", resolve); });
  const address = registry.address();
  if (!address || typeof address === "string") throw new Error("update metadata fixture did not listen");
  const run: PublicRun = (args, timeoutMs) => spawnProof(ctx, ctx.entry, args, { ...ctx.env, npm_config_registry: `http://127.0.0.1:${address.port}` }, timeoutMs);
  try { await check(run); }
  finally { await new Promise<void>(resolve => registry.close(() => resolve())); }
}

async function waitForCommandText(command: PublicCommand, expected: string): Promise<void> {
  for (let i = 0; i < 120 && command.child.exitCode === null && !command.text().includes(expected); i++) await briefly();
  assert.ok(command.text().includes(expected), `expected ${expected}:\n${command.text()}`);
}

async function proveUpdateDuringSpawn(ctx: HostedPtyProof, manager: string, directory: string, run: PublicRun): Promise<void> {
  const name = "update_during_spawn";
  const entered = join(directory, `${name}.entered`), release = join(directory, `${name}.release`);
  const launching = run(["spawn", "--agent", "shared-pty-smoke", "--name", name, "--space", ctx.space, "--on", manager, "--detach", "--no-events"]);
  let updating: PublicCommand | undefined;
  try {
    for (let i = 0; i < 100 && !existsSync(entered) && launching.child.exitCode === null; i++) await briefly();
    assert.ok(existsSync(entered), `ordinary spawn did not reach the held enrollment: ${launching.text()}`);
    assert.deepEqual(await inspectHostedLaunches(ctx.paths, ctx.space, manager, 3_000), { reserved: 1, held: 0, names: [] });
    await assert.rejects(inspectHostedLaunches(ctx.paths, ctx.space, "wrong-instance", 3_000), /identity changed/);
    // This command waits for enrollment and then runs real connector reconciliation.
    updating = run(["update", "--space", ctx.space], 180_000);
    await waitForCommandText(updating, "Waiting for a hosted spawn to settle");
    await new Promise(resolve => setTimeout(resolve, 16_000));
    assert.equal(updating.child.exitCode, null, "the updater waits past the old fifteen-second cutoff");
    writeFileSync(release, "release");
    assert.notEqual(await launching.exited, 0, launching.text());
    assert.match(launching.text(), /ordinary spawn fixture stopped before process launch/);
    assert.equal(await updating.exited, 0, updating.text());
    assert.match(updating.text(), /Built-in connectors/);
    assert.equal(updating.text().split("Waiting for a hosted spawn to settle").length, 2, "the real CLI prints one wait line");
    assert.deepEqual(await inspectHostedLaunches(ctx.paths, ctx.space, manager, 3_000), { reserved: 0, held: 0, names: [] });
  } finally {
    writeFileSync(release, "release");
    for (const command of [launching, updating]) if (command && command.child.exitCode === null && command.child.signalCode === null) await killAndAwaitExit(command.child);
  }
}

async function proveStagedPreinstallDuringSpawn(ctx: HostedPtyProof, manager: string, directory: string, run: PublicRun): Promise<void> {
  const name = "update_staged_spawn", entered = join(directory, `${name}.entered`), release = join(directory, `${name}.release`);
  const native = join(directory, "preinstall-unit-lookup"), config = join(native, "config"), unit = "cotal-daemon.service";
  const unitPath = join(config, "systemd", "user", unit), receipt = unitReceiptFile(ctx.paths);
  const daemonArgv = [process.execPath, ctx.entry, "daemon", "serve"];
  // Stage checks read the recorded source, not the active unit. Answer only its directory query
  // and keep both files private and unregistered. The daemon, Manager and enrollment are real.
  mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
  writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '--user show-environment') process.exit(99);\nconsole.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});\n`, { mode: 0o700 });
  const source = `ExecStart=${daemonArgv.map(value => JSON.stringify(value)).join(" ")}\n`;
  writeFileSync(unitPath, source, { mode: 0o600 });
  writeFileSync(receipt, JSON.stringify({ v: 1, unit, unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
  const launch = run(["spawn", "--agent", "shared-pty-smoke", "--name", name, "--space", ctx.space, "--on", manager, "--detach", "--no-events"]);
  let stage: PublicCommand | undefined;
  try {
    for (let i = 0; i < 100 && !existsSync(entered) && launch.child.exitCode === null; i++) await briefly();
    assert.ok(existsSync(entered), launch.text());
    const request = { v: 1, nonce: "e".repeat(32), installedEntry: ctx.entry, daemonArgv, flags: { space: ctx.space } };
    stage = spawnProof(ctx, join(dirname(ctx.entry), "execution-preinstall.js"), [JSON.stringify(request)], { ...ctx.env, PATH: `${native}:${ctx.env.PATH}` });
    const progress = `COTAL_PREINSTALL_PROGRESS Waiting for a hosted spawn to settle in space ${ctx.space}.`;
    await waitForCommandText(stage, progress);
    await new Promise(resolve => setTimeout(resolve, 16_000));
    assert.equal(stage.child.exitCode, null, "the target preinstall is still waiting beyond fifteen seconds");
    writeFileSync(release, "release");
    assert.notEqual(await launch.exited, 0, launch.text());
    assert.equal(await stage.exited, 0, stage.text());
    assert.equal(stage.text().split(progress).length, 2, "the target preinstall prints one progress line");
    const result = /^COTAL_PREINSTALL_RESULT (.+)$/m.exec(stage.text());
    assert.ok(result, stage.text());
    assert.deepEqual(JSON.parse(result[1]!).admission, { disposition: "restart-empty", occupied: 0, hostedSpaces: [ctx.space] });
  } finally {
    writeFileSync(release, "release");
    for (const command of [launch, stage]) if (command && command.child.exitCode === null && command.child.signalCode === null) await killAndAwaitExit(command.child);
    rmSync(receipt);
  }
}

function hostedCli(ctx: HostedPtyProof, args: string[], env = ctx.env): string {
  const ran = spawnSync(process.execPath, [ctx.entry, ...args], { cwd: ctx.project, env, encoding: "utf8", timeout: 45_000 });
  assert.equal(ran.status, 0, `${args.join(" ")}: ${ran.error ?? ""}\n${ran.stdout}${ran.stderr}`);
  return ran.stdout;
}

function hostedInventory(ctx: HostedPtyProof, instance: string) {
  const { result } = JSON.parse(hostedCli(ctx, ["ps", "--space", ctx.space, "--on", instance, "--json"])) as {
    result: { kind: string; items: { name: string; status: string }[]; managers: { instanceId: string; state: string }[] };
  };
  assert.equal(result.kind, "seats");
  assert.ok(result.managers.some(row => row.instanceId === instance && row.state === "answered"), JSON.stringify(result.managers));
  return result.items;
}

function userUnits(ctx: HostedPtyProof, args: string[]): string {
  const ran = spawnSync("/usr/bin/systemctl", ["--user", ...args], { env: ctx.env, encoding: "utf8", timeout: 5_000 });
  assert.equal(ran.status, 0, `${args.join(" ")}: ${ran.error ?? ""}\n${ran.stdout}${ran.stderr}`);
  return ran.stdout.trim();
}

function unitGone(ctx: HostedPtyProof, host: HostedUnit): boolean {
  return !existsSync(`/sys/fs/cgroup${host.cgroup}`) &&
    !userUnits(ctx, ["list-units", "--state=active,activating,deactivating,reloading", "--no-legend", "--plain", host.scope]);
}

async function waitUnitGone(ctx: HostedPtyProof, host: HostedUnit): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (unitGone(ctx, host)) return;
    await briefly();
  }
  assert.fail(`${host.scope} or its cgroup still exists`);
}

function stillLive(row: Lifetime): boolean {
  const stat = processStatFields(row.pid);
  if (!stat) return existsSync(`/proc/${row.pid}`);
  return stat[19] === row.start && !["Z", "X"].includes(stat[0]!);
}

function assertGone(rows: Lifetime[], message: string): void {
  assert.deepEqual(rows.filter(stillLive), [], message);
}

async function waitGone(rows: Lifetime[]): Promise<void> {
  for (let i = 0; i < 200 && rows.some(stillLive); i++) await briefly();
  assertGone(rows, "owned process lifetimes ended");
}

function scopeFromRecord(record: { scope: string }): string {
  assert.match(record.scope, /^cotal-pty-[a-f0-9]{32}\.service$/);
  return record.scope;
}

type HostedManagerIdentity = Lifetime & { id: string };
type HostedPair = { manager: HostedManagerIdentity; host: HostedUnit; names: string[]; rows: Lifetime[] };

async function pauseHostedProcess(row: Lifetime): Promise<void> {
  assert.ok(stillLive(row), `fixture process ${row.pid} must be live before SIGSTOP`);
  process.kill(row.pid, "SIGSTOP");
  for (let i = 0; i < 20 && processStatFields(row.pid)?.[0] !== "T"; i++) await briefly();
  assert.equal(processStatFields(row.pid)?.[0], "T");
}

async function provePublicHostedDisconnect(ctx: HostedPtyProof, cell: HostedPair): Promise<void> {
  const { host, manager, rows } = cell;
  const reply = JSON.parse(hostedCli(ctx, ["daemon", "service-disconnect", "--space", ctx.space, "--json"]));
  assert.equal(reply.result.space, ctx.space);
  assert.equal(reply.result.state, "disconnected");
  assert.equal(reply.result.manager?.state, "stopped");
  assertGone([manager, host, ...rows], "public disconnect ended the Manager, host, seats and detached descendants");
  assert.ok(unitGone(ctx, host), "public disconnect drained the exact unit before success");
  const status = await queryDaemon({ paths: ctx.paths });
  assert.ok(status.ok && status.result.pid === ctx.daemon().pid, "public disconnect kept the original daemon answering");
  console.log("Hosted shared PTY: public service-disconnect ended the exact unit and its seats");
}

function makeUninstallReceipt(ctx: HostedPtyProof, directory: string) {
  const config = join(directory, "config"), unit = "cotal-daemon.service";
  const unitPath = join(config, "systemd", "user", unit), receipt = unitReceiptFile(ctx.paths);
  mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
  // Only daemon supervisor registration is simulated. The PTY drain uses the real systemctl.
  writeFileSync(join(directory, "systemctl"), `#!${process.execPath}
const args=process.argv.slice(2).filter(a=>a!=='--no-ask-password' && a!=='--no-pager').join(' ');
if(args==='--user show-environment') console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});
else if(!${JSON.stringify([`--user stop ${unit}`, `--user disable ${unit}`, "--user daemon-reload"])}.includes(args)) process.exit(99);
`, { mode: 0o700 });
  const source = `ExecStart=${[process.execPath, ctx.entry, "daemon", "serve"].map(value => JSON.stringify(value)).join(" ")}\n`;
  writeFileSync(unitPath, source, { mode: 0o600 });
  writeFileSync(receipt, JSON.stringify({ v: 1, unit, unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
  return { unitPath, receipt, path: `${directory}:${ctx.env.PATH}` };
}

async function provePublicHostedUninstall(ctx: HostedPtyProof, cell: HostedPair, seatRoot?: string): Promise<void> {
  const { host, manager, rows } = cell;
  const daemon = ctx.daemon(), pid = daemon.pid!;
  const start = processStartToken(pid);
  assert.ok(start);
  const directory = mkdtempSync(join(dirname(ctx.project), "uninstall-"));
  const daemonIdentity = { pid, start };
  try {
    const { unitPath, receipt, path } = makeUninstallReceipt(ctx, directory);
    const env = { ...ctx.env, PATH: path, ...(seatRoot === undefined ? {} : { COTAL_SEAT_ROOT: seatRoot }) };
    await pauseHostedProcess(host);
    await pauseHostedProcess(daemonIdentity);
    assert.ok(stillLive(manager));
    process.kill(manager.pid, "SIGKILL");
    await killAndAwaitExit(daemon, "SIGKILL");
    await waitGone([daemonIdentity, manager]);
    assert.equal(processStatFields(host.pid)?.[0], "T", "the owner observer is paused until uninstall returns");
    assert.ok([host, ...rows].every(stillLive) && !unitGone(ctx, host), "the exact orphaned unit and all its processes survived until uninstall");
    const reply = JSON.parse(hostedCli(ctx, ["daemon", "uninstall", "--yes", "--json"], env));
    assert.equal(reply.result.state, "removed");
    assertGone([host, ...rows], "public uninstall ended the orphaned host, seats and detached descendants");
    assert.ok(unitGone(ctx, host), "public uninstall drained the exact unit before success");
    assert.ok(!existsSync(unitPath) && !existsSync(receipt), "public uninstall removed the private source and receipt");
    console.log(`Hosted shared PTY: public uninstall ${seatRoot === undefined ? "without" : "with"} COTAL_SEAT_ROOT drained the paused orphaned unit`);
  } finally {
    if (stillLive(daemonIdentity)) process.kill(pid, "SIGCONT");
    if (stillLive(host)) process.kill(host.pid, "SIGCONT");
    rmSync(directory, { recursive: true, force: true });
    rmSync(unitReceiptFile(ctx.paths), { force: true });
  }
}

async function provePublicHostedStops(ctx: HostedPtyProof, launchPair: (label: string) => Promise<HostedPair>): Promise<void> {
  assert.equal(ctx.env.COTAL_SEAT_ROOT, undefined);
  assert.ok(!existsSync(unitReceiptFile(ctx.paths)), "the hosted fixture has no pre-existing daemon receipt");
  const seatRoot = mkdtempSync(join(dirname(ctx.project), "exported-seat-root-"));
  try {
    await provePublicHostedDisconnect(ctx, await launchPair("public_disconnect"));
    await provePublicHostedUninstall(ctx, await launchPair("public_uninstall_default"));
    await ctx.start();
    await provePublicHostedUninstall(ctx, await launchPair("public_uninstall_exported"), seatRoot);
  } finally { rmSync(seatRoot, { recursive: true, force: true }); }
}

async function proveUpdateWithHeldPty(ctx: HostedPtyProof, { manager, host, rows }: HostedPair, run: PublicRun): Promise<void> {
  const settled = run(["update", "--space", ctx.space]);
  assert.equal(await settled.exited, 1, settled.text());
  assert.match(settled.text(), /cannot preserve running agents on this computer during update/);
  assert.doesNotMatch(settled.text(), /Waiting for a hosted/);
  assert.ok(rows.every(stillLive), "the ordinary update did not stop settled shared PTYs");
  const name = "update_held_pty";
  const manifest = join(dirname(ctx.entry), "../package.json"), bytes = readFileSync(manifest);
  assert.ok(stillLive(host));
  process.kill(host.pid, "SIGSTOP");
  let launch: PublicCommand | undefined, update: PublicCommand | undefined;
  try {
    for (let i = 0; i < 20 && processStatFields(host.pid)?.[0] !== "T"; i++) await briefly();
    assert.equal(processStatFields(host.pid)?.[0], "T");
    launch = run(["spawn", "--agent", "shared-pty-smoke", "--name", name, "--space", ctx.space, "--on", manager.id, "--detach", "--no-events"]);
    assert.equal(await launch.exited, 3, launch.text());
    assert.match(launch.text(), /Its name remains held/);
    assert.deepEqual(await inspectHostedLaunches(ctx.paths, ctx.space, manager.id, 3_000), { reserved: 1, held: 1, names: [name] });
    update = run(["update", "--space", ctx.space]);
    await waitForCommandText(update, "Waiting for a held hosted PTY launch to settle");
    assert.equal(await update.exited, 1, update.text());
    assert.ok(update.text().includes(`Hosted PTY launch still held in space ${ctx.space}: "${name}".`), update.text());
    assert.match(update.text(), /No installed packages were changed\. Save work in this space before clearing the hold: `[^`]*cotal daemon service-disconnect --space [^`]+` stops its hosted Manager and seats/);
    assert.equal(update.text().split("Waiting for a held hosted PTY launch to settle").length, 2);
    assert.deepEqual(readFileSync(manifest), bytes);
    assert.ok(stillLive(manager) && stillLive(host) && rows.every(stillLive), "a refused update did not stop the Manager, host, or seats");
  } finally {
    if (stillLive(host)) process.kill(host.pid, "SIGCONT");
    for (const command of [launch, update]) if (command && command.child.exitCode === null && command.child.signalCode === null) await killAndAwaitExit(command.child);
  }
}

async function proveUnresponsiveHost(ctx: HostedPtyProof, { manager, host, names, rows }: HostedPair): Promise<void> {
  assert.ok(stillLive(host));
  process.kill(host.pid, "SIGSTOP");
  try {
    for (let i = 0; i < 20 && processStatFields(host.pid)?.[0] !== "T"; i++) await briefly();
    assert.equal(processStatFields(host.pid)?.[0], "T");
    assert.equal(hostedInventory(ctx, manager.id).filter(row => names.includes(row.name) && row.status === "running").length, names.length);
    await assert.rejects(managerViaDaemon({ paths: ctx.paths }, { op: "managers-prepare-restart" }), /SEATS_ACTIVE/);
    assert.ok(stillLive(host) && rows.every(stillLive), "a stopped host is not mistaken for a dead host");
  } finally {
    if (stillLive(host)) process.kill(host.pid, "SIGCONT");
  }
}

async function waitHostCrashInventory(ctx: HostedPtyProof, manager: string, names: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    if (hostedInventory(ctx, manager).filter(row => names.includes(row.name)).every(row => row.status === "exited")) return;
    await briefly();
  } while (Date.now() < deadline);
  assert.fail("the same Manager did not report the dead host's seats exited or retired");
}

async function proveDeadParentFallback(ctx: HostedPtyProof, store: string, getManager: () => Promise<HostedManagerIdentity>, launch: (manager: string, name: string) => Promise<HostedSeat>): Promise<void> {
  // Keep native-host eligibility but fail closure preparation before any host or seat is started.
  const parked = `${store}.parked`;
  const hadStore = existsSync(store);
  if (hadStore) renameSync(store, parked);
  const name = "dead_parent_fallback";
  let previous: HostedManagerIdentity;
  try {
    writeFileSync(store, "block shared closure preparation", { flag: "wx", mode: 0o600 });
    previous = await getManager();
    assert.ok(stillLive(previous));
    const { child } = await launch(previous.id, name);
    assert.ok(stillLive(child));
    assert.equal(processStatFields(child.pid)?.[1], String(previous.pid), "the Manager directly owns the in-process PTY child");
    assert.ok(hostedInventory(ctx, previous.id).some(row => row.name === name && row.status === "running"));
    await killAndAwaitExit(ctx.daemon(), "SIGKILL");
    await waitGone([previous, child]);
    assert.equal(readFileSync(join(ctx.project, "..", `${name}.json.term`), "utf8"), "SIGTERM", "dead-parent teardown must explicitly stop the fallback PTY");
  } finally {
    rmSync(store, { force: true });
    if (hadStore) renameSync(parked, store);
  }
  await ctx.start();
  const successor = await getManager();
  assert.ok(successor.pid !== previous.pid || successor.start !== previous.start, "a different Manager process answers");
  assert.ok(hostedInventory(ctx, successor.id).every(row => row.name !== name));
}

async function proveHostedPtyFailures(ctx: HostedPtyProof, run: PublicRun): Promise<void> {
  const getManager = async (exclude?: Lifetime): Promise<HostedManagerIdentity> => {
    const deadline = Date.now() + 30_000;
    do {
      const answer = await managerViaDaemon({ paths: ctx.paths }, { op: "manager-start", space: ctx.space });
      if (answer.state === "answering" && "instanceId" in answer && answer.instanceId && answer.pid) {
        const start = processStartToken(answer.pid);
        if (start && (!exclude || exclude.pid !== answer.pid || exclude.start !== start)) {
          const identity = { id: answer.instanceId, pid: answer.pid, start };
          if (stillLive(identity)) return identity;
        }
      }
      await briefly();
    } while (Date.now() < deadline);
    throw new Error("the hosted Manager did not answer");
  };
  const key = createHash("sha256").update(JSON.stringify([realpathSync(ctx.entry), process.getuid?.(), ctx.space])).digest("hex");
  const lineage = join(ctx.home, ".cotal", "seats", `p-${key}`);
  const store = join(ctx.home, ".cotal", "seats", "host-runtime");
  const cleanupClosure = (path: string) => {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) cleanupClosure(join(path, entry.name));
  };
  const findRoot = (): string => {
    const roots = readdirSync(lineage).filter(name => /^[0-9a-f]{64}$/.test(name));
    assert.equal(roots.length, 1, "one retained generation owns this hosted Manager's new PTYs");
    return join(lineage, roots[0]!);
  };
  const known: Lifetime[] = [];
  const units = new Set<string>();
  const readHost = (root: string) => {
    const host = JSON.parse(readFileSync(join(root, "host.json"), "utf8")) as Omit<HostedUnit, "cgroup">;
    units.add(scopeFromRecord(host));
    known.push(host);
    return host;
  };
  const receipts = new Set<string>();
  const readSeat = (receipt: string): HostedSeat => {
    const seat = JSON.parse(readFileSync(receipt, "utf8")) as HostedSeat;
    known.push(seat.child);
    if (seat.descendant) known.push(seat.descendant);
    return seat;
  };
  const launch = async (manager: string, name: string): Promise<HostedSeat> => {
    const receipt = join(ctx.project, "..", `${name}.json`);
    receipts.add(receipt);
    hostedCli(ctx, ["spawn", "--agent", "shared-pty-smoke", "--name", name, "--space", ctx.space, "--on", manager, "--detach", "--no-events"]);
    for (let i = 0; i < 50 && !existsSync(receipt); i++) await briefly();
    return readSeat(receipt);
  };
  const launchPair = async (label: string): Promise<HostedPair> => {
    const manager = await getManager();
    const names = [1, 2].map(n => `${label}_${n}`);
    const seats: HostedSeat[] = [];
    for (const name of names) seats.push(await launch(manager.id, name));
    const root = findRoot(), record = readHost(root);
    const cgroup = userUnits(ctx, ["show", "--property=ControlGroup", "--value", record.scope]);
    const uid = process.getuid?.();
    const tag = createHash("sha256").update(JSON.stringify([realpathSync(ctx.entry), uid, join(ctx.home, ".cotal")])).digest("hex");
    assert.ok(record.scope.startsWith(`cotal-pty-${tag.slice(0, 16)}`), record.scope);
    assert.equal(cgroup, `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${record.scope}`);
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    assert.equal(userUnits(ctx, ["show", "--property=Description", "--value", record.scope]), `Cotal shared PTY ${tag} p-${key} ${manager.pid} ${manager.start} ${bootId}`);
    const host = { ...record, cgroup };
    assert.equal(processStartToken(host.pid), host.start);
    assert.equal(userUnits(ctx, ["show", "--property=MainPID", "--value", host.scope]), String(host.pid));
    const records = readdirSync(root).filter(id => /^[0-9a-f]{32}$/.test(id) && existsSync(join(root, id, "shared.json"))).map(id =>
      JSON.parse(readFileSync(join(root, id, "shared.json"), "utf8")) as { childPid: number; childStart: string; custodianPid: number });
    const memberships = seats.map(({ child, descendant }) => {
      assert.ok(records.some(row => row.childPid === child.pid && row.childStart === child.start && row.custodianPid === host.pid));
      assert.ok(descendant && stillLive(child) && stillLive(descendant));
      assert.equal(processStatFields(descendant.pid)?.[3], String(descendant.pid), "the descendant started a separate session");
      const membership = readFileSync(`/proc/${child.pid}/cgroup`, "utf8").trim();
      assert.ok(membership.startsWith(`0::${cgroup}/`));
      assert.match(membership.slice(`0::${cgroup}/`.length), /^seat-[a-f0-9]{32}$/);
      assert.equal(readFileSync(`/proc/${descendant.pid}/cgroup`, "utf8").trim(), membership);
      return membership;
    });
    assert.equal(new Set(memberships).size, 2, "the two seats occupy separate cgroups");
    assert.deepEqual(hostedInventory(ctx, manager.id).filter(row => names.includes(row.name) && row.status === "running").map(row => row.name).sort(), names);
    return { manager, host, names, rows: seats.flatMap(seat => [seat.child, seat.descendant!]) };
  };
  const managerCrash = async (cell: HostedPair, crash: "manager" | "daemon") => {
    const previous = cell.manager;
    assert.ok(stillLive(previous));
    if (crash === "manager") process.kill(previous.pid, "SIGKILL");
    else {
      await killAndAwaitExit(ctx.daemon(), "SIGKILL");
      await ctx.start();
    }
    const successor = await getManager(previous);
    assertGone([previous, cell.host, ...cell.rows], `${crash} death must end the predecessor and its hosted lifetimes before the successor answers`);
    assert.ok(unitGone(ctx, cell.host), `${cell.host.scope} is still running when the successor answers`);
    assert.ok(hostedInventory(ctx, successor.id).every(row => !cell.names.includes(row.name)), "successor inventory has no predecessor seats");
  };
  try {
    await managerCrash(await launchPair("manager_death"), "manager");
    await managerCrash(await launchPair("daemon_death"), "daemon");
    const third = await launchPair("host_death");
    await proveUnresponsiveHost(ctx, third);
    assert.ok(stillLive(third.host));
    process.kill(third.host.pid, "SIGKILL");
    await waitGone([third.host, ...third.rows]);
    await waitUnitGone(ctx, third.host);
    await waitHostCrashInventory(ctx, third.manager.id, third.names);
    const fourth = await launchPair("ordinary_stop");
    await proveUpdateWithHeldPty(ctx, fourth, run);
    await assert.rejects(managerViaDaemon({ paths: ctx.paths }, { op: "managers-prepare-restart" }), /SEATS_ACTIVE/);
    assert.ok(fourth.rows.every(stillLive), "generation preparation kept both live PTYs");
    await managerViaDaemon({ paths: ctx.paths }, { op: "managers-stop" });
    assertGone([fourth.host, ...fourth.rows], "the explicit hosted Managers stop ended host, seats and descendants");
    assert.ok(unitGone(ctx, fourth.host), `${fourth.host.scope} is still running after explicit stop`);
    await proveDeadParentFallback(ctx, store, getManager, launch);
    await provePublicHostedStops(ctx, launchPair);
    const copy = readdirSync(store).find(name => /^[a-f0-9]{64}$/.test(name));
    assert.ok(copy, "a real runtime copy remains after teardown");
    assert.equal(statSync(join(store, copy)).mode & 0o777, 0o500, "the runtime copy is read-only before documented removal");
    for (const [file, args] of [["chmod", ["-R", "u+w", store]], ["rm", ["-rf", store]]] as const) {
      const removed = spawnSync(file, [...args], { env: ctx.env, encoding: "utf8", timeout: 5_000 });
      assert.equal(removed.status, 0, `${file}: ${removed.stderr}`);
    }
    assert.equal(existsSync(store), false, "the two documented commands remove the closed shared runtime");
    console.log("Hosted shared PTY: Manager and daemon SIGKILL, dead-parent fallback teardown, stopped host, host crash and explicit hosted Managers stop verified");
    console.log("Hosted shared PTY standalone stop cases skipped: the remote-participant fixture has no standalone Manager service or local stack journal for `cotal manager stop` or `cotal down`");
  } finally {
    if (existsSync(lineage)) for (const name of readdirSync(lineage).filter(name => /^[0-9a-f]{64}$/.test(name))) {
      const root = join(lineage, name);
      for (const file of ["host.json", "execution.json"]) {
        const path = join(root, file);
        if (existsSync(path)) units.add(scopeFromRecord(JSON.parse(readFileSync(path, "utf8"))));
      }
      if (existsSync(join(root, "host.json"))) readHost(root);
    }
    for (const receipt of receipts) if (existsSync(receipt)) readSeat(receipt);
    for (const unit of units) if (userUnits(ctx, ["list-units", "--no-legend", "--plain", unit])) userUnits(ctx, ["stop", unit]);
    for (const row of known) {
      const stat = processStatFields(row.pid);
      if (stat && stat[19] === row.start && !["Z", "X"].includes(stat[0]!)) {
        try { process.kill(row.pid, "SIGKILL"); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
      }
    }
    await waitGone(known);
    if (existsSync(store)) { cleanupClosure(store); rmSync(store, { recursive: true, force: true }); }
  }
}

// A version change prints the wait once across the parent and its reconcile child: the child
// waits without printing, because a current parent prints. A current install has only the tail wait.
{
  for (const newer of [true, false]) {
    const globalPrefix = join(root, `count-${newer}`);
    const globalModules = join(globalPrefix, "lib", "node_modules");
    mkdirSync(globalModules, { recursive: true, mode: 0o700 });
    const lines: string[] = [];
    const say = (line: string) => { if (line.includes("waiting up to") || line.includes("service is")) lines.push(line); };
    const child = async (env: NodeJS.ProcessEnv) => {
      const prior = console.log;
      console.log = (line?: unknown) => say(String(line));
      const currentParent = currentParentWaits(env, process.pid, true);
      try {
        await waitForInstalledDaemonGeneration("0.13.2", {
          installed: () => true, timeoutMs: 1_000, quiet: currentParent,
          query: (async () => status("0.13.2")) as NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"],
        });
      } finally { console.log = prior; }
      return { status: 0, stdout: "", stderr: "" };
    };
    const rt: UpdateRuntime = {
      ...updateRuntime, env: {}, pid: process.pid, version: () => "0.13.1", checkout: () => false, installPrefix: () => globalPrefix,
      reportRunningManager: async () => "none", reconcile: async () => {}, refreshConnectors: async () => {}, refreshClients: async () => [],
      extensions: () => [], claimUpdatePass: () => () => {}, claimGlobalUpdate: () => () => {},
      verifyGlobalEntry: (_r, v) => join(globalModules, `cotal-${v}.js`),
      npm: args => args[0] === "view" ? { status: 0, stdout: newer ? '"0.13.2"' : '"0.13.1"', stderr: "" } : args[0] === "root" ? { status: 0, stdout: `${globalModules}\n`, stderr: "" } : { status: 0, stdout: "", stderr: "" },
      npmAsync: async args => {
        const spec = args[1]!;
        const v = spec.slice(spec.lastIndexOf("@") + 1);
        return { status: 0, stdout: JSON.stringify({ name: "cotal-ai", version: v, dist: { tarball: "https://registry.example/p.tgz", integrity: "sha512-x" }, dependencies: {} }), stderr: "" };
      },
      spawnGlobal: async (_r, op, _f, _a, env) => op === "reconcile" && env.COTAL_UPDATE_PARENT ? child(env) : { status: 0, stdout: "", stderr: "" },
      waitForInstalledGeneration: async () => { say("machine daemon: waiting up to 120s"); },
      out: say, err: say,
    };
    await update({ values: { self: true }, positionals: [] } as never, rt);
    if (rt.generationWaited !== true) say("machine daemon: waiting up to 120s");
    assert.equal(lines.filter(line => line.includes("waiting up to")).length, 1, newer ? "parent and child print the wait once" : "a current install prints the wait once");
  }
}

// A parent from before the marker binds its child the same way and never waits after it. Its child
// keeps the line: the update from 0.164.10 otherwise waits up to 120 s without saying so.
{
  const olderParent = { COTAL_UPDATE_PARENT: String(process.pid) };
  assert.equal(currentParentWaits(olderParent, process.pid, true), false, "a child of an older parent is not quiet");
  assert.equal(currentParentWaits({ ...olderParent, COTAL_UPDATE_PARENT_WAITS: "1" }, process.pid, true), true, "a child of a waiting parent is quiet");
  assert.equal(currentParentWaits({ ...olderParent, COTAL_UPDATE_PARENT_WAITS: "1" }, process.pid + 1, true), false, "the marker of another process does not quiet this child");
  const lines: string[] = [];
  const prior = console.log;
  console.log = (line?: unknown) => { lines.push(String(line)); };
  try {
    await waitForInstalledDaemonGeneration("0.13.2", {
      installed: () => true, timeoutMs: 1_000, quiet: currentParentWaits(olderParent, process.pid, true),
      query: (async () => status("0.13.2")) as NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"],
    });
  } finally { console.log = prior; }
  assert.equal(lines.filter(line => line.includes("waiting up to")).length, 1, "the child of an older parent prints the wait once");
}

// A quiet child's refused wait keeps the progress line its parent will never reach.
for (const ownership of [false, true]) {
  const lines: string[] = [];
  const prior = console.log;
  console.log = (line?: unknown) => { lines.push(String(line)); };
  const refusal = new EndpointRefusal("PEER_UID_MISMATCH", "another user answers");
  try {
    await assert.rejects(waitForInstalledDaemonGeneration("2.0.0", {
      installed: () => true, quiet: true, timeoutMs: 50,
      query: scripted([ownership ? refusal : status("1.0.0")]).query,
    }), ownership ? error => error === refusal : /did not become ready/);
  } finally { console.log = prior; }
  assert.deepEqual(lines, ["machine daemon: waiting up to 0s for Cotal 2.0.0 and its hosted Managers before the continuity check"], "a quiet refusal prints exactly the suppressed wait line");
}

// A stale recorded service is knowable before either replacement or connector writes.
for (const self of [true, false]) {
  const state = join(root, `stale-${self}`);
  mkdirSync(state, { mode: 0o700 });
  const paths = { state, lock: join(state, "lock"), socket: join(state, "socket") };
  writeFileSync(unitReceiptFile(paths), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath: join(state, "gone.service"), unitSha256: "stale", installedAt: "2026-11-12" }));
  const effects: string[] = [], errors: string[] = [];
  const preflight = { preflightReplacement: async () => { preflightInstalledDaemon(paths); } };
  const rt: UpdateRuntime = {
    ...updateRuntime, ...preflight, env: {}, version: () => "0.13.1",
    reportRunningManager: async () => "none",
    reconcile: async () => { effects.push("reconcile"); },
    refreshConnectors: async () => {}, refreshClients: async () => [], extensions: () => [], claimUpdatePass: () => () => {},
    npm: args => {
      // Only latest-tag discovery precedes the preflight on the self path.
      if (args[0] === "view" && args[1] === "cotal-ai@latest") return { status: 0, stdout: '"0.13.2"', stderr: "" };
      effects.push("registry or install");
      return { status: 1, stdout: "", stderr: "unexpected registry work" };
    },
    out: () => {}, err: line => { errors.push(line); },
  };
  assert.equal(await executeUpdate(self, rt), 1);
  assert.deepEqual(effects, [], "stale receipt refuses before registry closure checks, package replacement or reconciliation");
  assert.match(errors.join("\n"), /recorded unit file .*gone/);
}

// Receipt validation never treats malformed state as absent, and leaves other installs alone.
{
  const state = join(root, "receipts", "daemon");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const paths = { state, lock: join(state, "lock"), socket: join(state, "socket") };
  assert.equal(preflightInstalledDaemon({ state }), false);
  writeFileSync(unitReceiptFile(paths), "not json");
  assert.throws(() => preflightInstalledDaemon(paths), /no installed unit recorded/);
  if (process.platform === "linux") {
    const native = join(root, "native"), config = join(root, "config"), directory = join(config, "systemd", "user");
    mkdirSync(native, { mode: 0o700 });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '--user show-environment') process.exit(99);\nconsole.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});\n`, { mode: 0o700 });
    const priorPath = process.env.PATH, priorEntry = process.argv[1], priorExecArgv = process.execArgv, priorHome = process.env.COTAL_HOME;
    process.execArgv = [];
    process.argv[1] = fileURLToPath(new URL("../cotal.ts", import.meta.url));
    process.env.PATH = `${native}:${priorPath}`;
    process.env.COTAL_HOME = join(root, "receipts");
    try {
      const foreign = join(root, "other");
      mkdirSync(foreign, { mode: 0o700 });
      for (const file of ["node", "cotal.js"]) writeFileSync(join(foreign, file), "");
      const source = `ExecStart="${join(foreign, "node")}" "${join(foreign, "cotal.js")}" daemon serve\n`;
      const unitPath = join(directory, "cotal-daemon.service");
      writeFileSync(unitPath, source, { mode: 0o600 });
      const receipt = { v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: "2026-11-12" };
      writeFileSync(unitReceiptFile(paths), JSON.stringify(receipt));
      assert.equal(installedDaemonIdentity(paths).same, false);
      assert.equal(preflightInstalledDaemon({ state }), true);
      const priorReconcile = process.env.COTAL_INSTALL_RECONCILE;
      process.env.COTAL_INSTALL_RECONCILE = "1";
      const priorLauncher = process.env.COTAL_LAUNCHER, priorPrefix = process.env.npm_config_prefix;
      const shellRoot = join(root, "shell");
      const shellEntry = join(shellRoot, "lib/node_modules/cotal-ai/dist/cotal.js");
      mkdirSync(join(shellRoot, "lib/node_modules/cotal-ai/dist"), { recursive: true });
      writeFileSync(join(shellRoot, "lib/node_modules/cotal-ai/package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "dist/cotal.js" } }));
      writeFileSync(shellEntry, "");
      const oldEntry = process.argv[1];
      process.env.COTAL_LAUNCHER = "1";
      process.env.npm_config_prefix = shellRoot;
      process.argv[1] = shellEntry;
      writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nif(process.argv.includes('show-environment')) console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});\n`, { mode: 0o700 });
      try {
        const missing = `Environment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${shellRoot}/runtime/removed/bin/node" "${shellEntry}" daemon serve\n`;
        const save = (text: string) => {
          writeFileSync(unitPath, text);
          writeFileSync(unitReceiptFile(paths), JSON.stringify({ ...receipt, unitSha256: createHash("sha256").update(text).digest("hex") }));
        };
        save(missing);
        delete process.env.COTAL_INSTALL_RECONCILE;
        reconcileMissingShellRuntime(paths);
        assert.equal(readFileSync(unitPath, "utf8"), missing, "ordinary update does not rewrite runtime identity");
        process.env.COTAL_INSTALL_RECONCILE = "1";
        const unmarked = missing.replace("Environment=COTAL_DAEMON_NATIVE_SERVICE=1\n", "");
        save(unmarked);
        reconcileMissingShellRuntime(paths);
        assert.equal(readFileSync(unitPath, "utf8"), unmarked, "unmarked source is not adopted");
        const oldNode = join(shellRoot, "runtime/removed/bin/node");
        mkdirSync(join(shellRoot, "runtime/removed/bin"), { recursive: true });
        writeFileSync(oldNode, "retained runtime");
        save(missing);
        reconcileMissingShellRuntime(paths);
        assert.equal(readFileSync(unitPath, "utf8"), missing, "existing runtime is not replaced");
        rmSync(oldNode);
        reconcileMissingShellRuntime(paths);
        assert.equal(installedDaemonIdentity(paths).same, true, "missing same-entry shell runtime is rebound to this Node");
        assert.ok(!readFileSync(unitPath, "utf8").includes("runtime/removed"));
        writeFileSync(unitPath, missing);
        assert.throws(() => reconcileMissingShellRuntime(paths), /not the unit this daemon installed/, "edited native source is never adopted");
        writeFileSync(unitPath, source);
        writeFileSync(unitReceiptFile(paths), JSON.stringify(receipt));
        reconcileMissingShellRuntime(paths);
        assert.equal(readFileSync(unitPath, "utf8"), source, "foreign entry is untouched");
      } finally {
        if (priorReconcile === undefined) delete process.env.COTAL_INSTALL_RECONCILE; else process.env.COTAL_INSTALL_RECONCILE = priorReconcile;
        process.argv[1] = oldEntry;
        if (priorLauncher === undefined) delete process.env.COTAL_LAUNCHER; else process.env.COTAL_LAUNCHER = priorLauncher;
        if (priorPrefix === undefined) delete process.env.npm_config_prefix; else process.env.npm_config_prefix = priorPrefix;
      }
      for (const currentParent of [false, true]) {
        const lines: string[] = [];
        const priorLog = console.log;
        console.log = (line?: unknown) => { lines.push(String(line)); };
        const oldParent = { COTAL_UPDATE_PARENT: String(process.pid) };
        try {
          await waitForInstalledDaemonGeneration("0.13.2", {
            quiet: currentParentWaits({ ...oldParent, ...(currentParent ? { COTAL_UPDATE_PARENT_WAITS: "1" } : {}) }, process.pid, true),
            query: (async () => { throw new Error("another installation must never be queried"); }) as NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"],
          });
          if (currentParent) await waitForInstalledDaemonGeneration("0.13.2", {
            query: (async () => { throw new Error("another installation must never be queried"); }) as NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"],
          });
        } finally { console.log = priorLog; }
        assert.equal(lines.filter(line => line.includes("the background service belongs to another Cotal installation")).length, 1,
          currentParent ? "the marked child and parent report another installation once" : "the child of an older parent keeps the other installation fact");
        assert.ok(lines.includes(`machine daemon: the background service belongs to another Cotal installation (${join(foreign, "cotal.js")}). This update did not start or stop it.`));
      }
      writeFileSync(unitReceiptFile(paths), JSON.stringify({ ...receipt, unitPath: join(state, "outside.service") }));
      writeFileSync(join(state, "outside.service"), source, { mode: 0o600 });
      assert.throws(() => preflightInstalledDaemon(paths), (error: Error & { remedy?: string }) => {
        assert.match(error.message, /does not name this daemon home's unit/);
        assert.ok(error.remedy?.includes(unitReceiptFile(paths)));
        assert.match(error.remedy!, /remove only.*daemon install.*daemon uninstall/);
        return true;
      });
    } finally { process.env.PATH = priorPath; process.env.COTAL_HOME = priorHome; process.argv[1] = priorEntry!; process.execArgv = priorExecArgv; }
  }
}

// Platform lifecycle observation shares the existing wait deadline and always releases its pin.
for (const fail of [false, true]) {
  const order: string[] = [];
  const started = Date.now();
  const waiting = waitForInstalledDaemonGeneration("2.0.0", {
    installed: () => true, timeoutMs: 1000,
    lifecycle: async (paths, deadline) => {
      assert.ok(paths.socket);
      assert.ok(deadline >= started && deadline <= Date.now() + 1000);
      return { async poll(remaining) { order.push("poll"); assert.ok(remaining > 0 && remaining <= 1000); if (fail) throw new Error("native lifecycle refused"); }, close() { order.push("close"); } };
    },
    query: (async () => { order.push("query"); return status("2.0.0"); }) as NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"],
  });
  if (fail) await assert.rejects(waiting, /native lifecycle refused/);
  else await waiting;
  assert.deepEqual(order, fail ? ["poll", "close"] : ["poll", "query", "close"]);
}

// A disabled or foreign stopped service returning false from lifecycle.poll stops waiting without querying the socket.
{
  const order: string[] = [];
  await waitForInstalledDaemonGeneration("2.0.0", {
    installed: () => true, timeoutMs: 1000,
    lifecycle: async () => ({
      async poll() { order.push("poll-stop"); return false; },
      close() { order.push("close"); },
    }),
    query: (async () => { order.push("query"); return status("2.0.0"); }) as NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"],
  });
  assert.deepEqual(order, ["poll-stop", "close"], "disabled or foreign stopped service returns without querying the daemon socket");
}

// Failed readiness rolls the package back. A deliberately deferred native activation keeps the verified software.
for (const outcome of ["not-ready", "reconcile-failed", "activation-deferred"] as const) {
  const cellRoot = join(root, outcome);
  const globalPrefix = join(cellRoot, "global");
  const globalModules = join(globalPrefix, "lib", "node_modules");
  mkdirSync(globalModules, { recursive: true, mode: 0o700 });
  const priorHome: string | undefined = process.env.HOME;
  const priorCotal: string | undefined = process.env.COTAL_HOME;
  const priorXdg: string | undefined = process.env.XDG_CONFIG_HOME;
  process.env.HOME = join(cellRoot, "user-home");
  process.env.COTAL_HOME = join(cellRoot, "cotal-home");
  process.env.XDG_CONFIG_HOME = join(cellRoot, "xdg-config");
  for (const dir of [process.env.HOME, process.env.COTAL_HOME, process.env.XDG_CONFIG_HOME]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    let reconcileCalls = 0;
    const waits: string[] = [], errors: string[] = [], output: string[] = [];
    const partial = "cotal-ai@0.13.2 reconciled, but the machine daemon still runs Cotal 0.13.1";
    const rt: UpdateRuntime = {
      ...updateRuntime,
      env: {},
      version: () => "0.13.1",
      checkout: () => false,
      installPrefix: () => globalPrefix,
      reportRunningManager: async () => "none",
      reconcile: async () => {},
      refreshConnectors: async () => {}, refreshClients: async () => [],
      extensions: () => [],
      claimUpdatePass: () => () => {},
      claimGlobalUpdate: () => () => {},
      verifyGlobalEntry: (_r, v) => join(globalModules, `cotal-${v}.js`),
      npm: args => args[0] === "view" ? { status: 0, stdout: '"0.13.2"', stderr: "" } : args[0] === "root" ? { status: 0, stdout: `${globalModules}\n`, stderr: "" } : { status: 0, stdout: "", stderr: "" },
      npmAsync: async args => {
        const spec = args[1]!;
        const v = spec.slice(spec.lastIndexOf("@") + 1);
        return { status: 0, stdout: JSON.stringify({ name: "cotal-ai", version: v, dist: { tarball: "https://registry.example/p.tgz", integrity: "sha512-x" }, dependencies: {} }), stderr: "" };
      },
      spawnGlobal: async (_r, op) => {
        if (op === "reconcile" && ++reconcileCalls === 1 && outcome === "reconcile-failed") return { status: 1, stdout: "", stderr: "transient reconcile error" };
        return { status: 0, stdout: "", stderr: "" };
      },
      waitForInstalledGeneration: async v => {
        waits.push(v);
        if (outcome === "activation-deferred") return partial;
        if (v === "0.13.2") throw new Error("installed Cotal 0.13.2 did not become ready");
      },
      out: line => { output.push(line); },
      err: line => { errors.push(line); },
    };
    assert.equal(await executeUpdate(true, rt), 1);
    if (outcome === "activation-deferred") {
      assert.equal(reconcileCalls, 1, "a partial result does not roll back verified software");
      assert.deepEqual(waits, ["0.13.2"]);
      assert.deepEqual(errors, [partial]);
      assert.ok(!output.some(line => line.includes("installed globally and reconciled")));
      assert.equal(JSON.parse(readFileSync(join(process.env.COTAL_HOME, "update-attempt.json"), "utf8")).result, partial);
      assert.equal(JSON.parse(readFileSync(join(process.env.COTAL_HOME, "update-recovery.json"), "utf8")), null);
    } else {
      assert.deepEqual(waits, ["0.13.2", "0.13.1"], "parent requires daemon readiness at 0.13.2 and verifies restored 0.13.1");
      assert.ok(errors.some(line => line.includes("cotal-ai@0.13.1 was restored and reconciled")), errors.join("\n"));
    }
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorCotal === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = priorCotal;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
  }
}

emitSentinel({ passed: counted.cells(), failed: 0 });
