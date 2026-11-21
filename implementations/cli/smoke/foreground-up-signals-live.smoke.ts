/** Actual CLI foreground signal regression. Uses a private home/root and an allocated loopback
 * port, starts no agents, and retains the sandbox and logs. No source or process identity guard
 * is replaced. POSIX process-group signals model terminal Ctrl-C, unlike CLI-only kill().
 * Ready static stacks are probed through public status/ps. A bounded startup-refusal cell suspends
 * only its pinned manager before natural capability publication and always resumes it for cleanup.
 * A manager killed before readiness, without a stop request, must still report a degraded startup.
 * A controller-route cell interrupts a prepared root's foreground `up` while it is still starting,
 * and again as it writes its start receipt. A foreground `team boot` gets SIGTERM at the broker's
 * readiness announcement. Another cell cuts a ready stack's stop as a closed terminal
 * does. A third shows that a second foreground `up` refuses while one holds the stack, and that one
 * over a stack whose holder was killed says it takes the running stack over before a signal stops it.
 * A hangup cell sends SIGHUP to a ready foreground `up`: it exits 129, names `cotal down`, leaves the
 * broker running and removes its hold record, and the next `down --yes` stops the stack.
 * A broker crash releases a controller foreground hold with a failed exit so the next foreground
 * `up` can repair the recorded stack.
 * A legacy foreground stop exits 130 on SIGINT and 143 on SIGTERM.
 * An external `down --yes` stops a named or folder-named legacy stack without a crash diagnostic.
 * Run: pnpm smoke:foreground-up-signals:live */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recordsBucket } from "@cotal-ai/core";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, isCommandFailure, MANAGER_PIDFILE, MANAGER_SPARE_CAPABILITY, shellPath, spaceKey, verifyIdentityPin, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { finishOwnedChild, observeOwnedChild, ownedBirthLive as live, waitForOwnedChild } from "./_foreground-owned-child.js";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";
import { observeServiceProcess, serviceInstances } from "../src/lib/service-instances.js";
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
  const args = ["--import", tsx, cliEntry, "up", "--foreground", "--server", `nats://127.0.0.1:${port}`, ...(folderNamed ? [] : ["--space", space]), ...(options.auth ? [] : options.openBrokerExit || options.openManagerExit ? ["--open"] : ["--open", "--no-manager"]), ...(options.openManagerExit ? ["--store-dir", store] : []), ...(options.nativeLog ? ["--log-file", "./broker.log", "--logfile-size-limit", "1048576"] : [])];
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
        assert.doesNotMatch(blockedNext, /cotal down --yes|cotal up --foreground/);
        assert.ok(live(broker) && await portOpen(port));
        rmSync(seed);
        const status = await inspect("status");
        assert.equal(status.code, 0, status.out + status.err);
        assert.match(status.out, new RegExp(`^  Broker +running.*pid ${broker.pid}`, "m"));
        assert.match(status.out, /^  Manager +stopped$/m);
        assert.match(status.out, /cotal down --yes[^\n]*exited manager[^]*cotal up --foreground/);
        assert.ok(live(broker) && await portOpen(port));
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
/** A prepared root takes the controller route. Ctrl-C while its foreground `up` waits for the
 *  manager's readiness lets the start settle, then runs the guarded whole-stack stop: exit 130, the
 *  stop completed for every member, and the broker listener closed. With `receipt`, the CLI sends
 *  itself SIGTERM while it writes its start receipt. A team boot gets SIGTERM as it starts the
 *  broker. Both run the same stop and exit 143. */
async function controllerStartupCell(kind: "up" | "receipt" | "team" = "up"): Promise<void> {
  const name = kind === "up" ? "controller-startup" : `controller-${kind}`;
  const root = join(base, name), home = join(root, "home"), mesh = join(root, "mesh");
  for (const p of [root, home, mesh, join(home, "xdg"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
  recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const created = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["space", "create", space, "--root", mesh]);
  assert.equal(created.code, 0, `space create prepares the controller root: ${created.err}`); passed++;
  const server = `nats://127.0.0.1:${port}`;
  if (kind === "team") writeFileSync(join(mesh, "mesh.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker: {servers: "${server}", auth: false}\nchannels:\n  general: {deliveryClass: live}\n`);
  const preload = kind === "receipt" ? ["--import", join(import.meta.dirname, "_foreground-receipt-signal.ts")] : [];
  const args = kind === "team" ? ["team", "boot", "mesh.yaml", "--foreground"] : ["up", "--foreground", "--server", server];
  const child: ChildProcess = spawn(process.execPath, ["--import", tsx, ...preload, cliEntry, ...args], { cwd: mesh, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
  const state = observeOwnedChild(child);
  try {
    if (kind !== "receipt") {
      const member = kind === "team" ? "broker" : "manager";
      await until(() => {
        if (state.error) throw state.error;
        if (state.exited) throw new Error(`CLI exited before the ${member} start: ${err}`);
        return err.includes(`Starting stack-${member}; waiting`);
      }, 90_000, () => err.slice(-3000));
      assert.ok(child.pid);
      if (kind === "team") process.kill(child.pid, "SIGTERM");
      else process.kill(-child.pid, "SIGINT");
    }
    await until(() => { if (state.error) throw state.error; return state.exited; }, 120_000, () => err.slice(-3000));
    await waitForOwnedChild(() => state.closed, 3_000, `${root}: startup-interrupt owner streams drained`);
    const exit = kind === "up" ? 130 : 143;
    assert.equal(state.code, exit, `a signal during startup exits ${exit} after the stop: ${err}`); passed++;
    if (kind !== "receipt") { assert.match(err, /Stop requested; the whole-stack stop runs once the start settles/, "the interrupt is acknowledged while the start runs"); passed++; }
    const started = kind === "team" ? "Fresh team boot started" : "Controller stack started";
    assert.ok(out.includes(started) && out.indexOf(started) < out.indexOf("Controller stack stopped"), `the start settles before the guarded stop: ${out.slice(-2000)}`); passed++;
    // A member the mode has no role for, such as a static stack's auth service, has no instance.
    const journal = JSON.parse(readFileSync(join(mesh, ".cotal", "stack-controller.json"), "utf8")) as { operation: { kind: string; phase: string }; members: { instanceId: string | null; state: string }[] };
    assert.ok(journal.operation.kind === "down" && journal.operation.phase === "completed" && journal.members.every((member) => member.instanceId === null ? member.state === "not-attempted" : member.state === "stopped"), `the stop completed for every member: ${JSON.stringify(journal)}`); passed++;
    assert.equal(await portOpen(port), false, "the broker listener closed"); passed++;
    console.log(`PASS foreground-up-signals ${name}`);
  } finally {
    try {
      if (!state.exited && child.pid) process.kill(-child.pid, "SIGKILL");
      // A failed cell still stops what its start left, through the product's own down.
      if (await portOpen(port)) await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"]);
    } finally {
      writeFileSync(join(root, "stdout.log"), out, { mode: 0o600 });
      writeFileSync(join(root, "stderr.log"), err, { mode: 0o600 });
      writeFileSync(join(root, "exit.json"), JSON.stringify({ code: state.code, signal: state.signal, closed: state.closed, port }), { mode: 0o600 });
    }
  }
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
  const root = join(base, name), home = join(root, "home"), mesh = join(root, "mesh");
  const caller = join(root, "caller");
  for (const p of [root, home, mesh, caller, join(home, "xdg"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
  recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const created = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["space", "create", space, "--root", mesh]);
  assert.equal(created.code, 0, `space create prepares the controller root: ${created.err}`); passed++;
  const child: ChildProcess = spawn(process.execPath, ["--import", tsx, cliEntry, "up", "--foreground", "--open", "--no-manager", "--server", `nats://127.0.0.1:${port}`, "--root", "../mesh", "--store-dir", "./relative-store", "--log-file", "./broker.log"], { cwd: caller, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
    assert.match(err, /The terminal closed\. This stack in .* is still running; `cotal down` stops it\./, "the hangup names cotal down"); passed++;
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

async function controllerHoldCell(kind: "takeover" | "other-home" | "broker-crash" = "takeover"): Promise<void> {
  const otherHome = kind === "other-home";
  const name = kind === "takeover" ? "controller-hold" : `controller-hold-${kind}`;
  const root = join(base, name), home = join(root, "home"), mesh = join(root, "mesh");
  const machine = join(home, otherHome ? "launching home's machine" : "machine");
  for (const p of [root, home, mesh, join(home, "xdg"), machine]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: machine, xdgConfigHome: join(home, "xdg") });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: machine, XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const created = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["space", "create", space, "--root", mesh]);
  assert.equal(created.code, 0, `space create prepares the controller root: ${created.err}`); passed++;
  const foreground = (args: string[]) => {
    const child: ChildProcess = spawn(process.execPath, ["--import", tsx, cliEntry, "up", "--foreground", ...args], { cwd: mesh, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const io = { out: "", err: "" };
    child.stdout?.on("data", (b: Buffer) => { io.out += b.toString(); });
    child.stderr?.on("data", (b: Buffer) => { io.err += b.toString(); });
    return { child, io, state: observeOwnedChild(child) };
  };
  const holder = foreground(["--server", `nats://127.0.0.1:${port}`]);
  let taker: ReturnType<typeof foreground> | undefined;
  let brokerKilled = false;
  try {
    await until(() => {
      if (holder.state.error) throw holder.state.error;
      if (holder.state.exited) throw new Error(`CLI exited before the stack was ready: ${holder.io.err}`);
      return holder.io.out.includes("Controller stack started");
    }, 120_000, () => holder.io.err.slice(-3000));
    assert.ok(holder.child.pid);
    if (kind === "broker-crash") {
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
      taker = foreground(["--root", mesh]);
      await until(() => {
        if (taker!.state.error) throw taker!.state.error;
        if (taker!.state.exited) throw new Error(`the repair exited: ${taker!.io.err}`);
        return /Operation: +up completed/.test(taker!.io.out);
      }, 120_000, () => taker!.io.err.slice(-3000));
      assert.equal(await portOpen(port), true, "the next foreground up repairs the recorded listener"); passed++;
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
      if (brokerKilled && !(await portOpen(port))) await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up"], 120_000);
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
      if (await portOpen(port)) await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 120_000);
    } finally {
      writeFileSync(join(root, "stdout.log"), holder.io.out + (taker?.io.out ?? ""), { mode: 0o600 });
      writeFileSync(join(root, "stderr.log"), holder.io.err + (taker?.io.err ?? ""), { mode: 0o600 });
    }
  }
}

console.log(`foreground-up-signals retained evidence: ${base}`);
await cell("external-named", { auth: true, ready: true, externalDown: "named" });
await cell("external-folder", { auth: true, ready: true, externalDown: "folder" });
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
await controllerStartupCell();
await controllerStartupCell("receipt");
await controllerStartupCell("team");
await controllerHangupCell();
await controllerSighupCell();
await controllerHoldCell();
await controllerHoldCell("other-home");
await controllerHoldCell("broker-crash");
console.log(`foreground-up-signals: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });
