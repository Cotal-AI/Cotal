import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executionDescriptorPath, executionStore, selectExecutionProgram } from "../cotal.js";
import { cleanupExecutionStore } from "../execution-store.js";
import { recoverExecutionUpdate, prepareExecutionUpdate } from "../daemon/execution-update.js";
import { recoverInterruptedUpdate, updateRuntime } from "@cotal-ai/cli/update";
import { claimUpdateClosureAccess, readUpdateRecovery, recordUpdateActivation, updateClosureOwner, writeUpdateRecovery } from "@cotal-ai/workspace";
import { repairInstallModes } from "../../implementations/cli/src/lib/install-umask.js";
import { assertExecutionDestination, executionStagingPrefix, journalExecutionTransaction, publishExecutionTransaction, repairExecutionInstallModes, retainExecutionGeneration, retireSupersededExecutionDescriptor } from "../execution-transaction.js";

if (["linux", "darwin"].includes(process.platform)) {
  process.umask(0o022);
  const scratch = mkdtempSync(join(tmpdir(), "execution-transaction-"));
  const installed = join(scratch, "prefix/lib/node_modules/cotal-ai"), source = join(scratch, "source/cotal-ai");
  try {
    for (const root of [installed, source]) {
      mkdirSync(join(root, "dist"), { recursive: true });
      cpSync(join(import.meta.dirname, "../dist/cotal.js"), join(root, "dist/cotal.js"));
      chmodSync(join(root, "dist/cotal.js"), 0o644);
      writeFileSync(join(root, "dist/cotal-program.js"), "export const version = 'old';\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.1.0", bin: { cotal: "./dist/cotal.js" } }));
    }
    writeFileSync(join(installed, "desktop-runtime.json"), "{}");
    assert.throws(() => assertExecutionDestination(installed), /unavailable on the desktop runtime/);
    assert.throws(() => executionStagingPrefix(installed), /unavailable on the desktop runtime/);
    assert.equal(existsSync(executionStore(installed)), false);
    assert.equal(existsSync(executionDescriptorPath(installed)), false);
    rmSync(join(installed, "desktop-runtime.json"));
    const oldManifest = readFileSync(join(installed, "package.json"), "utf8");
    const oldProgram = readFileSync(join(installed, "dist/cotal-program.js"), "utf8");
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.2.0", bin: { cotal: "./dist/cotal.js" } }));
    writeFileSync(join(source, "dist/cotal-program.js"), "console.log('new generation'); export const version = 'new';\n");
    const store = executionStore(installed);
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o500 });
    symlinkSync(elsewhere, store);
    assert.throws(() => executionStagingPrefix(installed), /unsafe execution generation store/);
    assert.throws(() => retainExecutionGeneration(installed, source), /unsafe execution generation store/);
    assert.equal(lstatSync(elsewhere).mode & 0o777, 0o500);
    assert.deepEqual(readdirSync(elsewhere), []);
    rmSync(store);
    mkdirSync(join(store, ".installing-Zz9999/lib"), { recursive: true, mode: 0o700 });
    mkdirSync(join(store, ".preparing-Yy8888"), { mode: 0o700 });
    cleanupExecutionStore(installed);
    chmodSync(store, 0o555);
    const staging = executionStagingPrefix(installed);
    assert.equal(lstatSync(store).mode & 0o777, 0o755, "staging restores only owner write");
    assert.deepEqual(readdirSync(store), [staging.slice(store.length + 1)], "a new staging folder replaces the abandoned ones");
    rmSync(staging, { recursive: true });
    chmodSync(store, 0o555);
    const generation = retainExecutionGeneration(installed, source);
    assert.equal(lstatSync(store).mode & 0o777, 0o755, "retention restores only owner write");
    chmodSync(join(installed, "package.json"), 0o664);
    const journal = journalExecutionTransaction(installed, generation, join(installed, "dist/cotal.js"));
    assert.deepEqual(readdirSync(dirname(journal)), ["execution.json"]);
    assert.equal(lstatSync(journal).mode & 0o777, 0o600);
    publishExecutionTransaction(installed, journal);
    assert.equal(selectExecutionProgram(installed).root, generation.root);
    repairExecutionInstallModes(installed, () => repairInstallModes(join(scratch, "prefix")));
    assert.equal(selectExecutionProgram(installed).root, generation.root, "permission repair must preserve the published launcher selection");
    const selectedEntry = spawnSync(process.execPath, [join(installed, "dist/cotal.js"), "--version"], { encoding: "utf8", cwd: scratch, timeout: 15_000 });
    assert.equal(selectedEntry.status, 0, selectedEntry.stderr);
    assert.equal(selectedEntry.stdout.trim(), "new generation");
    assert.equal(lstatSync(join(installed, "package.json")).mode & 0o022, 0);
    const published = readFileSync(executionDescriptorPath(installed));
    utimesSync(join(installed, "package.json"), 1, 1);
    assert.equal(repairExecutionInstallModes(installed, () => repairInstallModes(join(scratch, "prefix"))), 0);
    assert.deepEqual(readFileSync(executionDescriptorPath(installed)), published, "a no-op repair leaves the active descriptor unchanged after a manifest touch");
    {
      const prefix = join(scratch, "prefix"), binEntry = join(prefix, "bin/cotal");
      const otherPrefix = join(scratch, "other-prefix"), otherRoot = join(otherPrefix, "lib/node_modules/cotal-ai");
      const shells = join(scratch, "fnm_multishells"), shell1 = join(shells, "1"), shell2 = join(shells, "2");
      mkdirSync(join(prefix, "bin"), { recursive: true });
      mkdirSync(join(otherRoot, "dist"), { recursive: true });
      mkdirSync(join(otherPrefix, "bin"), { recursive: true });
      cpSync(join(installed, "dist/cotal.js"), join(otherRoot, "dist/cotal.js"));
      writeFileSync(join(otherRoot, "dist/cotal-program.js"), "console.log('other installation');\n");
      writeFileSync(join(otherRoot, "package.json"), oldManifest);
      symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", binEntry);
      symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", join(otherPrefix, "bin/cotal"));
      mkdirSync(shells, { recursive: true });
      symlinkSync(prefix, shell1);
      symlinkSync(prefix, shell2);
      try {
        const current = JSON.parse(published.toString("utf8"));
        const info = lstatSync(shell1, { bigint: true });
        writeFileSync(executionDescriptorPath(installed), `${JSON.stringify({
          ...current,
          launch: { entry: join(shell1, "bin/cotal"), path: shell1, dev: String(info.dev), ino: String(info.ino), birth: String(info.birthtimeNs), ctime: String(info.ctimeNs) },
        })}\n`, { mode: 0o644 });
        chmodSync(executionDescriptorPath(installed), 0o644);
        assert.equal(repairExecutionInstallModes(installed, () => 0), 0);
        const migrated = JSON.parse(readFileSync(executionDescriptorPath(installed), "utf8"));
        assert.equal(migrated.launch.entry, join(realpathSync.native(prefix), "bin/cotal"));
        assert.equal(migrated.launch.path, join(realpathSync.native(installed), "package.json"));
        rmSync(shell1); symlinkSync(otherPrefix, shell1);
        const viaShell2 = spawnSync(process.execPath, [join(shell2, "bin/cotal"), "--version"], { encoding: "utf8", cwd: scratch, timeout: 15_000 });
        assert.equal(viaShell2.status, 0, viaShell2.stderr);
        assert.equal(viaShell2.stdout.trim(), "new generation");
      } finally {
        writeFileSync(executionDescriptorPath(installed), published);
        chmodSync(executionDescriptorPath(installed), 0o644);
        rmSync(join(prefix, "bin"), { recursive: true, force: true });
        rmSync(otherPrefix, { recursive: true, force: true });
        rmSync(shells, { recursive: true, force: true });
      }
    }
    assert.equal(retireSupersededExecutionDescriptor(installed), false, "active matching descriptor is never retired");
    for (const [path, mode] of [[join(installed, "dist/cotal.js"), 0o755], [store, 0o755], [executionDescriptorPath(installed), 0o644]] as const)
      assert.equal(lstatSync(path).mode & 0o777, mode, `${path} stays readable by the other accounts that run this package`);
    assert.equal(readFileSync(join(installed, "package.json"), "utf8"), oldManifest, "npm record is never rewritten by staged publication");
    assert.equal(readFileSync(join(installed, "dist/cotal-program.js"), "utf8"), oldProgram);
    const nextSource = join(scratch, "next/cotal-ai");
    cpSync(source, nextSource, { recursive: true });
    writeFileSync(join(nextSource, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.3.0", bin: { cotal: "./dist/cotal.js" } }));
    const next = retainExecutionGeneration(installed, nextSource);
    const secondJournal = journalExecutionTransaction(installed, next);
    publishExecutionTransaction(installed, secondJournal);
    assert.equal(selectExecutionProgram(installed).root, next.root);
    publishExecutionTransaction(installed, secondJournal, true);
    assert.equal(selectExecutionProgram(installed).root, generation.root, "second rollback restores previous selected generation, not npm original version");
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.4.0", bin: { cotal: "./dist/cotal.js" } }));
    assert.equal(selectExecutionProgram(installed).retained, false, "in-place replacement takes over selection");
    const staleDescriptor = readFileSync(executionDescriptorPath(installed));
    repairExecutionInstallModes(installed, () => repairInstallModes(join(scratch, "prefix")));
    assert.deepEqual(readFileSync(executionDescriptorPath(installed)), staleDescriptor, "repair never revives a stale descriptor");
    assert.equal(selectExecutionProgram(installed).retained, false);
    assert.equal(existsSync(executionDescriptorPath(installed)), true);
    assert.equal(retireSupersededExecutionDescriptor(installed), true, "superseded descriptor is retired when in-place install takes over");
    assert.equal(existsSync(executionDescriptorPath(installed)), false);
    writeFileSync(join(installed, "package.json"), oldManifest);
    publishExecutionTransaction(installed, journal);
    assert.equal(selectExecutionProgram(installed).root, generation.root);
    publishExecutionTransaction(installed, journal, true);
    assert.equal(selectExecutionProgram(installed).root, installed);
    assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, "0.1.0");
    assert.equal(readFileSync(join(installed, "dist/cotal-program.js"), "utf8"), oldProgram);
    const identityKey = Symbol.for("cotal.execution.identity"), priorIdentity = Reflect.get(globalThis, identityKey);
    const installedEntry = join(installed, "dist/cotal.js");
    Reflect.set(globalThis, identityKey, Object.freeze({ logicalEntry: installedEntry, loadedEntry: installedEntry }));
    try {
      const recovery = recoverExecutionUpdate(journal);
      writeFileSync(join(installed, "dist/cotal-program.js"), "console.log('cotal-ai 0.1.0');\n");
      const oldExecArgv = process.execArgv.splice(0);
      const oldArgv = process.argv[1]; process.argv[1] = installedEntry;
      const oldHome = process.env.COTAL_HOME, oldRuntime = process.env.XDG_RUNTIME_DIR;
      const oldSpawn = updateRuntime.spawnGlobal;
      const state = join(scratch, "admission-state");
      mkdirSync(join(state, "daemon"), { recursive: true, mode: 0o700 });
      writeFileSync(join(state, "daemon/service-unit.json"), "{", { mode: 0o600 });
      const runtime = join(scratch, "runtime"); mkdirSync(runtime, { mode: 0o700 });
      process.env.COTAL_HOME = state; process.env.XDG_RUNTIME_DIR = runtime;
      updateRuntime.spawnGlobal = async (_root, phase, _file, args) => {
        assert.equal(phase, "install");
        const staging = args[args.indexOf("--prefix") + 1]!;
        const target = join(staging, "lib/node_modules/cotal-ai");
        cpSync(source, target, { recursive: true });
        writeFileSync(join(target, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.2.0", type: "module", bin: { cotal: "./dist/cotal.js" }, cotalPreinstall: { v: 1, entry: "./dist/check.js" } }));
        writeFileSync(join(target, "dist/cotal-program.js"), "console.log('cotal-ai 0.2.0');\n");
        writeFileSync(join(target, "dist/check.js"), "const r=JSON.parse(process.argv[2]);console.log('COTAL_PREINSTALL_RESULT '+JSON.stringify({v:1,nonce:r.nonce,installedEntry:r.installedEntry,hostedSpaces:[],occupied:0,admission:{disposition:'deferred',occupied:null,hostedSpaces:[],reason:'target permits installation without restart'}}));\n");
        return { status: 0, stdout: "", stderr: "" };
      };
      try {
        let checked = false;
        chmodSync(installed, 0o700);
        chmodSync(store, 0o500);
        const staged = await prepareExecutionUpdate("0.2.0", join(scratch, "prefix/lib/node_modules"), receipt => { checked = true; assert.equal(receipt.admission.disposition, "deferred"); });
        assert.equal(lstatSync(store).mode & 0o777, 0o700, "private generation staging keeps the store private");
        assert.throws(() => staged.publish(), /before target checks/);
        await staged.preflight({});
        assert.equal(checked, true, "verified target policy decides despite an installed native preflight refusal");
        writeFileSync(join(state, "daemon/daemon.lock"), "malformed", { mode: 0o600 });
        assert.throws(() => staged.publish(), /identity is unreadable/);
        assert.equal(selectExecutionProgram(installed).root, installed, "changed lifetime cannot publish target");
        rmSync(join(state, "daemon/daemon.lock"));
        staged.publish(); staged.verify("0.2.0");
        staged.restore(); staged.verify("0.1.0"); staged.complete?.();
        const config = join(scratch, "unprotected-config");
        mkdirSync(config, { mode: 0o700 }); chmodSync(config, 0o777);
        const previousConfig = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = config;
        try {
          for (const published of [false, true]) {
            const update = await prepareExecutionUpdate("0.2.0", dirname(installed), () => {}, true);
            await update.preflight({});
            const reason = "Connector reconciliation and daemon activation are waiting: fixture config protection";
            const release = claimUpdateClosureAccess();
            try {
              writeUpdateRecovery({ previous: "0.1.0", target: "0.2.0", installed: "0.1.0", phase: "replacing", owner: updateClosureOwner(), execution: update.journal, reconcileWithoutSnapshot: true, reason, admission: { disposition: "deferred", occupied: null, hostedSpaces: [], reason } });
              if (published) { recordUpdateActivation(installedEntry, "0.2.0", reason, true); update.publish(); }
            } finally { release(); }
            const restored = await recoverInterruptedUpdate({ ...updateRuntime, recoverExecution: recoverExecutionUpdate });
            assert.equal(restored?.version, published ? undefined : "0.1.0");
            assert.equal(readUpdateRecovery(), undefined);
            assert.equal(lstatSync(config).mode & 0o777, 0o777);
            assert.deepEqual(readdirSync(config), []);
            if (published) { update.verify("0.2.0"); update.restore(); }
            else update.verify("0.1.0");
          }
          console.log("execution transaction: interrupted release-only install restored or retained the verified selection without touching config");
        } finally {
          if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousConfig;
        }
      } finally {
        process.execArgv.push(...oldExecArgv);
        process.argv[1] = oldArgv;
        updateRuntime.spawnGlobal = oldSpawn;
        if (oldHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = oldHome;
        if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
      }
      writeFileSync(join(installed, "dist/cotal-program.js"), "setTimeout(() => console.log('cotal-ai 0.1.0'), 31_000);\n");
      const started = Date.now();
      recovery.verify("0.1.0");
      assert.ok(Date.now() - started >= 31_000, "a valid entry taking longer than the former 30 second budget is accepted");
      writeFileSync(join(installed, "dist/cotal-program.js"), "console.log('cotal-ai 0.9.0');\n");
      assert.throws(() => recovery.verify("0.1.0"), /version output "cotal-ai 0.9.0"/);
      writeFileSync(join(installed, "dist/cotal-program.js"), "process.exit(7);\n");
      assert.throws(() => recovery.verify("0.1.0"), /exit 7/);
    } finally {
      writeFileSync(join(installed, "dist/cotal-program.js"), oldProgram);
      if (priorIdentity === undefined) Reflect.deleteProperty(globalThis, identityKey);
      else Reflect.set(globalThis, identityKey, priorIdentity);
    }
    const plain = join(scratch, "plain/lib/node_modules/cotal-ai"), repo = join(import.meta.dirname, "../..");
    cpSync(join(repo, "bin/dist"), join(plain, "dist"), { recursive: true });
    cpSync(join(repo, "bin/package.json"), join(plain, "package.json"));
    symlinkSync(join(repo, "bin/node_modules"), join(plain, "node_modules"));
    const unreadableStore = executionStore(plain);
    mkdirSync(unreadableStore, { mode: 0o700 });
    const inaccessibleDescriptor = executionDescriptorPath(plain), originalDescriptor = "unreadable old descriptor\n";
    writeFileSync(inaccessibleDescriptor, originalDescriptor);
    chmodSync(unreadableStore, 0);
    try {
      const version = spawnSync(process.execPath, [join(plain, "dist/cotal.js"), "--version"], { env: process.env, cwd: scratch, encoding: "utf8", timeout: 15_000 });
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout.split("\n")[0], `cotal-ai ${JSON.parse(readFileSync(join(plain, "package.json"), "utf8")).version}`);
      assert.equal(lstatSync(unreadableStore).mode & 0o777, 0, "a plain start never changes an unreadable store");
    } finally { chmodSync(unreadableStore, 0o700); }
    assert.equal(readFileSync(inaccessibleDescriptor, "utf8"), originalDescriptor, "the unreadable descriptor is left intact");
    console.log("execution transaction: publication and rollback preserve canonical product bytes");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
