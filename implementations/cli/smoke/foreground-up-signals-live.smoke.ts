/** Actual CLI foreground signal regression. Uses a private home/root and an allocated loopback
 * port and retains the sandbox and logs. The pending-launch cell uses a local application stub.
 * No source or process identity guard is replaced. POSIX process-group signals model terminal Ctrl-C.
 * Ready static stacks are probed through public status/ps. A bounded startup-refusal cell suspends
 * only its pinned manager before natural capability publication and always resumes it for cleanup.
 * A manager killed before readiness, without a stop request, must still report a degraded startup.
 * A controller-route cell checks the refusal from a competing `up` while the foreground start holds
 * the startup lock, then interrupts the start. Another interrupts it as it writes its start receipt.
 * A foreground `team boot` gets SIGTERM at the broker's readiness announcement.
 * A static foreground `team boot` gets SIGINT while delivery is starting, then waits for a pending launch.
 * Another cell cuts a ready stack's stop as a closed terminal
 * does. A third shows that a second foreground `up` refuses while one holds the stack, and that one
 * over a stack whose holder was killed says it takes the running stack over before a signal stops it.
 * A hangup cell sends SIGHUP to a ready foreground `up`: it exits 129, names `cotal down`, leaves the
 * broker running and removes its hold record, and the next `down --yes` stops the stack.
 * A broker crash releases a controller foreground hold with a failed exit and prints a repair
 * command that keeps a broker-only stack broker-only.
 * A legacy foreground stop exits 130 on SIGINT and 143 on SIGTERM.
 * An external `down --yes` stops a named or folder-named legacy stack without a crash diagnostic.
 * Run: pnpm smoke:foreground-up-signals:live */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recordsBucket } from "@cotal-ai/core";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, isCommandFailure, MANAGER_PIDFILE, MANAGER_SPARE_CAPABILITY, readManagerName, shellPath, spaceKey, verifyIdentityPin, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { finishOwnedChild, observeOwnedChild, ownedBirthLive as live, waitForOwnedChild } from "./_foreground-owned-child.js";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";
import { observeServiceProcess, serviceInstances } from "../src/lib/service-instances.js";
import { readStackJournal } from "../src/lib/stack-journal.js";
import { checkInheritedPipeCleanup } from "./_foreground-pipe-fixture.js";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") {
  console.log("SKIP foreground-up-signals: POSIX terminal process groups do not apply on Windows");
  process.exit(0);
}
const wt = resolve(import.meta.dirname, "../../..");
const cliEntry = join(wt, "bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
const base = mkdtempSync(join(tmpdir(), "cotal-foreground-signals-"));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COTAL_|CLAUDE_|ANTHROPIC_|OPENAI_|JCODE_)/i.test(k)));
let passed = 0;

function portOpen(port: number): Promise<boolean> {
  return new Promise((r) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); r(value); };
    socket.once("connect", () => done(true)); socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}
async function until(test: () => boolean | Promise<boolean>, ms: number, detail: () => string, interval = 20): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await sleep(interval); }
  throw new Error(`foreground signal wait expired: ${detail()}`);
}
function token(path: string): ProcessIdentityRecord | undefined {
  if (!existsSync(path)) return undefined;
  const pin = verifyIdentityPin(path);
  return pin.kind === "match" ? pin.record : undefined;
}

function controllerBroker(space: string, machine: string) {
  const previousHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = machine;
  try { return serviceInstances(space, "stack-broker")[0]?.record.value; }
  finally { if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome; }
}

async function checkStoppedPreview(mesh: string, env: NodeJS.ProcessEnv, space: string, port: number): Promise<void> {
  const cleared = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["use", "--clear"]);
  assert.equal(cleared.code, 0, cleared.out + cleared.err);
  const preview = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["spawn", "--dry-run", "--json"]);
  assert.equal(preview.code, 0, preview.out + preview.err);
  const { target, result } = JSON.parse(preview.out);
  assert.deepEqual(target, { space, broker: null, authMode: null });
  assert.equal(result.kind, "direct-launch-preview");
  assert.equal(result.persona.path, join(mesh, ".cotal", "agents", "default.md"));
  assert.equal(result.persona.write, "none");
  assert.equal(result.authorization, "not-checked");
  assert.equal(result.connectorAvailability, "not-checked");
  assert.equal(result.allocated, false);
  assert.equal(result.launched, false);
  assert.equal(await portOpen(port), false, "the offline preview kept the broker stopped"); passed++;
}

async function checkStoppedRestartAdvice(mesh: string, env: NodeJS.ProcessEnv, port: number): Promise<void> {
  const inspect = (command: string) => foregroundCliProbe(cliEntry, tsx, mesh, env, [command, "--plain"], 60_000);
  const check = async (diagnosis: string, remedy: string, alternative?: string) => {
    for (const command of ["status", "ps"]) {
      const result = await inspect(command), text = result.out + result.err;
      assert.equal(result.code, command === "status" ? 0 : 2, text);
      assert.ok(text.includes(diagnosis) && text.includes(remedy), text);
      if (alternative) assert.ok(text.includes(alternative), text);
      assert.doesNotMatch(text, /start it again with `[^`]*\bcotal up` in/);
    }
    passed++;
  };
  const listener = createServer((socket) => { socket.on("error", () => {}); socket.end("not NATS\n"); });
  await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(port, "127.0.0.1", resolve));
  try {
    await check(`another process holds the broker address 127.0.0.1:${port}`, `stop the process listening on 127.0.0.1:${port}`, "up --server nats://127.0.0.1:<port>");
    assert.ok(await portOpen(port), "read commands leave the unrelated listener running");
  } finally { await new Promise<void>((resolve) => listener.close(() => resolve())); }

  const seed = join(mesh, ".cotal", "channels.json");
  writeFileSync(seed, '{"channels":');
  try {
    await check(`the channels file ${seed} is not valid JSON`, `fix or remove ${seed}`);
    assert.equal(readFileSync(seed, "utf8"), '{"channels":');
    assert.equal(await portOpen(port), false, "read commands do not start a broker");
  } finally { rmSync(seed); }
  for (const command of ["status", "ps"]) {
    const result = await inspect(command);
    assert.match(result.out + result.err, /start it again with `[^`]*\bcotal up` in/);
  }
}

async function checkStoppedOpenDiagnosis(mesh: string, env: NodeJS.ProcessEnv, space: string, port: number): Promise<void> {
  const config = join(mesh, ".cotal", "server-open.conf");
  const original = readFileSync(config);
  const journal = join(mesh, ".cotal", "stack-controller.json");
  const diagnose = (...args: string[]) => foregroundCliProbe(cliEntry, tsx, mesh, env, ["doctor", "auth", ...args]);
  assert.equal(existsSync(journal), false, "foreground up has no controller journal");
  for (const flags of [[], ["--space", space, "--fix"]]) {
    const plain = await diagnose(...flags, "--plain");
    assert.equal(plain.code, 0, plain.out + plain.err);
    assert.match(plain.out, /No credentials to check/);
    assert.match(plain.out, /Mode:\s+open, as recorded/);
    const json = await diagnose(...flags, "--json");
    assert.equal(json.code, 0, json.out + json.err);
    const report = JSON.parse(json.out);
    assert.equal(report.outcome, "no-op");
    assert.deepEqual(report.target, { root: realpathSync(mesh), space });
    assert.equal(report.result.credentialScope, "open-space");
    assert.equal(report.result.brokerAuthorization, "not-checked");
    assert.equal(report.result.repair.attempted, false);
    passed++;
  }
  const wrong = await diagnose("--space", "another-open-space", "--json");
  assert.equal(wrong.code, 2, wrong.out + wrong.err);
  assert.equal(JSON.parse(wrong.out).error.code, "AUTH_REQUIRED");
  renameSync(config, `${config}.saved`);
  try {
    for (const [flags, code] of [[[], 4], [["--space", space], 2]] as const) {
      const missing = await diagnose(...flags, "--plain");
      assert.equal(missing.code, code, missing.out + missing.err);
      assert.ok((missing.out + missing.err).includes(config), missing.out + missing.err);
      assert.doesNotMatch(missing.out + missing.err, /root folder|space create|No credentials to check/);
      passed++;
    }
    assert.equal(existsSync(config), false, "doctor does not recreate the broker configuration");
  } finally { renameSync(`${config}.saved`, config); }
  assert.deepEqual(readFileSync(config), original, "doctor leaves the retained broker record alone");
  assert.equal(existsSync(journal), false, "doctor does not prepare a stack");
  assert.equal(await portOpen(port), false, "doctor does not restart the broker");
  assert.equal(existsSync(join(env.COTAL_HOME!, "meshes", `space.${spaceKey(space)}.json`)), false, "doctor does not register the space");
  passed++;
}

async function cell(name: string, options: { auth?: boolean; ready?: boolean; refusal?: boolean; managerCrash?: boolean; signal?: "SIGINT" | "SIGTERM"; twice?: boolean; crash?: boolean; nativeLog?: boolean; externalDown?: "named" | "folder"; repairDelivery?: boolean; openBrokerExit?: boolean; openManagerExit?: boolean }): Promise<boolean> {
  const root = join(base, name), home = join(root, "home"), folderNamed = options.externalDown === "folder" || options.openManagerExit;
  const mesh = join(root, folderNamed ? name : "mesh"), store = join(mesh, "store");
  for (const p of [root, home, mesh, ...(options.nativeLog ? [] : [join(mesh, ".cotal")]), join(home, "xdg"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const sandbox = options.nativeLog ? undefined : recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
  const rootIdentity = statSync(mesh, { bigint: true });
  const markerIdentity = statSync(join(mesh, ".cotal"), { bigint: true, throwIfNoEntry: false });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = folderNamed ? name : `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const logFile = join(mesh, "broker.log");
  if (options.repairDelivery) {
    // Make the spawn suggestion available without installing or launching a harness.
    const extensions = join(env.XDG_CONFIG_HOME, "cotal", "extensions");
    mkdirSync(extensions, { recursive: true, mode: 0o700 });
    writeFileSync(join(extensions, "extensions.json"), JSON.stringify({ extensions: [{
      pkg: "@fixture/status", version: "1.0.0", spec: "@fixture/status@1.0.0", commands: [],
      provides: [{ kind: "connector", name: "status-fixture" }],
      connectors: [{ name: "status-fixture", requires: ["node"], eventPlane: false, setup: null }],
    }] }), { mode: 0o600 });
  }
  const args = ["--import", tsx, cliEntry, "up", "--foreground", "--server", `nats://127.0.0.1:${port}`, ...(folderNamed ? [] : ["--space", space]), ...(options.auth ? [] : options.openBrokerExit || options.openManagerExit || options.externalDown ? ["--open"] : ["--open", "--no-manager"]), ...(options.openManagerExit || (!options.auth && options.externalDown) ? ["--store-dir", store] : []), ...(options.nativeLog ? ["--log-file", "./broker.log", "--logfile-size-limit", "1048576"] : [])];
  const child: ChildProcess = spawn(process.execPath, args, { cwd: mesh, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", timeline = "";
  child.stdout?.on("data", (b: Buffer) => { const text = b.toString(); out += text; timeline += text; });
  child.stderr?.on("data", (b: Buffer) => { const text = b.toString(); err += text; timeline += text; });
  const state = observeOwnedChild(child);
  const owned = new Map<string, ProcessIdentityRecord>();
  const brokerPath = join(mesh, ".cotal/nats.pid");
  const managerPath = canonicalLocalProcessPath(MANAGER_PIDFILE, { root: mesh, space });
  const deliveryPath = canonicalLocalProcessPath(DELIVERY_PIDFILE, { root: mesh, space });
  const capabilityPath = canonicalLocalProcessPath(MANAGER_SPARE_CAPABILITY, { root: mesh, space });
  let suspended: ProcessIdentityRecord | undefined;
  let refusalBirths: ProcessIdentityRecord[] = [];
  const ownRecords = () => {
    for (const file of [brokerPath, managerPath, deliveryPath]) {
      const row = token(file);
      if (row) owned.set(`${row.pid}:${row.token}`, row);
    }
  };
  try {
    await until(async () => {
      ownRecords();
      if (state.error) throw state.error;
      if (state.exited) throw new Error(`CLI exited before readiness: ${err}`);
      // Normal signal cells wait for postStart's durable registration, not merely a bound socket.
      // The auth cell deliberately interrupts earlier at the natural manager birth record.
      return options.auth ? token(managerPath) !== undefined : token(brokerPath) !== undefined && existsSync(join(home, "machine", "meshes", `space.${spaceKey(space)}.json`)) && await portOpen(port);
    }, 90_000, () => err.slice(-3000), options.refusal || options.managerCrash ? 2 : 20);
    if (options.nativeLog) {
      const config = readFileSync(join(mesh, ".cotal/server-open.conf"), "utf8");
      assert.ok(config.includes(`log_file: ${JSON.stringify(logFile)}`) && config.includes("logfile_size_limit: 1048576"), "fresh foreground config contains native logging and rotation"); passed++;
      assert.equal(statSync(logFile).mode & 0o777, 0o600, "foreground native log is owner-private"); passed++;
      assert.match(readFileSync(logFile, "utf8"), /Server is ready/, "the broker writes readiness to its native log"); passed++;
    }
    if (options.managerCrash) {
      const manager = token(managerPath); assert.ok(manager && live(manager));
      assert.equal(existsSync(capabilityPath), false, "owned manager has not published readiness before the crash");
      if (options.signal) {
        assert.ok(child.pid);
        process.kill(-child.pid, options.signal);
      }
      process.kill(manager.pid, "SIGKILL");
      if (options.signal) {
        await until(() => state.exited, 60_000, () => err.slice(-3000));
        await waitForOwnedChild(() => state.closed, 3_000, `${root}: interrupted startup streams drained`);
        assert.equal(state.code, options.signal === "SIGTERM" ? 143 : 130, "interrupted startup retains its signal exit"); passed++;
        assert.equal(await portOpen(port), false, "interrupted startup closes its broker"); passed++;
        assert.equal([...owned.values()].some(live), false, "interrupted startup leaves no recorded owned process"); passed++;
        assert.doesNotMatch(err, /control plane degraded/, "a startup failure during the guarded stop is not reported as degradation"); passed++;
        console.log(`PASS foreground-up-signals ${name}: manager exit during an interrupted startup is not reported as degradation`);
        return true;
      }
      // The consequence is the last line of the degraded notice on stderr.
      await until(() => err.includes("Spawn and retirement require a functioning control plane.\n"), 20_000, () => err.slice(-3000));
      assert.equal(live(manager), false, "the failed manager's recorded birth is gone"); passed++;
      assert.equal(state.exited, false, "a genuine startup failure does not masquerade as an operator stop"); passed++;
      assert.equal(await portOpen(port), true, "the degraded stack's broker remains running"); passed++;
      assert.match(err, /control plane degraded:.*exited before it came up/); passed++;
      console.log(`PASS foreground-up-signals ${name}: genuine manager startup failure reported before any stop request`);
      return true;
    }
    let refusalBoundary = false;
    if (options.refusal) {
      const manager = token(managerPath); assert.ok(manager && live(manager));
      suspended = manager;
      assert.ok(live(manager), "revalidate exact owned manager before SIGSTOP");
      process.kill(manager.pid, "SIGSTOP");
      // Existence only. Never read, forge, remove or modify the capability.
      refusalBoundary = !existsSync(capabilityPath);
      writeFileSync(join(root, "suspension.json"), JSON.stringify({ manager, naturallyAbsentCapability: refusalBoundary }), { mode: 0o600 });
      if (refusalBoundary) {
        const second = await foregroundCliProbe(cliEntry, tsx, mesh, env, args.slice(3));
        assert.equal(second.code, 2, second.out + second.err); passed++;
        assert.match(second.err, /LIFECYCLE_BLOCKED/); passed++;
        assert.match(second.err.replace(/\s+/g, " "), /the other foreground terminal keeps the stack once startup finishes.* status`/); passed++;
        assert.doesNotMatch(second.err, /run the command again/); passed++;
        const retained = [token(brokerPath), token(deliveryPath), manager];
        assert.ok(retained.every((row) => row && live(row)), "private broker/delivery/manager births live before refusal");
        refusalBirths = retained as ProcessIdentityRecord[];
        const refusals: unknown[] = [];
        for (let attempt = 1; attempt <= 2; attempt++) {
          assert.ok(child.pid); process.kill(-child.pid, "SIGINT");
          await until(() => (err.match(/! teardown: refusing bare manager stop:/g)?.length ?? 0) >= attempt, 20_000, () => err.slice(-3000));
          assert.equal(state.exited, false, "refused Ctrl-C retains foreground owner"); passed++;
          assert.ok(retained.every((row) => row && live(row)) && await portOpen(port), "same pinned stack births and listener retained after refusal"); passed++;
          assert.equal(existsSync(capabilityPath), false, "capability remains naturally absent during suspended refusal"); passed++;
          refusals.push({ attempt, ownerExited: state.exited, retainedBirths: refusalBirths, listenerOpen: true, capabilityAbsent: true });
          writeFileSync(join(root, "refusals.json"), JSON.stringify(refusals), { mode: 0o600 });
          await sleep(30);
        }
        assert.match(err, /down --with-agents/, "refusal prints supported whole-stack reap route"); passed++;
      }
      if (live(manager)) process.kill(manager.pid, "SIGCONT");
      suspended = undefined;
      if (!refusalBoundary) console.log(`INCONCLUSIVE foreground-up-signals ${name}: manager capability already published, no branch manufactured`);
    }
    if (options.ready || options.refusal) {
      const probeLog: unknown[] = [];
      await until(async () => {
        ownRecords();
        if (state.exited) throw new Error(`CLI exited before serving readiness: ${err}`);
        const result = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["status", "--components", "--space", space, "--server", `nats://127.0.0.1:${port}`], 60_000);
        probeLog.push(result);
        writeFileSync(join(root, "readiness.json"), JSON.stringify(probeLog), { mode: 0o600 });
        return ["broker", "manager", "delivery"].every((name) => new RegExp(`^\\s*${name}\\s+serving\\b`, "m").test(result.out));
      }, 90_000, () => `actual component status not serving: ${JSON.stringify(probeLog.at(-1))}`);
      const ps = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["ps", "--space", space, "--server", `nats://127.0.0.1:${port}`]);
      writeFileSync(join(root, "ps.json"), JSON.stringify(ps), { mode: 0o600 });
      assert.equal(ps.code, 0, "fully-ready manager answers actual public ps"); passed++;
      assert.ok(token(managerPath) && token(deliveryPath) && await portOpen(port), "fully-ready exact manager, delivery and listener still present"); passed++;
      console.log(`PASS foreground-up-signals ${name}: public status broker/manager/delivery serving and ps answered`);
    }
    if (options.repairDelivery) {
      const status = () => foregroundCliProbe(cliEntry, tsx, mesh, env, ["status"], 60_000);
      const next = (report: Awaited<ReturnType<typeof status>>) => report.out.split("\nNext\n")[1] ?? "";
      const spawnLine = /^ {2}(?:pnpm )?cotal spawn +/m;
      const broker = token(brokerPath), delivery = token(deliveryPath);
      assert.ok(broker && live(broker) && delivery && live(delivery));
      const before = await status();
      assert.equal(before.code, 0, before.err);
      assert.match(next(before), spawnLine, before.out); passed++;
      process.kill(delivery.pid, "SIGTERM");
      await until(() => !live(delivery), 30_000, () => "Delivery did not exit");
      const stopped = await status();
      assert.equal(stopped.code, 0, stopped.err);
      assert.match(stopped.out, /Delivery responder:.*NOT BOUND/);
      assert.match(next(stopped), /^ {2}(?:pnpm )?cotal up +Restore the delivery responder/);
      assert.doesNotMatch(next(stopped), spawnLine); passed++;
      const repair = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up"], 120_000);
      const repaired = await status();
      assert.equal(repair.code, 0, repair.out + repair.err);
      assert.ok(live(broker), "repair keeps the original broker running");
      assert.match(repaired.out, /Delivery responder:\s+● bound/);
      assert.match(next(repaired), spawnLine); passed++;
    }
    if (options.openBrokerExit || options.openManagerExit) {
      let health: Awaited<ReturnType<typeof foregroundCliProbe>> | undefined;
      const components = () => foregroundCliProbe(cliEntry, tsx, mesh, env, ["status", "--components"], 60_000);
      await until(async () => {
        health = await components();
        return health.code === 0 && /^ {2}manager +serving/m.test(health.out);
      }, 90_000, () => (health?.out ?? "") + (health?.err ?? ""));
      if (options.openManagerExit) {
        const manager = token(managerPath), broker = token(brokerPath);
        assert.ok(manager && live(manager) && broker && live(broker));
        process.kill(manager.pid, "SIGTERM");
        await until(() => !existsSync(managerPath) && !live(manager), 30_000, () => err);
        const inspect = (command: string) => foregroundCliProbe(cliEntry, tsx, mesh, env, [command, "--space", space, "--plain"], 60_000);
        const seed = join(mesh, ".cotal", "channels.json");
        writeFileSync(seed, '{"channels":\n');
        const blocked = await inspect("status");
        assert.equal(blocked.code, 0, blocked.out + blocked.err);
        const blockedNext = blocked.out.split("\nNext\n")[1] ?? "";
        assert.ok(blockedNext.trimStart().startsWith(`Restart blocked: the channels file ${seed} is not valid JSON`), blocked.out);
        assert.ok(blockedNext.includes(`fix or remove ${seed}`), blocked.out);
        assert.doesNotMatch(blockedNext, /^ {2}(?:pnpm )?cotal (?:down|up) +/m);
        assert.ok(live(broker) && await portOpen(port));
        rmSync(seed);
        const status = await inspect("status");
        assert.equal(status.code, 0, status.out + status.err);
        assert.match(status.out, new RegExp(`^  Broker +running.*pid ${broker.pid}`, "m"));
        assert.match(status.out, /^  Manager +stopped$/m);
        const next = status.out.split("\nNext\n")[1] ?? "";
        assert.match(next, /^ {2}(?:pnpm )?cotal up +Restart this folder's manager without stopping the broker/m);
        assert.doesNotMatch(next, /cotal down|cotal up --foreground/);
        const repair = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up"], 120_000);
        ownRecords();
        assert.equal(repair.code, 0, repair.out + repair.err);
        assert.deepEqual(token(brokerPath), broker, "bare up keeps the original broker identity");
        const ps = await inspect("ps");
        assert.equal(ps.code, 0, ps.out + ps.err);
        passed++;

        const downArgs = ["down", "--yes"];
        assertSmokeSandboxDown(sandbox, downArgs, { cwd: mesh, env });
        const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, downArgs, 60_000);
        assert.equal(down.code, 0, down.out + down.err);
        assert.equal(await portOpen(port), false);
        if (process.getuid?.() !== 0) {
          const jetstream = join(store, "jetstream");
          chmodSync(jetstream, 0o500);
          try {
            for (const command of ["status", "ps"]) {
              const report = await inspect(command), text = report.out + report.err;
              assert.equal(report.code, command === "status" ? 0 : 2, text);
              assert.ok(text.includes(`the broker store ${jetstream} is not writable by this account`), text);
              assert.ok(text.includes(`chmod -R u+w ${jetstream}`), text);
              assert.doesNotMatch(text, /there to restart/);
            }
            passed++;
          } finally { chmodSync(jetstream, 0o700); }
        }
        return true;
      }
      const broker = token(brokerPath);
      assert.ok(broker && live(broker));
      process.kill(broker.pid, "SIGTERM");
      await until(() => state.exited, 60_000, () => err.slice(-3000));
      assert.equal(await portOpen(port), false);
      const stopped = await components();
      assert.equal(stopped.code, 1, stopped.out + stopped.err);
      assert.match(stopped.out, /^ {2}manager +absent/m);
      assert.match(stopped.out, /^ {2}broker +absent/m);
      assert.match(stopped.out, /^ {2}delivery +not-started · not used on an open mesh/m); passed++;
      return true;
    }
    if (options.refusal || options.externalDown) {
      if (!options.auth) await until(() => /Press Ctrl-C to stop/.test(out), 60_000, () => err.slice(-3000));
      // Shipped bare down refuses --space/--server. Verify the one private registry record first.
      const registryPath = join(home, "machine", "meshes", `space.${spaceKey(space)}.json`);
      const registration = JSON.parse(readFileSync(registryPath, "utf8")) as { root?: string; space?: string; server?: string };
      const currentIdentity = statSync(mesh, { bigint: true });
      const currentMarker = statSync(join(mesh, ".cotal"), { bigint: true });
      assert.ok(markerIdentity);
      assert.equal(currentMarker.dev, markerIdentity.dev); assert.equal(currentMarker.ino, markerIdentity.ino);
      assert.ok(refusalBirths.every(live), "original refused stack births still live after resumed readiness");
      assert.equal(currentIdentity.dev, rootIdentity.dev); assert.equal(currentIdentity.ino, rootIdentity.ino);
      assert.equal(registration.root && realpathSync(registration.root), realpathSync(mesh));
      assert.equal(registration.space, space);
      assert.equal(registration.server, `nats://127.0.0.1:${port}`);
      assert.deepEqual(Object.keys(env).filter((key) => /^COTAL_/i.test(key)).sort(), ["COTAL_HOME", "COTAL_SKIP_CONNECTOR_SEED"]);
      const downArgs = options.refusal ? ["down", "--with-agents", "--yes"] : ["down", "--yes"];
      assertSmokeSandboxDown(sandbox, downArgs, { cwd: mesh, env });
      const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, downArgs, 60_000);
      writeFileSync(join(root, "down.json"), JSON.stringify(down), { mode: 0o600 });
      assert.equal(down.code, 0, `own-root ${downArgs.join(" ")} succeeds: ${down.out}${down.err}`); passed++;
      await until(() => state.exited, 20_000, () => err.slice(-3000));
      await waitForOwnedChild(() => state.closed, 3_000, `${root}: external down streams drained`);
      assert.equal(state.code, 0, "external down propagates a clean broker exit"); passed++;
      assert.doesNotMatch(err, /exited unexpectedly|stays recorded|repair:/, "external down emits no crash or retention diagnostic"); passed++;
      assert.equal(await portOpen(port), false, "own-root down closed listener"); passed++;
      assert.equal([...owned.values()].some(live), false, "own-root down removed exact owned births"); passed++;
      if (options.externalDown) {
        const meshes = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["meshes"]);
        assert.equal(meshes.code, 0, meshes.err); passed++;
        const spaces = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["space"]);
        assert.equal(spaces.code, 0, spaces.err); passed++;
        if (options.externalDown === "folder") {
          assert.match(meshes.out, /^external-folder\b[^\n]*offline/m); passed++;
          assert.match(spaces.out, /^\s*external-folder\b/m); passed++;
        } else {
          assert.match(meshes.out, /no meshes registered/); passed++;
          assert.match(spaces.out, /No spaces registered/); passed++;
          if (!options.auth) await checkStoppedOpenDiagnosis(mesh, env, space, port);
          await checkStoppedRestartAdvice(mesh, env, port);
        }
        if (!options.auth) {
          await checkStoppedPreview(mesh, env, space, port);
          if (options.externalDown === "named" && process.getuid?.() !== 0) await checkStoppedStore(mesh, env, space, port, store);
        }
        console.log(`PASS foreground-up-signals ${name}: clean external down and expected registration`);
        return true;
      }
      console.log(`${refusalBoundary ? "PASS" : "INCONCLUSIVE"} foreground-up-signals ${name}: native startup-capability refusal=${refusalBoundary}, resumed serving, explicit private down, clean exit${state.code}`);
      return refusalBoundary;
    }
    ownRecords();
    const broker = token(brokerPath); assert.ok(broker && live(broker));
    if (options.crash) process.kill(broker.pid, "SIGKILL");
    else {
      assert.ok(child.pid);
      if (options.signal === "SIGTERM") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGINT");
      if (options.twice) {
        await sleep(5);
        assert.equal(state.exited, false, "second interrupt exercises an in-flight owner");
        process.kill(-child.pid, "SIGINT");
        passed++;
      }
    }
    await until(() => { ownRecords(); if (state.error) throw state.error; return state.exited; }, 60_000, () => err.slice(-3000));
    // Close can depend on a retained broker's pipes. Never wait unboundedly before cleanup.
    await waitForOwnedChild(() => state.closed, 3_000, `${root}: successful owner streams drained`);
    assert.equal(await portOpen(port), false, "the owned broker listener closed"); passed++;
    if (options.crash) {
      assert.notEqual(state.code, 0, "unexpected broker loss remains a nonzero CLI exit"); passed++;
      assert.match(err, /exited unexpectedly/); passed++;
    } else {
      const signalExit = options.signal === "SIGTERM" ? 143 : 130;
      assert.equal(state.code, signalExit, `guarded shutdown exits ${signalExit} (${state.signal ?? "no signal"}): ${err}`); passed++;
      assert.match(options.nativeLog ? readFileSync(logFile, "utf8") : err, /Trapped "terminated" signal/, "the CLI owner, not terminal SIGINT, stops the broker"); passed++;
      assert.doesNotMatch(err, /Trapped "interrupt" signal|could not list managed agents|control plane degraded|exited unexpectedly|spare.*unavailable/i); passed++;
      if (options.auth) {
        assert.equal(out.match(/stopped manager \(pid /g)?.length, 1, "one guarded manager stop"); passed++;
        assert.equal(out.match(/stopped delivery daemon \(pid /g)?.length, 1, "one delivery stop"); passed++;
        assert.ok(out.indexOf("stopped manager") < out.indexOf("stopped delivery daemon"), "manager stop precedes delivery stop"); passed++;
      }
      if (options.ready) {
        assert.ok(timeline.indexOf("stopped delivery daemon") < timeline.indexOf('Trapped "terminated" signal'), "delivery stop report precedes broker SIGTERM"); passed++;
        assert.doesNotMatch(err, /could not list|refusing bare manager stop|spare.capability|NOT BOUND/i, "ready shutdown has no listing, spare or unbound failure"); passed++;
        const store = join(mesh, ".cotal", "nats");
        const bucket = recordsBucket(space);
        const files = readdirSync(store, { recursive: true, withFileTypes: true });
        assert.ok(files.some((file) => file.isDirectory() && file.name === `KV_${bucket}`), "the stopped broker retained its records stream"); passed++;
        const consumers = files.filter((file) => file.name === "meta.inf" && file.parentPath.split(/[\\/]/).slice(-3, -1).join("/") === `KV_${bucket}/obs`);
        assert.ok(consumers.every((file) => JSON.parse(readFileSync(join(file.parentPath, file.name), "utf8")).filter_subject !== `$KV.${bucket}.goalidx.manager.>`), "the stopped broker has no persisted manager goal-index scan consumer"); passed++;
      }
      assert.equal([...owned.values()].some(live), false, "no recorded owned process survives successful teardown"); passed++;
      assert.deepEqual([brokerPath, managerPath, deliveryPath].filter((file) => existsSync(file)), [], "no recorded pidfile survives successful teardown"); passed++;
    }
    console.log(`PASS foreground-up-signals ${name}`);
    return true;
  } finally {
    // The CLI remains the launch owner until it exits. Ask it to stop first, then signal only
    // recorded exact starts born in this private root. Never choose cleanup targets from argv.
    try {
      // A stopped manager must be resumed before any owner/down cleanup. Never signal a reused PID.
      if (suspended && live(suspended)) process.kill(suspended.pid, "SIGCONT");
      await finishOwnedChild(child, state, ownRecords, () => owned.values(), root);
    } finally {
      writeFileSync(join(root, "stdout.log"), out, { mode: 0o600 });
      writeFileSync(join(root, "stderr.log"), err, { mode: 0o600 });
      writeFileSync(join(root, "timeline.log"), timeline, { mode: 0o600 });
      writeFileSync(join(root, "exit.json"), JSON.stringify({ code: state.code, signal: state.signal, closed: state.closed, port, owned: [...owned.values()], storesDeleted: false }), { mode: 0o600 });
    }
  }
}

async function checkStoppedStore(mesh: string, env: NodeJS.ProcessEnv, space: string, port: number, store: string): Promise<void> {
  const jetstream = join(store, "jetstream");
  const mode = statSync(jetstream).mode & 0o777;
  const saved = `nats://127.0.0.1:${port}`;
  let other: number;
  do { other = await freePort(); } while (other === port);
  const ps = (...flags: string[]) => foregroundCliProbe(cliEntry, tsx, mesh, env, ["ps", "--plain", ...flags]);
  chmodSync(jetstream, mode & ~0o200);
  try {
    for (const flags of [[], ["--space", space, "--server", saved]]) {
      const { code, out, err } = await ps(...flags);
      assert.equal(code, 2, out + err);
      assert.match(err, /PERMISSION_DENIED/);
      assert.ok(err.includes(`${jetstream} is not writable`) && err.includes(`chmod -R u+w ${jetstream}`), err);
      passed++;
    }
    for (const [name, address] of [[space, `nats://127.0.0.1:${other}`], ["other-open-space", saved]]) {
      const { code, out, err } = await ps("--space", name, "--server", address);
      assert.equal(code, 2, out + err);
      assert.match(err, /TARGET_UNAVAILABLE/);
      assert.ok(!err.includes(jetstream), err);
      passed++;
    }
  } finally { chmodSync(jetstream, mode); }
}
async function restoreStartupCell(): Promise<void> {
  const mesh = join(base, "restore-startup"), home = join(mesh, "home");
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  for (const p of [mesh, home, env.COTAL_HOME, env.XDG_CONFIG_HOME]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
  const port = await freePort(), space = "foreground-restore";
  const server = `nats://127.0.0.1:${port}`;
  const journalPath = join(mesh, ".cotal", "maintenance", "v1", "journal.json");
  const journal = (): { state?: string; restore?: { attemptId: string }; listenerProof?: { processOwner: { pid: number } } } =>
    JSON.parse(readFileSync(journalPath, "utf8"));
  const probe = (args: string[]) => foregroundCliProbe(cliEntry, tsx, mesh, env, args, 120_000);
  const must = async (args: string[]) => {
    assertSmokeSandboxDown(sandbox, args, { cwd: mesh, env });
    const result = await probe(args);
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.out}${result.err}`);
  };
  const owned = new Map<string, ProcessIdentityRecord>();
  const collect = () => {
    for (const file of [join(mesh, ".cotal/nats.pid"), canonicalLocalProcessPath(MANAGER_PIDFILE, { root: mesh, space })]) {
      const row = token(file);
      if (row) owned.set(`${row.pid}:${row.token}`, row);
    }
  };
  const foreground = (args: string[]) => {
    const child = spawn(process.execPath, ["--import", tsx, cliEntry, "up", ...args], { cwd: mesh, env, stdio: ["ignore", "pipe", "pipe"] });
    const state = observeOwnedChild(child);
    let output = "";
    for (const pipe of [child.stdout, child.stderr]) pipe.on("data", (data: Buffer) => { output += data.toString(); });
    return { child, state, log: () => output };
  };
  let run: ReturnType<typeof foreground> | undefined;
  try {
    await must(["up", "--detach", "--open", "--space", space, "--server", server, "--store-dir", "./source store"]);
    await until(async () => {
      const result = await probe(["channel", "set", "restore-probe", "--desc", "before restore", "--space", space]);
      return result.code === 0;
    }, 90_000, () => "source manager did not register");
    await must(["down", "--preserve-state", "--store-dir", "./source store"]);
    await must(["backup", "create", "./full backup", "--store-dir", "./source store", "--plain"]);

    const restore = run = foreground(["--foreground", "--restore", "./full backup", "--store-dir", "./phase target"]);
    let attempt: string | undefined;
    let broker: ProcessIdentityRecord | undefined;
    await until(() => {
      if (restore.state.error || restore.state.exited) throw new Error(restore.log());
      const record = journal();
      if (record.state !== "commit-intent" || !record.listenerProof) return false;
      broker = token(join(mesh, ".cotal/nats.pid"));
      assert.equal(broker?.pid, record.listenerProof.processOwner.pid);
      collect();
      attempt = record.restore?.attemptId;
      assert.ok(restore.child.kill("SIGTERM"));
      return true;
    }, 120_000, restore.log, 2);
    await until(() => restore.state.exited, 90_000, restore.log);
    await waitForOwnedChild(() => restore.state.closed, 3_000, "interrupted restore streams drained");
    assert.equal(restore.state.code, 143, restore.log()); passed++;
    assert.ok(attempt && restore.log().includes(`Interrupted: restore attempt ${attempt}`), restore.log()); passed++;
    assert.match(restore.log(), /Continue it with bare `(?:pnpm )?cotal up`/); passed++;
    assert.doesNotMatch(restore.log(), /before it answered|take it off PATH|OPERATION_FAILED/); passed++;
    assert.ok(broker && !live(broker) && !await portOpen(port), "the interrupted restore stopped its own listener"); passed++;

    const recovery = run = foreground([]);
    await until(() => {
      collect();
      if (recovery.state.error || recovery.state.exited) throw new Error(recovery.log());
      const record = journal();
      return record.state === "active" && record.restore?.attemptId === attempt;
    }, 120_000, recovery.log);
    await must(["channel", "set", "restore-probe", "--desc", "after recovery", "--space", space]);
    await must(["down", "--yes"]);
    await until(() => recovery.state.exited, 20_000, recovery.log);
    assert.equal(recovery.state.code, 0, recovery.log()); passed++;
    console.log("PASS foreground-up-signals restore-startup: SIGTERM preserves forward recovery of the same attempt");
  } finally {
    if (run) await finishOwnedChild(run.child, run.state, collect, () => owned.values(), mesh);
    else if (await portOpen(port)) await must(["down", "--yes"]);
  }
}

/** A prepared root takes the controller route. Ctrl-C while its foreground `up` waits for the
 *  manager's readiness lets the start settle, then runs the guarded whole-stack stop: exit 130, the
 *  stop completed for every member, and the broker listener closed. With `receipt`, the CLI sends
 *  itself SIGTERM while it writes its start receipt. A team boot gets SIGTERM as it starts the
 *  broker. Both run the same stop and exit 143. */
async function controllerStartupCell(kind: "up" | "receipt" | "team" | "team-launch" = "up"): Promise<void> {
  const name = kind === "up" ? "controller-startup" : `controller-${kind}`;
  const root = join(base, name), home = join(root, "home"), mesh = join(root, "mesh");
  for (const p of [root, home, mesh, join(home, "xdg"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const created = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["space", "create", space, "--root", mesh]);
  assert.equal(created.code, 0, `space create prepares the controller root: ${created.err}`); passed++;
  const server = `nats://127.0.0.1:${port}`;
  const launch = kind === "team-launch", team = launch || kind === "team";
  const launchEnv = launch ? await preparePendingLaunch(mesh, env, space, server) : env;
  if (kind === "team") writeFileSync(join(mesh, "mesh.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker: {servers: "${server}", auth: false}\nchannels:\n  general: {deliveryClass: live}\n`);
  const preload = kind === "receipt" ? ["--import", join(import.meta.dirname, "_foreground-receipt-signal.ts")] : [];
  const args = team ? ["team", "boot", "mesh.yaml", "--foreground"] : ["up", "--foreground", "--server", server];
  const child: ChildProcess = spawn(process.execPath, ["--import", tsx, ...preload, cliEntry, ...args], { cwd: mesh, env: launchEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
  const state = observeOwnedChild(child);
  try {
    if (kind !== "receipt") {
      const member = launch ? "delivery" : team ? "broker" : "manager";
      await until(() => {
        if (state.error) throw state.error;
        if (state.exited) throw new Error(`CLI exited before the ${member} start: ${err}`);
        return err.includes(`Starting stack-${member}; waiting`);
      }, 90_000, () => err.slice(-3000));
      assert.ok(child.pid);
      if (team) process.kill(child.pid, launch ? "SIGINT" : "SIGTERM");
      else {
        // Pause only our launcher so the competing start can reach the live lock before release.
        process.kill(child.pid, "SIGSTOP");
        try {
          const second = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up"]);
          assert.equal(second.code, 2, second.out + second.err); passed++;
          assert.match(second.err, /LIFECYCLE_BLOCKED/); passed++;
          assert.match(second.err.replace(/\s+/g, " "), /the other foreground terminal keeps the stack once startup finishes.*`(?:pnpm )?cotal status`.*Ctrl-C in that terminal before starting it here/); passed++;
          assert.doesNotMatch(second.err, /run the command again/); passed++;
          process.kill(-child.pid, "SIGINT");
        } finally {
          process.kill(child.pid, "SIGCONT");
        }
      }
    }
    if (launch) {
      await until(() => state.exited || err.includes("Waiting for pending agent launches before stopping the stack"), 90_000, () => err);
      assert.equal(state.exited, false, err);
      assert.equal(await portOpen(port), true, "the foreground process keeps the broker running while the launch is blocked");
      writeFileSync(join(mesh, "release-launch"), "");
      passed++;
    }
    await until(() => { if (state.error) throw state.error; return state.exited; }, 120_000, () => err.slice(-3000));
    await waitForOwnedChild(() => state.closed, 3_000, `${root}: startup-interrupt owner streams drained`);
    const exit = kind === "up" || launch ? 130 : 143;
    assert.equal(state.code, exit, `a signal during startup exits ${exit} after the stop: ${err}`); passed++;
    if (kind !== "receipt") { assert.match(err, /Stop requested; the whole-stack stop runs once the start settles/, "the interrupt is acknowledged while the start runs"); passed++; }
    if (launch) { assert.match(err, /Waiting for pending agent launches before stopping the stack/); passed++; }
    const started = team ? "Fresh team boot started" : "Controller stack started";
    assert.ok(out.includes(started) && out.indexOf(started) < out.indexOf("Controller stack stopped"), `the start settles before the guarded stop: ${out.slice(-2000)}\n${err}`); passed++;
    // A member the mode has no role for, such as a static stack's auth service, has no instance.
    const journal = JSON.parse(readFileSync(join(mesh, ".cotal", "stack-controller.json"), "utf8")) as { operation: { kind: string; phase: string }; members: { instanceId: string | null; state: string }[] };
    assert.ok(journal.operation.kind === "down" && journal.operation.phase === "completed" && journal.members.every((member) => member.instanceId === null ? member.state === "not-attempted" : member.state === "stopped"), `the stop completed for every member: ${JSON.stringify(journal)}`); passed++;
    assert.equal(await portOpen(port), false, "the broker listener closed"); passed++;
    console.log(`PASS foreground-up-signals ${name}`);
  } finally {
    try {
      if (launch) writeFileSync(join(mesh, "release-launch"), "");
      if (!state.exited && child.pid) process.kill(-child.pid, "SIGKILL");
      // A failed cell still stops what its start left, through the product's own down.
      if (await portOpen(port)) {
        const stop = () => {
          const down = ["down", "--yes"];
          assertSmokeSandboxDown(sandbox, down, { cwd: mesh, env: launchEnv });
          return foregroundCliProbe(cliEntry, tsx, mesh, launchEnv, down, 60_000);
        };
        if (launch) await until(async () => (await stop()).code === 0, 45_000, () => err, 500);
        else await stop();
      }
    } finally {
      writeFileSync(join(root, "stdout.log"), out, { mode: 0o600 });
      writeFileSync(join(root, "stderr.log"), err, { mode: 0o600 });
      writeFileSync(join(root, "exit.json"), JSON.stringify({ code: state.code, signal: state.signal, closed: state.closed, port }), { mode: 0o600 });
    }
  }
}

async function preparePendingLaunch(mesh: string, env: NodeJS.ProcessEnv, space: string, server: string): Promise<NodeJS.ProcessEnv> {
  const installed = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["ext", "add", join(wt, "extensions", "connector-claude-code")], 120_000);
  assert.equal(installed.code, 0, installed.out + installed.err);
  const apps = join(mesh, "apps");
  mkdirSync(apps, { mode: 0o700 });
  writeFileSync(join(apps, "claude"), `#!/bin/sh\nif [ "$1" = --version ]; then echo "2.5.0 (Claude Code)"; exit; fi\nwhile [ ! -f ${shellPath(join(mesh, "release-launch"))} ]; do sleep 0.1; done\n`, { mode: 0o700 });
  writeFileSync(join(mesh, ".mcp.json"), JSON.stringify({ mcpServers: { cotal: { type: "stdio", command: "/bin/true" } } }));
  writeFileSync(join(mesh, "mesh.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker: {servers: "${server}", auth: static}\nagent: claude\nagents:\n  planner: {instructions: Wait locally., events: false, model: claude-opus-5-5}\nchannels:\n  control: {deliveryClass: live, subscribe: [planner]}\n`);
  return { ...env, PATH: `${apps}:${env.PATH ?? ""}` };
}

/** Terminal loss on a ready foreground controller stack. `script` answers a hangup by sending the
 *  foreground `up` SIGTERM and SIGKILL two seconds later, so its guarded stop can be cut part way.
 *  Cut here once the broker's record reads `stopping`, the kill lands before or after the broker's
 *  signal. Before it, the broker still runs, and the next `down --yes` settles that stop and stops
 *  the stack. After it, the broker is gone under an unconfirmed request: the next `down --yes`
 *  refuses and names `down --abandon-stop <request> --yes`, which records the broker failed. Either
 *  way `up` then `down --yes` cycle the stack. */
async function controllerHangupCell(): Promise<void> {
  const name = "controller-hangup";
  const root = join(base, name), home = join(root, "home"), mesh = join(root, "mesh");
  for (const p of [root, home, mesh, join(home, "xdg"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
  recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const created = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["space", "create", space, "--root", mesh]);
  assert.equal(created.code, 0, `space create prepares the controller root: ${created.err}`); passed++;
  const child: ChildProcess = spawn(process.execPath, ["--import", tsx, cliEntry, "up", "--foreground", "--server", `nats://127.0.0.1:${port}`], { cwd: mesh, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
  const state = observeOwnedChild(child);
  // The stack's records are read in this suite's process from the cell's own Cotal home.
  const previousHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(home, "machine");
  // A read that meets the CLI's own write of the record refuses CONFLICT; a poll takes that as not yet.
  const broker = () => {
    try { return serviceInstances(space, "stack-broker")[0]?.record.value; }
    catch (error) { if (isCommandFailure(error) && error.code === "CONFLICT") return undefined; throw error; }
  };
  const envelope = (r: { out: string }) => { try { return JSON.parse(r.out) as { outcome?: string; error?: { code?: string; remedy?: string }; warnings?: { code: string; target?: { requestId?: string } }[] }; } catch { return undefined; } };
  try {
    await until(() => {
      if (state.error) throw state.error;
      if (state.exited) throw new Error(`CLI exited before the stack was ready: ${err}`);
      return out.includes("Controller stack started");
    }, 120_000, () => err.slice(-3000));
    assert.ok(child.pid); process.kill(child.pid, "SIGTERM");
    let stopping: ReturnType<typeof broker>;
    await until(() => {
      if (state.exited) throw new Error(`the foreground stop finished before the broker was stopping: ${err}`);
      stopping = broker();
      return stopping?.state === "stopping";
    }, 120_000, () => err.slice(-3000), 2);
    const request = stopping!.requestId;
    process.kill(child.pid, "SIGKILL");
    await until(() => state.exited, 10_000, () => "the killed foreground up did not exit");
    await waitForOwnedChild(() => state.closed, 3_000, `${root}: hangup owner streams drained`);
    // A signalled broker exits within moments; one the kill reached first keeps running.
    await until(() => observeServiceProcess(broker()!) === "gone", 5_000, () => "").catch(() => undefined);
    const signalled = observeServiceProcess(broker()!) === "gone";
    assert.equal(broker()?.state, "stopping", `the cut stop left the broker stopping under its request (${signalled ? "signalled, gone" : "not signalled, running"})`); passed++;
    if (signalled) {
      const refused = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes", "--json"], 60_000);
      assert.ok(refused.code === 2 && envelope(refused)?.error?.code === "LIFECYCLE_BLOCKED" && envelope(refused)?.error?.remedy?.includes(`cotal down --abandon-stop ${request} --yes`), `the next down refuses and names the abandon command for that request: ${refused.out}${refused.err}`); passed++;
      const abandoned = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--abandon-stop", request, "--yes", "--json"], 60_000);
      assert.ok(abandoned.code === 0 && envelope(abandoned)?.warnings?.some((w) => w.code === "STOP_ABANDONED" && w.target?.requestId === request) && broker()?.state === "failed", `down --abandon-stop records the broker failed with a warning: ${abandoned.out}${abandoned.err}`); passed++;
    } else {
      const settled = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes", "--json"], 120_000);
      assert.ok(settled.code === 0 && envelope(settled)?.outcome === "ok" && envelope(settled)?.warnings?.some((w) => w.code === "OPERATION_SETTLED"), `the next down settles the cut stop and the earlier down: ${settled.out}${settled.err}`); passed++;
      assert.ok(broker()?.state === "stopped" && !(await portOpen(port)), "and stops the broker it had never signalled"); passed++;
    }
    const restarted = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up", "--json"], 120_000);
    const stopped = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes", "--json"], 120_000);
    assert.ok(restarted.code === 0 && stopped.code === 0 && !(await portOpen(port)), `up then down cycle the stack: ${restarted.err}${stopped.err}`); passed++;
    console.log(`PASS foreground-up-signals ${name}: the kill landed ${signalled ? "after" : "before"} the broker's signal`);
  } finally {
    if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome;
    try {
      if (!state.exited && child.pid) process.kill(-child.pid, "SIGKILL");
      // A failed cell still stops what its start left, through the product's own down.
      if (await portOpen(port)) await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
    } finally {
      writeFileSync(join(root, "stdout.log"), out, { mode: 0o600 });
      writeFileSync(join(root, "stderr.log"), err, { mode: 0o600 });
      writeFileSync(join(root, "exit.json"), JSON.stringify({ code: state.code, signal: state.signal, closed: state.closed, port }), { mode: 0o600 });
    }
  }
}

/** A hangup of a ready foreground controller stack is not a stop. SIGHUP exits 129, names `cotal down`,
 *  leaves the broker running and removes the hold record. The next `down --yes` stops the stack. */
async function controllerSighupCell(): Promise<void> {
  const name = "controller-sighup";
  const root = join(base, name), home = join(root, "home"), caller = join(root, "caller");
  const selected = "../owner's mesh", mesh = resolve(caller, selected);
  for (const p of [root, home, mesh, caller, join(home, "xdg"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
  recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const created = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["space", "create", space, "--root", mesh]);
  assert.equal(created.code, 0, `space create prepares the controller root: ${created.err}`); passed++;
  const child: ChildProcess = spawn(process.execPath, ["--import", tsx, cliEntry, "up", "--foreground", "--open", "--no-manager", "--server", `nats://127.0.0.1:${port}`, "--root", selected, "--store-dir", "./relative-store", "--log-file", "./broker.log"], { cwd: caller, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
  const state = observeOwnedChild(child);
  const hold = join(mesh, ".cotal", "stack-foreground.hold");
  try {
    await until(() => {
      if (state.error) throw state.error;
      if (state.exited) throw new Error(`CLI exited before the stack was ready: ${err}`);
      return out.includes("Controller stack started") && existsSync(hold) && out.includes("cotal down");
    }, 120_000, () => err.slice(-3000));
    assert.ok(existsSync(join(caller, "relative-store")) && existsSync(join(caller, "broker.log"))
      && !existsSync(join(mesh, "relative-store")) && !existsSync(join(mesh, "broker.log")), "--root leaves both relative broker paths in the invoking folder"); passed++;
    assert.ok(readFileSync(join(mesh, ".cotal/server-open.conf"), "utf8").includes(`log_file: ${JSON.stringify(join(realpathSync(caller), "broker.log"))}`), "the selected root's broker config names the caller's log"); passed++;
    assert.ok(child.pid); process.kill(child.pid, "SIGHUP");
    await until(() => { if (state.error) throw state.error; return state.exited; }, 30_000, () => err.slice(-3000));
    await waitForOwnedChild(() => state.closed, 3_000, `${root}: hangup owner streams drained`);
    assert.equal(state.code, 129, `a hangup exits 129 and leaves the stack: ${err}`); passed++;
    assert.ok(err.includes(`\`cd ${shellPath(realpathSync(mesh))} && cotal down\` stops it.`), "the hangup stop command selects the project from the invoking folder"); passed++;
    assert.equal(await portOpen(port), true, "the broker keeps running after the hangup"); passed++;
    assert.equal(existsSync(hold), false, "the hangup removes this process's hold record"); passed++;
    const status = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["status", "--space", space, "--server", `nats://127.0.0.1:${port}`]);
    assert.ok(status.code === 0 && /reachable/.test(status.out), `status still shows the broker reachable: ${status.out}${status.err}`); passed++;
    const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
    assert.equal(down.code, 0, `the next down stops the stack the hangup left: ${down.out}${down.err}`); passed++;
    assert.equal(await portOpen(port), false, "down closed the broker the hangup left running"); passed++;
    assert.equal(existsSync(hold), false, "the hold record stays gone after down"); passed++;
    console.log(`PASS foreground-up-signals ${name}`);
  } finally {
    try {
      if (!state.exited && child.pid) process.kill(-child.pid, "SIGKILL");
      if (await portOpen(port)) await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
    } finally {
      writeFileSync(join(root, "stdout.log"), out, { mode: 0o600 });
      writeFileSync(join(root, "stderr.log"), err, { mode: 0o600 });
      writeFileSync(join(root, "exit.json"), JSON.stringify({ code: state.code, signal: state.signal, closed: state.closed, port }), { mode: 0o600 });
    }
  }
}

async function checkRecordedAddressWait(mesh: string, env: NodeJS.ProcessEnv, port: number): Promise<void> {
  const listener = createServer((socket) => socket.resetAndDestroy());
  listener.listen(port, "127.0.0.1");
  await once(listener, "listening");
  try {
    const refusal = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up", "--foreground", "--no-manager"], 15_000);
    assert.ok(refusal.code === 2 && refusal.err.includes("address already in use"), refusal.out + refusal.err);
    assert.doesNotMatch(refusal.err, /Waiting .* for TIME-WAIT to clear/); passed++;
  } finally { await new Promise<void>((done) => listener.close(() => done())); }

  // A Linux TCP connection to its own address leaves a TIME-WAIT socket without SO_REUSEADDR.
  const socket = spawnSync("python3", ["-c", `
import socket, sys
address = ('127.0.0.1', int(sys.argv[1]))
with socket.socket() as connection:
    connection.bind(address)
    connection.settimeout(3)
    connection.connect(address)
    connection.shutdown(socket.SHUT_WR)
    assert connection.recv(1) == b''
`, String(port)], { encoding: "utf8", timeout: 5000 });
  assert.equal(socket.status, 0, `${socket.error ?? ""}${socket.stderr}`);
  const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const rows = readFileSync("/proc/net/tcp", "utf8").split("\n").map((row) => row.trim().split(/\s+/)).filter(([, local]) => local === address);
  assert.ok(rows.some(([, , peer, state]) => peer === address && state === "06") && rows.every(([, , , state]) => state === "06"), JSON.stringify(rows)); passed++;
}

async function checkMovedRootStop(moved: string, home: string, env: NodeJS.ProcessEnv, space: string, port: number, holder: { state: ReturnType<typeof observeOwnedChild>; io: { out: string; err: string } }): Promise<void> {
  const caller = recordSmokeSandbox({ root: home, cotalHome: env.COTAL_HOME!, xdgConfigHome: env.XDG_CONFIG_HOME! });
  const holderLog = () => `exit=${holder.state.code}\n${holder.io.out}\n${holder.io.err}`;
  await until(() => existsSync(moved) || holder.state.exited, 5_000, holderLog);
  assert.ok(existsSync(moved), holderLog());
  const previewArgs = ["down", "--space", space, "--dry-run"];
  assertSmokeSandboxDown(caller, previewArgs, { cwd: home, env });
  const preview = await foregroundCliProbe(cliEntry, tsx, home, env, previewArgs);
  assert.equal(preview.code, 0, preview.out + preview.err); passed++;
  await until(() => portOpen(port), 5_000, holderLog);
  assert.equal(holder.state.exited, false, `a rename and a stop preview leave the holder running: ${holderLog()}`); passed++;
  const downArgs = ["down", "--space", space, "--yes"];
  assertSmokeSandboxDown(caller, downArgs, { cwd: home, env });
  const down = await foregroundCliProbe(cliEntry, tsx, home, env, downArgs, 120_000);
  assert.equal(down.code, 0, down.out + down.err); passed++;
  assert.match(down.out, /Stack stopped; its folder was gone/); passed++;
  await until(() => holder.state.closed, 10_000, () => holder.io.err.slice(-3000));
  assert.equal(holder.state.code, 0, holder.io.err); passed++;
  assert.match(holder.io.err, /Foreground stack released/); passed++;
  assert.equal(await portOpen(port), false, "the stopped stack's broker is gone"); passed++;
}

async function movedRootSignalCell(): Promise<void> {
  const root = join(base, "controller-moved-root-signal"), mesh = join(root, "project"), moved = `${mesh} moved`;
  const home = join(root, "home"), space = "foreground-moved-root-signal", port = await freePort();
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  for (const dir of [mesh, env.COTAL_HOME, env.XDG_CONFIG_HOME]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
  const created = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["space", "create", space, "--root", "."]);
  assert.equal(created.code, 0, created.out + created.err);
  const down = () => {
    const args = ["down", "--yes"];
    assertSmokeSandboxDown(sandbox, args, { cwd: mesh, env });
    return foregroundCliProbe(cliEntry, tsx, mesh, env, args, 120_000);
  };
  const children: { child: ChildProcess; state: ReturnType<typeof observeOwnedChild> }[] = [];
  const start = async (...args: string[]) => {
    const child = spawn(process.execPath, ["--import", tsx, cliEntry, "up", "--foreground", ...args], { cwd: mesh, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const state = observeOwnedChild(child);
    children.push({ child, state });
    let out = "", err = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    const log = () => out + err;
    await until(() => {
      if (state.error) throw state.error;
      if (state.exited) throw new Error(log());
      return /Operation: +up completed/.test(out);
    }, 120_000, log);
    return { child, state, log };
  };
  let confirmed = false;
  try {
    const initial = await start("--server", `nats://127.0.0.1:${port}`);
    const stopped = await down();
    assert.equal(stopped.code, 0, stopped.out + stopped.err);
    await until(() => initial.state.closed, 10_000, initial.log);
    assert.equal(initial.state.code, 0, initial.log());
    const holder = await start("--root", mesh);
    const pins = readStackJournal(mesh)?.journal.members.flatMap(({ process }) => process ? [process] : []);
    assert.ok(pins?.length === 3 && pins.every(live), holder.log());
    assert.equal(await portOpen(port), true, holder.log());
    renameSync(mesh, moved);
    assert.ok(holder.child.kill("SIGTERM"), holder.log());
    await until(() => holder.state.closed, 120_000, holder.log);
    assert.equal(holder.state.code, 143, holder.log()); passed++;
    assert.match(holder.log(), /Stack stopped; its folder was gone/); passed++;
    assert.ok(pins.every((pin) => !live(pin)), holder.log()); passed++;
    assert.equal(await portOpen(port), false, holder.log()); passed++;
    confirmed = true;
    console.log("PASS foreground-up-signals controller-moved-root-signal");
  } finally {
    for (const { child, state } of children) if (!state.exited) child.kill("SIGKILL");
    if (!confirmed) {
      if (existsSync(moved)) {
        if (existsSync(mesh)) renameSync(mesh, `${mesh}-recreated`);
        renameSync(moved, mesh);
      }
      await down();
    }
  }
}

async function controllerHoldCell(kind: "takeover" | "other-home" | "broker-crash" | "broker-only-crash" | "time-wait" | "moved-root" = "takeover"): Promise<void> {
  const otherHome = kind === "other-home";
  const brokerOnly = kind === "broker-only-crash" || kind === "time-wait";
  const name = kind === "takeover" ? "controller-hold" : `controller-hold-${kind}`;
  const root = join(base, name), home = join(root, "home"), mesh = join(root, brokerOnly ? "broker only" : "mesh");
  const machine = join(home, otherHome ? "launching home's machine" : "machine");
  for (const p of [root, home, mesh, join(home, "xdg"), machine]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: machine, xdgConfigHome: join(home, "xdg") });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: machine, XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const created = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["space", "create", space, "--root", mesh]);
  assert.equal(created.code, 0, `space create prepares the controller root: ${created.err}`); passed++;
  const moved = `${mesh}-moved`;
  const preload = kind === "moved-root" ? ["--import", join(import.meta.dirname, "_foreground-receipt-signal.ts")] : [];
  const foreground = (args: string[]) => {
    const child: ChildProcess = spawn(process.execPath, ["--import", tsx, ...preload, cliEntry, "up", "--foreground", ...args], { cwd: mesh, env: kind === "moved-root" ? { ...env, COTAL_SMOKE_RENAME_AT_RECEIPT: moved } : env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const io = { out: "", err: "" };
    child.stdout?.on("data", (b: Buffer) => { io.out += b.toString(); });
    child.stderr?.on("data", (b: Buffer) => { io.err += b.toString(); });
    return { child, io, state: observeOwnedChild(child) };
  };
  const holder = foreground(["--server", `nats://127.0.0.1:${port}`, ...(brokerOnly ? ["--open", "--no-manager", "--max-payload", "131072"] : [])]);
  let taker: ReturnType<typeof foreground> | undefined;
  let brokerKilled = false;
  try {
    await until(() => {
      if (holder.state.error) throw holder.state.error;
      if (holder.state.exited) throw new Error(`CLI exited before the stack was ready: ${holder.io.err}`);
      return /Operation: +up completed/.test(holder.io.out);
    }, 120_000, () => holder.io.err.slice(-3000));
    assert.ok(holder.child.pid);
    if (kind === "time-wait") {
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
      const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
      assert.equal(down.code, 0, down.out + down.err);
      await until(() => holder.state.closed, 10_000, () => holder.io.err);
      assert.equal(holder.state.code, 0, holder.io.err);
      await checkRecordedAddressWait(mesh, env, port);
      taker = foreground(["--no-manager"]);
      await until(() => {
        if (taker!.state.exited) throw new Error(taker!.io.out + taker!.io.err);
        return taker!.io.err.includes(`Waiting up to 65 seconds for TIME-WAIT to clear on the stack's broker address 127.0.0.1:${port}`);
      }, 15_000, () => taker!.io.out + taker!.io.err);
      assert.doesNotMatch(taker.io.err, /Starting stack-broker/, "the controller waits before launching the broker"); passed++;
      await until(() => {
        if (taker!.state.exited) throw new Error(taker!.io.out + taker!.io.err);
        return /Operation: +up completed/.test(taker!.io.out);
      }, 85_000, () => taker!.io.out + taker!.io.err);
      assert.ok(await portOpen(port), "the foreground restart binds the recorded port"); passed++;
      console.log(`PASS foreground-up-signals ${name}`);
      return;
    }
    if (kind === "moved-root") {
      await checkMovedRootStop(moved, home, env, space, port, holder);
      console.log(`PASS foreground-up-signals ${name}`);
      return;
    }
    if (kind === "broker-crash" || brokerOnly) {
      const broker = controllerBroker(space, machine);
      assert.ok(broker?.process && observeServiceProcess(broker) === "running", "the isolated stack owns this broker process");
      process.kill(broker.process.pid, "SIGKILL");
      brokerKilled = true;
      await until(() => holder.state.exited, 10_000, () => holder.io.err.slice(-3000));
      await waitForOwnedChild(() => holder.state.closed, 3_000, `${root}: holder streams drained`);
      assert.equal(holder.state.code, 5, "broker loss is a failed foreground run"); passed++;
      assert.match(holder.io.err, new RegExp(`nats-server exited unexpectedly \\(pid ${broker.process.pid}\\)`)); passed++;
      assert.equal(existsSync(join(mesh, ".cotal", "stack-foreground.hold")), false, "the failed launcher releases its hold"); passed++;
      const status = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["status"]);
      assert.ok(status.code === 0 && status.out.includes(`nats://127.0.0.1:${port}`) && /Connection:.*unreachable/.test(status.out), status.out + status.err); passed++;
      const repairArgs = [...(brokerOnly ? ["--no-manager"] : []), "--root", mesh];
      assert.ok(holder.io.err.includes(`up --foreground${brokerOnly ? " --no-manager" : ""} --root ${shellPath(mesh)}\` to repair the stack.`), holder.io.err); passed++;
      taker = foreground(repairArgs);
      await until(() => {
        if (taker!.state.error) throw taker!.state.error;
        if (taker!.state.exited) throw new Error(`the repair exited: ${taker!.io.err}`);
        return /Operation: +up completed/.test(taker!.io.out);
      }, 120_000, () => taker!.io.err.slice(-3000));
      assert.equal(await portOpen(port), true, "the next foreground up repairs the recorded listener"); passed++;
      if (brokerOnly) {
        const who = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["who", "--json"]);
        assert.ok(who.code === 0 && who.out.includes('"managers":"none-present"'), who.out + who.err); passed++;
      }
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
      const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
      assert.equal(down.code, 0, down.out + down.err);
      await until(() => taker!.state.closed, 10_000, () => taker!.io.err.slice(-3000));
      assert.equal(taker.state.code, 0, "an external down releases the repaired stack's foreground holder cleanly"); passed++;
      assert.doesNotMatch(taker.io.err, /nats-server exited unexpectedly/); passed++;
      console.log(`PASS foreground-up-signals ${name}`);
      return;
    }
    const secondEnv = otherHome ? { ...env, COTAL_HOME: join(home, "other-machine") } : env;
    const secondSandbox = otherHome ? recordSmokeSandbox({ root: mesh, cotalHome: secondEnv.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME }) : sandbox;
    const second = await foregroundCliProbe(cliEntry, tsx, mesh, secondEnv, ["up", "--foreground"], 60_000);
    assert.ok(second.code === 2 && second.err.includes(`a foreground \`cotal up\` in process ${holder.child.pid} already holds this stack's lifetime`) && !holder.state.exited, `a second foreground up refuses CONFLICT, naming the holder, and the holder keeps the stack: ${second.out}${second.err}`); passed++;
    if (otherHome) {
      const commands = [...second.err.matchAll(/`(COTAL_HOME=[^`]+)`/g)].map(([, command]) => command!);
      assert.equal(commands.length, 2, second.err); passed++;
      assert.ok(commands[0]!.startsWith(`COTAL_HOME=${shellPath(machine)} `) && commands[0]!.endsWith(" down --yes"), second.err); passed++;
      assert.equal(commands[1], commands[0]!.replace(/ down --yes$/, " up --foreground"), second.err); passed++;
      assert.doesNotMatch(second.err, /`cotal down --yes`/, "no unqualified stop is offered to the other home"); passed++;
      assertSmokeSandboxDown(secondSandbox, ["down", "--yes"], { cwd: mesh, env: secondEnv });
      const wrongDown = await foregroundCliProbe(cliEntry, tsx, mesh, secondEnv, ["down", "--yes"], 120_000);
      assert.ok(wrongDown.code === 2 && /TARGET_UNAVAILABLE/.test(wrongDown.err) && await portOpen(port), wrongDown.out + wrongDown.err); passed++;
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
      const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
      assert.equal(down.code, 0, down.out + down.err); passed++;
      await until(() => holder.state.exited, 10_000, () => holder.io.err.slice(-3000));
      assert.ok(holder.state.code === 0 && !(await portOpen(port)), "the stop releases the holder and closes the broker"); passed++;
      console.log(`PASS foreground-up-signals ${name}`);
      return;
    }
    // A killed holder leaves its record and the running stack, which the next foreground up takes over.
    process.kill(holder.child.pid, "SIGKILL");
    await until(() => holder.state.exited, 10_000, () => "the killed foreground up did not exit");
    await waitForOwnedChild(() => holder.state.closed, 3_000, `${root}: holder streams drained`);
    assert.ok(existsSync(join(mesh, ".cotal", "stack-foreground.hold")) && await portOpen(port), "the killed holder left its record and the running stack"); passed++;
    taker = foreground([]);
    await until(() => {
      if (taker!.state.error) throw taker!.state.error;
      if (taker!.state.exited) throw new Error(`the taking-over foreground up exited: ${taker!.io.err}`);
      return taker!.io.out.includes("Controller stack already running");
    }, 120_000, () => taker!.io.err.slice(-3000));
    assert.ok(taker.io.out.includes("This stack is already running, and this terminal now takes over its lifetime") && taker.io.out.indexOf("takes over its lifetime") < taker.io.out.indexOf("Controller stack already running"), `a foreground up over the running stack says it takes it over before it blocks: ${taker.io.out}`); passed++;
    assert.ok(taker.child.pid); process.kill(taker.child.pid, "SIGTERM");
    await until(() => taker!.state.exited, 120_000, () => taker!.io.err.slice(-3000));
    assert.ok(taker.state.code === 143 && !(await portOpen(port)) && !existsSync(join(mesh, ".cotal", "stack-foreground.hold")), `SIGTERM there stops the whole stack and removes the hold record: ${taker.state.code} ${taker.io.err.slice(-1500)}`); passed++;
    console.log(`PASS foreground-up-signals ${name}`);
  } finally {
    try {
      for (const run of [holder, taker]) if (run && !run.state.exited && run.child.pid) process.kill(-run.child.pid, "SIGKILL");
      // A failed cell still stops what its start left, through the product's own down.
      if (existsSync(moved)) {
        if (existsSync(mesh)) renameSync(mesh, `${mesh}-recreated`);
        renameSync(moved, mesh);
      }
      if (brokerKilled && !brokerOnly && !(await portOpen(port))) await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up"], 120_000);
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
      if (await portOpen(port)) await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
    } finally {
      writeFileSync(join(root, "stdout.log"), holder.io.out + (taker?.io.out ?? ""), { mode: 0o600 });
      writeFileSync(join(root, "stderr.log"), holder.io.err + (taker?.io.err ?? ""), { mode: 0o600 });
    }
  }
}

async function openBrokerOnlyRestartCell(): Promise<void> {
  const home = join(base, "open-restart-home"), mesh = join(base, "open-restart-project");
  for (const p of [home, mesh]) mkdirSync(p, { mode: 0o700 });
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
  const space = "open-restart", port = await freePort();
  const child = spawn(process.execPath, ["--import", tsx, cliEntry, "up", "--foreground", "--open", "--no-manager", "--max-payload", "262144", "--space", space, "--server", `nats://127.0.0.1:${port}`], { cwd: mesh, env, stdio: ["ignore", "pipe", "pipe"] });
  const state = observeOwnedChild(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const downArgs = ["down", "--yes"];
  const config = join(mesh, ".cotal", "server-open.conf");
  try {
    await until(async () => {
      if (state.error) throw state.error;
      if (state.exited) throw new Error(output);
      return output.includes("Press Ctrl-C to stop.") && await portOpen(port);
    }, 30_000, () => output);
    assertSmokeSandboxDown(sandbox, downArgs, { cwd: mesh, env });
    const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, downArgs);
    assert.equal(down.code, 0, down.out + down.err);
    await waitForOwnedChild(() => state.closed, 15_000, output);
    assert.equal(state.code, 0, output);
    assert.equal(await portOpen(port), false);
    const restart = /^\s*(?:pnpm )?cotal (up.*?)\s+Start it again$/m.exec(down.out)?.[1];
    assert.equal(restart, "up --no-manager", down.out);
    const bare = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up"]);
    assert.equal(bare.code, 1, bare.out + bare.err);
    assert.match(bare.err, /--max-payload 262144 is below 263168 bytes/);
    const started = await foregroundCliProbe(cliEntry, tsx, mesh, env, restart.split(" "));
    assert.equal(started.code, 0, started.out + started.err);
    assert.match(started.out, new RegExp(`^Mesh: ${space}$`, "m"));
    assert.match(started.out, /running in the background: nats-server \(pid \d+\) - stop with:/);
    assert.equal(await portOpen(port), true);
    assert.match(readFileSync(config, "utf8"), /^max_payload:\s*262144$/m);
    passed++;
    console.log("PASS foreground-up-signals legacy open stop restarts broker-only at its saved payload limit");
  } finally {
    if (!state.exited) child.kill("SIGTERM");
    await waitForOwnedChild(() => state.closed, 30_000, output);
    assertSmokeSandboxDown(sandbox, downArgs, { cwd: mesh, env });
    if (await portOpen(port)) await foregroundCliProbe(cliEntry, tsx, mesh, env, downArgs);
    assert.equal(await portOpen(port), false, "the owned broker stopped");
  }
}

async function managerNameCell(): Promise<void> {
  const space = "foreground-manager-name", mesh = join(base, space), home = join(mesh, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
  const probe = (args: string[]) => foregroundCliProbe(cliEntry, tsx, mesh, env, args, 60_000);
  const created = await probe(["space", "create", space]);
  assert.equal(created.code, 0, created.out + created.err);
  const port = await freePort();
  const up = ["up", "--foreground", "--server", `nats://127.0.0.1:${port}`];
  const savedName = () => readManagerName({ root: mesh, space });

  const refuseWhileBusy = async (expected: string | undefined, ...names: (string | undefined)[]) => {
    const listener = createServer((socket) => socket.resetAndDestroy());
    listener.listen(port, "127.0.0.1");
    await once(listener, "listening");
    try {
      for (const name of names) {
        const refused = await probe([...up, ...(name === undefined ? [] : ["--manager-name", name])]);
        assert.equal(refused.code, 2, refused.out + refused.err);
        assert.match(refused.err, /CONFLICT/);
        assert.match(refused.err, /no broker was launched/);
        assert.equal(savedName(), expected);
      }
    } finally { await new Promise<void>((done) => listener.close(() => done())); }
  };
  const bootAndStop = async (...args: string[]) => {
    const child = spawn(process.execPath, ["--import", tsx, cliEntry, ...up, ...args], { cwd: mesh, env, stdio: ["ignore", "pipe", "pipe"] });
    const state = observeOwnedChild(child);
    let out = "", err = "";
    child.stdout.on("data", (data: Buffer) => { out += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { err += data.toString(); });
    try {
      await until(() => {
        if (state.exited || state.error) throw new Error(out + err);
        return out.includes("Controller stack started");
      }, 120_000, () => out + err);
      assert.equal(savedName(), "KeptManager");
      const who = await probe(["who", "--all"]);
      assert.equal(who.code, 0, who.out + who.err);
      assert.match(who.out, /\bKeptManager\b/);
    } finally {
      try {
        if (!state.exited) child.kill("SIGTERM");
        await waitForOwnedChild(() => state.closed, 60_000, out + err);
      } finally {
        if (!state.exited) child.kill("SIGKILL");
        assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
        if (await portOpen(port)) await probe(["down", "--yes"]);
      }
    }
    assert.equal(state.code, 143, out + err);
    assert.equal(await portOpen(port), false, out + err);
  };

  await refuseWhileBusy(undefined, undefined, "RefusedManager");
  await bootAndStop("--manager-name", "KeptManager");
  await refuseWhileBusy("KeptManager", "RefusedOverride");
  await bootAndStop();
  passed++;
  console.log("PASS foreground-up-signals refused starts leave the manager name unchanged");
}

async function userAuthRestartCell(): Promise<void> {
  const home = join(base, "user-auth-home"), mesh = join(base, "user-auth-project");
  for (const p of [home, mesh]) mkdirSync(p, { mode: 0o700 });
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const idp = createHttpServer((req, res) => {
    if (req.url !== "/auth/jwks") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...key, kid: "fixture", use: "sig", alg: "EdDSA" }] }));
  });
  const listening = once(idp, "listening");
  idp.listen(0, "127.0.0.1");
  await listening;
  try {
    const space = "restart-user-auth", port = await freePort(), server = `nats://127.0.0.1:${port}`;
    const restart = ["--user-auth", "--space", space, "--server", server];
    const bootAndStop = async (args: string[]) => {
      const child = spawn(process.execPath, ["--import", tsx, cliEntry, "up", ...args], { cwd: mesh, env, stdio: ["ignore", "pipe", "pipe"] });
      const state = observeOwnedChild(child);
      let output = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      try {
        await until(async () => {
          if (state.error) throw state.error;
          if (state.exited) throw new Error(output);
          return output.includes("Press Ctrl-C to stop.") && await portOpen(port);
        }, 90_000, () => output);
      } finally {
        if (!state.exited) child.kill("SIGTERM");
        await waitForOwnedChild(() => state.closed, 30_000, output);
      }
      assert.equal(state.code, 143, output);
      assert.equal(await portOpen(port), false, output);
    };
    await bootAndStop(["--foreground", "--no-manager", ...restart, "--idp", `http://127.0.0.1:${(idp.address() as AddressInfo).port}/auth`]);
    for (const args of [["whoami"], ["send", "--server", server, "-c", "general", "test message"]]) {
      const r = await foregroundCliProbe(cliEntry, tsx, mesh, env, [...args, "--space", space, "--plain"]);
      const text = (r.out + r.err).replace(/\s+/g, " ");
      assert.equal(r.code, 2, text);
      assert.ok(text.includes(`cotal up --user-auth --space ${shellPath(space)} --server ${shellPath(server)}`), text);
    }
    const downArgs = ["down", "--yes", "--plain"];
    assertSmokeSandboxDown(sandbox, downArgs, { cwd: mesh, env });
    const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, downArgs);
    assert.equal(down.code, 0, down.out + down.err);
    assert.ok(down.out.includes("Nothing was stopped."), down.out);
    const command = / up (.+?)\s+Start it with user auth/.exec(down.out)?.[1];
    assert.equal(command, `--foreground --no-manager --user-auth --space ${space} --server ${server}`, down.out);
    await bootAndStop(command.split(" "));
    passed++;
    console.log("PASS foreground-up-signals stopped user-auth guidance keeps the space and broker address");
  } finally {
    await new Promise<void>(resolve => idp.close(() => resolve()));
  }
}

console.log(`foreground-up-signals retained evidence: ${base}`);
await openBrokerOnlyRestartCell();
await managerNameCell();
await userAuthRestartCell();
await cell("external-named", { auth: true, ready: true, externalDown: "named" });
await cell("external-folder", { auth: true, ready: true, externalDown: "folder" });
await cell("external-open", { externalDown: "named" });
await checkInheritedPipeCleanup();
passed += 10;
await cell("group", {});
await cell("native-log", { nativeLog: true });
await cell("term", { signal: "SIGTERM" });
await cell("double", { twice: true });
await cell("auth-startup-failure", { auth: true, managerCrash: true });
await cell("auth-interrupted-failure", { auth: true, managerCrash: true, signal: "SIGINT" });
await cell("auth-early", { auth: true, twice: true });
await cell("auth-ready", { auth: true, ready: true });
await cell("auth-ready-term", { auth: true, ready: true, signal: "SIGTERM" });
await cell("delivery-repair", { auth: true, ready: true, repairDelivery: true });
await cell("open-broker-exit", { openBrokerExit: true });
await cell("custom-open", { openManagerExit: true });
let refusalObserved = false;
for (let attempt = 1; attempt <= 3 && !refusalObserved; attempt++) {
  refusalObserved = await cell(`auth-refused-${attempt}`, { auth: true, refusal: true });
}
assert.ok(refusalObserved, "native unavailable-capability refusal must be observed within three owned attempts, never manufactured");
await cell("crash", { crash: true });
await restoreStartupCell();
await controllerStartupCell();
await controllerStartupCell("receipt");
await controllerStartupCell("team");
await controllerStartupCell("team-launch");
await controllerHangupCell();
await controllerSighupCell();
await controllerHoldCell();
await controllerHoldCell("other-home");
await controllerHoldCell("broker-crash");
await controllerHoldCell("broker-only-crash");
if (process.platform === "linux") await controllerHoldCell("time-wait");
await controllerHoldCell("moved-root");
if (process.platform === "linux") await movedRootSignalCell();
console.log(`foreground-up-signals: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });
