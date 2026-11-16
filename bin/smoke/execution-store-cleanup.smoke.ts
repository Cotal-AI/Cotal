import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claimUpdateClosureAccess, clearUpdateRecovery, writeUpdateRecovery } from "@cotal-ai/workspace";
import { executionDescriptorPath, executionStore, selectExecutionProgram } from "../cotal.js";
import { cleanupExecutionStore } from "../execution-store.js";
import { completeExecutionTransaction, journalExecutionTransaction, publishExecutionTransaction, retainExecutionGeneration } from "../execution-transaction.js";

if (["linux", "darwin"].includes(process.platform)) {
  process.umask(0o022);
  const scratch = mkdtempSync(join(tmpdir(), "execution-cleanup-"));
  // The recovery record, the closure lock and cleanup's recovery check all read the Cotal home, so
  // the suite runs under a home of its own and never reads or writes the caller's.
  const ownHome = join(scratch, "home");
  mkdirSync(ownHome, { mode: 0o700 });
  Object.assign(process.env, { HOME: ownHome, COTAL_HOME: join(ownHome, ".cotal"), XDG_CONFIG_HOME: join(ownHome, "config") });
  const installed = join(scratch, "prefix/lib/node_modules/cotal-ai");
  const source = join(scratch, "source/cotal-ai");
  const warnings: string[] = [];
  const clean = () => cleanupExecutionStore(installed, line => warnings.push(line));
  try {
    for (const root of [installed, source]) {
      mkdirSync(join(root, "dist"), { recursive: true });
      cpSync(join(import.meta.dirname, "../dist/cotal.js"), join(root, "dist/cotal.js"));
      chmodSync(join(root, "dist/cotal.js"), 0o644);
      writeFileSync(join(root, "dist/cotal-program.js"), "export const version = 'fixture';\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.1.0", bin: { cotal: "./dist/cotal.js" } }));
    }
    const store = executionStore(installed);
    const publish = (version: string) => {
      writeFileSync(join(source, "package.json"), JSON.stringify({ name: "cotal-ai", version, bin: { cotal: "./dist/cotal.js" } }));
      const generation = retainExecutionGeneration(installed, source);
      const journal = journalExecutionTransaction(installed, generation);
      publishExecutionTransaction(installed, journal);
      completeExecutionTransaction(installed, journal);
      clean();
      return generation;
    };
    const first = publish("0.2.0");
    assert.equal(readdirSync(store).filter(name => name.startsWith(".transaction-")).length, 0);
    const second = publish("0.3.0");
    assert.deepEqual(readdirSync(store).filter(name => /^[a-f0-9]{32}$/.test(name)).sort(), [first.id, second.id].sort());
    const third = publish("0.4.0");
    assert.equal(existsSync(dirname(first.root)), true, "third publication retains oldest generation");
    assert.equal(selectExecutionProgram(installed).root, third.root);
    assert.equal(existsSync(second.root), true, "previous remains for rollback and loaded processes");
    assert.equal(JSON.parse(readFileSync(executionDescriptorPath(installed), "utf8")).previous, undefined);
    assert.equal(warnings.length, 0);

    mkdirSync(join(store, ".installing-Ab1234"));
    mkdirSync(join(store, ".preparing-Cd5678"));
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "keep");
    symlinkSync(outside, join(store, "e".repeat(32)));
    clean();
    assert.equal(existsSync(join(store, ".installing-Ab1234")), false);
    assert.equal(existsSync(join(store, ".preparing-Cd5678")), false);
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
    assert.equal(warnings.length, 0, "generation entries are not removal candidates");
    rmSync(join(store, "e".repeat(32)));

    const pending = retainExecutionGeneration(installed, source);
    const pendingJournal = journalExecutionTransaction(installed, pending);
    clean();
    assert.equal(existsSync(pending.root), true, "unpublished recovery target is not collected");
    assert.equal(existsSync(pendingJournal), true, "unfinished journal remains");
    completeExecutionTransaction(installed, pendingJournal);
    const releaseRecovery = claimUpdateClosureAccess();
    try {
      writeUpdateRecovery({ previous: "0.4.0", target: "0.5.0", installed: "0.4.0", phase: "paused", reason: "cleanup smoke", execution: pendingJournal });
      clean();
      assert.equal(existsSync(pendingJournal), true, "paused recovery journal is never retired even with a completion marker");
      assert.equal(existsSync(pending.root), true);
      clearUpdateRecovery();
    } finally { releaseRecovery(); }
    clean();
    assert.equal(existsSync(pending.root), true, "completed unpublished generation remains");
    assert.equal(existsSync(pendingJournal), false);

    // An earlier release had no previous field or completed marker. Its validated publication
    // chain is not enriched by cleanup and does not prove another home's recovery ended.
    const legacySource = retainExecutionGeneration(installed, source);
    const legacyJournal = journalExecutionTransaction(installed, legacySource);
    publishExecutionTransaction(installed, legacyJournal);
    const descriptor = JSON.parse(readFileSync(executionDescriptorPath(installed), "utf8"));
    delete descriptor.previous;
    writeFileSync(executionDescriptorPath(installed), JSON.stringify(descriptor));
    clean();
    assert.equal(existsSync(legacyJournal), true, "legacy completion is not inferred from this home's absent recovery");
    assert.equal(JSON.parse(readFileSync(executionDescriptorPath(installed), "utf8")).previous, undefined);
    assert.equal(existsSync(third.root), true);
    completeExecutionTransaction(installed, legacyJournal);
    clean();
    assert.equal(existsSync(legacyJournal), false, "explicit completion is the installation-wide retirement authority");

    mkdirSync(join(store, ".installing-Lk1234"));
    const workspace = new URL("../../packages/workspace/dist/index.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `const{claimGlobalNpmUpdateLock}=await import(${JSON.stringify(workspace)});const release=claimGlobalNpmUpdateLock(${JSON.stringify(dirname(installed))});process.stdout.write('held\\n');process.stdin.resume();process.stdin.on('end',()=>{release();process.exit(0)});`], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.stdout.once("data", () => resolve()); child.once("exit", code => { if (code !== 0) reject(new Error(`lock child ${code}`)); }); });
      clean();
      assert.equal(existsSync(join(store, ".installing-Lk1234")), true, "another live updater causes cleanup to skip");
    } finally {
      const ended = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.stdin.end();
      await ended;
    }
    clean();
    assert.equal(existsSync(join(store, ".installing-Lk1234")), false);
    const blocked = join(store, ".installing-Err123");
    mkdirSync(join(blocked, "child"), { recursive: true });
    writeFileSync(join(blocked, "child", "data"), "held");
    chmodSync(join(blocked, "child"), 0o500);
    const beforeWarning = warnings.length;
    try {
      clean();
      if (process.getuid?.() !== 0) {
        assert.equal(warnings.length, beforeWarning + 1, "actual removal failure reports one line");
        assert.equal(existsSync(blocked), true, "failed removal remains for a later attempt");
      }
    } finally { chmodSync(join(blocked, "child"), 0o700); rmSync(blocked, { recursive: true, force: true }); }

    const startup = readFileSync(new URL("../daemon/command.ts", import.meta.url), "utf8");
    const update = readFileSync(new URL("../daemon/update-entry.ts", import.meta.url), "utf8");
    const completion = readFileSync(new URL("../daemon/execution-update.ts", import.meta.url), "utf8");
    assert(startup.indexOf("cleanupExecutionStore(executionInstallRoot(), undefined, extensionSetCleanupSpec())") > startup.indexOf("await recoverInterruptedUpdate(recoveryRuntime, true)"));
    assert(update.indexOf("cleanupExecutionStore(executionInstallRoot(), undefined, extensionSetCleanupSpec())") < update.indexOf("await update(args,"));
    assert(completion.includes("completeExecutionTransaction(installed, journal)"));
    const bootstrap = readFileSync(new URL("../cotal.ts", import.meta.url), "utf8");
    assert(!bootstrap.includes("cleanupExecutionStore("), "normal bootstrap launch cannot collect gigabytes");

    const otherInstall = join(scratch, "shared/lib/node_modules/cotal-ai");
    cpSync(installed, otherInstall, { recursive: true });
    // An in-place package-manager copy has no descriptor in its new store yet.
    const legacy: { journal: string; root: string }[] = [];
    for (const version of ["0.5.0", "0.6.0", "0.7.0"]) {
      writeFileSync(join(source, "package.json"), JSON.stringify({ name: "cotal-ai", version, bin: { cotal: "./dist/cotal.js" } }));
      const retained = retainExecutionGeneration(otherInstall, source);
      const journal = journalExecutionTransaction(otherInstall, retained);
      publishExecutionTransaction(otherInstall, journal);
      legacy.push({ journal, root: retained.root });
    }
    const homeA = join(scratch, "home-a"), homeB = join(scratch, "home-b");
    mkdirSync(homeA, { mode: 0o700 }); mkdirSync(homeB, { mode: 0o700 });
    const env = (home: string) => ({ ...process.env, HOME: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: join(home, "config") });
    const paused = spawnSync(process.execPath, ["--input-type=module", "-e", `const{claimUpdateClosureAccess,writeUpdateRecovery}=await import(${JSON.stringify(workspace)});const release=claimUpdateClosureAccess();try{writeUpdateRecovery({previous:'0.4.0',target:'0.5.0',installed:'0.5.0',phase:'paused',reason:'cross-home smoke',execution:${JSON.stringify(legacy[0].journal)}})}finally{release()}`], { env: env(homeA), encoding: "utf8" });
    assert.equal(paused.status, 0, paused.stderr);
    const module = new URL("../dist/execution-store.js", import.meta.url).href;
    const otherHome = spawnSync(process.execPath, ["--input-type=module", "-e", `const{cleanupExecutionStore}=await import(${JSON.stringify(module)});cleanupExecutionStore(${JSON.stringify(otherInstall)});`], { env: env(homeB), encoding: "utf8" });
    assert.equal(otherHome.status, 0, otherHome.stderr);
    assert.equal(otherHome.stderr.trim().split("\n").length, 1);
    assert.equal(existsSync(join(homeA, ".cotal/update-recovery.json")), true);
    assert.equal(existsSync(legacy[0].journal), true, "different Cotal home cannot retire an unmarked paused journal");
    assert.equal(existsSync(legacy[0].root), true, "different Cotal home cannot retire the paused target");

    // The installation advances successfully once more. Its explicit completion supersedes only
    // the exact linked history of this installation, not every unmarked transaction in the store.
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.8.0", bin: { cotal: "./dist/cotal.js" } }));
    const successor = retainExecutionGeneration(otherInstall, source);
    const successorJournal = journalExecutionTransaction(otherInstall, successor);
    publishExecutionTransaction(otherInstall, successorJournal);
    completeExecutionTransaction(otherInstall, successorJournal);
    const successorCleanup = spawnSync(process.execPath, ["--input-type=module", "-e", `const{cleanupExecutionStore}=await import(${JSON.stringify(module)});cleanupExecutionStore(${JSON.stringify(otherInstall)});`], { env: env(homeB), encoding: "utf8" });
    assert.equal(successorCleanup.status, 0, successorCleanup.stderr);
    assert.equal(successorCleanup.stderr, "");
    for (const prior of legacy) assert.equal(existsSync(prior.journal), false, "completed successor marks and retires its exact legacy ancestry");
    assert.equal(existsSync(legacy[0].root), true, "oldest legacy generation remains");
    assert.equal(existsSync(legacy[1].root), true, "earlier legacy generation remains");
    assert.equal(existsSync(legacy[2].root), true, "immediately replaced legacy generation stays");
    assert.equal(existsSync(successor.root), true);
    assert.equal(readdirSync(executionStore(otherInstall)).filter(name => /^[a-f0-9]{32}$/.test(name)).length, 4);
    assert.equal(selectExecutionProgram(otherInstall).root, successor.root);
    console.log("execution store cleanup: all generations retained, completed transactions and abandoned staging retired, pending recovery and foreign lock preserved");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
