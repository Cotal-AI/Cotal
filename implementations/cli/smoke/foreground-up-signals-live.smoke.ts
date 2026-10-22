/** Actual CLI foreground signal regression. Uses a private home/root and an allocated loopback
 * port, starts no agents, and retains the sandbox and logs. No source or process identity guard
 * is replaced. POSIX process-group signals model terminal Ctrl-C, unlike CLI-only kill().
 * Ready static stacks are probed through public status/ps. A bounded startup-refusal cell suspends
 * only its pinned manager before natural capability publication and always resumes it for cleanup.
 * Run: pnpm smoke:foreground-up-signals:live */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, MANAGER_PIDFILE, MANAGER_SPARE_CAPABILITY, spaceKey, verifyIdentityPin, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { finishOwnedChild, observeOwnedChild, ownedBirthLive as live, waitForOwnedChild } from "./_foreground-owned-child.js";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";
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

async function cell(name: string, options: { auth?: boolean; ready?: boolean; refusal?: boolean; signal?: "SIGINT" | "SIGTERM"; twice?: boolean; crash?: boolean }): Promise<boolean> {
  const root = join(base, name), home = join(root, "home"), mesh = join(root, "mesh");
  for (const p of [root, home, mesh, join(mesh, ".cotal"), join(home, "xdg"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
  const rootIdentity = statSync(mesh, { bigint: true });
  const markerIdentity = statSync(join(mesh, ".cotal"), { bigint: true });
  const port = await freePort(); assert.notEqual(port, 4222);
  const space = `foreground-${name}`;
  const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const args = ["--import", tsx, cliEntry, "up", "--foreground", "--server", `nats://127.0.0.1:${port}`, "--space", space, ...(options.auth ? [] : ["--open", "--no-manager"])];
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
    }, 90_000, () => err.slice(-3000), options.refusal ? 2 : 20);
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
        const result = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["status", "--components", "--space", space, "--server", `nats://127.0.0.1:${port}`]);
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
    if (options.refusal) {
      // Shipped bare down refuses --space/--server. Verify the one private registry record first.
      const registryPath = join(home, "machine", "meshes", `space.${spaceKey(space)}.json`);
      const registration = JSON.parse(readFileSync(registryPath, "utf8")) as { root?: string; space?: string; server?: string };
      const currentIdentity = statSync(mesh, { bigint: true });
      const currentMarker = statSync(join(mesh, ".cotal"), { bigint: true });
      assert.equal(currentMarker.dev, markerIdentity.dev); assert.equal(currentMarker.ino, markerIdentity.ino);
      assert.ok(refusalBirths.every(live), "original refused stack births still live after resumed readiness");
      assert.equal(currentIdentity.dev, rootIdentity.dev); assert.equal(currentIdentity.ino, rootIdentity.ino);
      assert.equal(registration.root && realpathSync(registration.root), realpathSync(mesh));
      assert.equal(registration.space, space);
      assert.equal(registration.server, `nats://127.0.0.1:${port}`);
      assert.deepEqual(Object.keys(env).filter((key) => /^COTAL_/i.test(key)).sort(), ["COTAL_HOME", "COTAL_SKIP_CONNECTOR_SEED"]);
      assertSmokeSandboxDown(sandbox, ["down", "--with-agents"], { cwd: mesh, env });
      const down = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--with-agents"]);
      writeFileSync(join(root, "down.json"), JSON.stringify(down), { mode: 0o600 });
      assert.equal(down.code, 0, "own-root public down --with-agents succeeds after resume and serving readiness"); passed++;
      await until(() => state.exited, 20_000, () => err.slice(-3000));
      await waitForOwnedChild(() => state.closed, 3_000, `${root}: external down streams drained`);
      assert.equal(state.code, 0, "observed N4: external down propagates clean broker exit0 despite unexpected diagnostic"); passed++;
      assert.match(err, /exited unexpectedly/, "known N4 unexpected-exit diagnostic retained"); passed++;
      assert.equal(await portOpen(port), false, "own-root down closed listener"); passed++;
      assert.equal([...owned.values()].some(live), false, "own-root down removed exact owned births"); passed++;
      console.log(`${refusalBoundary ? "PASS" : "INCONCLUSIVE"} foreground-up-signals ${name}: native startup-capability refusal=${refusalBoundary}, resumed serving, explicit private down, N4 unexpected diagnostic with exit${state.code}`);
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
      assert.equal(state.code, 0, `guarded shutdown completed (${state.signal ?? "no signal"}): ${err}`); passed++;
      assert.match(err, /Trapped "terminated" signal/, "the CLI owner, not terminal SIGINT, stops the broker"); passed++;
      assert.doesNotMatch(err, /Trapped "interrupt" signal|could not list managed agents|control plane degraded|exited unexpectedly|spare.*unavailable/i); passed++;
      if (options.auth) {
        assert.equal(out.match(/stopped manager \(pid /g)?.length, 1, "one guarded manager stop"); passed++;
        assert.equal(out.match(/stopped delivery daemon \(pid /g)?.length, 1, "one delivery stop"); passed++;
        assert.ok(out.indexOf("stopped manager") < out.indexOf("stopped delivery daemon"), "manager stop precedes delivery stop"); passed++;
      }
      if (options.ready) {
        assert.ok(timeline.indexOf("stopped delivery daemon") < timeline.indexOf('Trapped "terminated" signal'), "delivery stop report precedes broker SIGTERM"); passed++;
        assert.doesNotMatch(err, /could not list|refusing bare manager stop|spare.capability|NOT BOUND/i, "ready shutdown has no listing, spare or unbound failure"); passed++;
      }
      assert.equal([...owned.values()].some(live), false, "no recorded owned process survives successful teardown"); passed++;
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
console.log(`foreground-up-signals retained evidence: ${base}`);
await checkInheritedPipeCleanup();
passed += 10;
await cell("group", {});
await cell("term", { signal: "SIGTERM" });
await cell("double", { twice: true });
await cell("auth-early", { auth: true, twice: true });
await cell("auth-ready", { auth: true, ready: true });
let refusalObserved = false;
for (let attempt = 1; attempt <= 3 && !refusalObserved; attempt++) {
  refusalObserved = await cell(`auth-refused-${attempt}`, { auth: true, refusal: true });
}
assert.ok(refusalObserved, "native unavailable-capability refusal must be observed within three owned attempts, never manufactured");
await cell("crash", { crash: true });
console.log(`foreground-up-signals: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });
