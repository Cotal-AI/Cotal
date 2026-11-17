import strictAssert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
import { EndpointRefusal } from "../daemon/endpoint.js";
import { waitForInstalledDaemonGeneration } from "../daemon/update-generation.js";
import { installedDaemonIdentity, preflightInstalledDaemon, reconcileMissingShellRuntime, unitReceiptFile } from "../daemon/install.js";
import { currentParentWaits } from "../daemon/update-entry.js";
import { executeUpdate, update, updateRuntime, type UpdateRuntime } from "@cotal-ai/cli/update";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const root = realpathSync(mkdtempSync(join(tmpdir(), "ug-")));
process.env.XDG_RUNTIME_DIR = mkdtempSync("/tmp/cotal-ug-");
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
      reportRunningManager: async () => "none", reconcile: async () => {}, refreshConnectors: async () => [],
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
    refreshConnectors: async () => [], extensions: () => [], claimUpdatePass: () => () => {},
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
      const source = 'ExecStart="/other/node" "/other/cotal.js" daemon serve\n';
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

// A reconcile child exiting 0 never satisfies upgradeAndReconcile or repairReplacement unless the daemon answers at the target version.
for (const firstReconcileFails of [false, true]) {
  const cellRoot = join(root, `reconcile-ready-${firstReconcileFails}`);
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
    const waits: string[] = [], errors: string[] = [];
    const rt: UpdateRuntime = {
      ...updateRuntime,
      env: {},
      version: () => "0.13.1",
      checkout: () => false,
      installPrefix: () => globalPrefix,
      reportRunningManager: async () => "none",
      reconcile: async () => {},
      refreshConnectors: async () => [],
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
        if (op === "reconcile" && ++reconcileCalls === 1 && firstReconcileFails) return { status: 1, stdout: "", stderr: "transient reconcile error" };
        return { status: 0, stdout: "", stderr: "" };
      },
      waitForInstalledGeneration: async v => {
        waits.push(v);
        if (v === "0.13.2") throw new Error("installed Cotal 0.13.2 did not become ready");
      },
      out: () => {},
      err: line => { errors.push(line); },
    };
    assert.equal(await executeUpdate(true, rt), 1);
    assert.deepEqual(waits, ["0.13.2", "0.13.1"], "parent requires daemon readiness at 0.13.2 and verifies restored 0.13.1");
    assert.ok(errors.some(line => line.includes("cotal-ai@0.13.1 was restored and reconciled")), errors.join("\n"));
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorCotal === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = priorCotal;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
  }
}

emitSentinel({ passed: counted.cells(), failed: 0 });
