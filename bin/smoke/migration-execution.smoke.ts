import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireMaintenanceLock, assertMaintenanceLock, readMaintenanceResumeDocument, releaseMaintenanceLock, writeMaintenanceResumeDocument } from "@cotal-ai/workspace";
import { captureMigrationNode, verifyMigrationNode } from "@cotal-ai/cli/migration-node";
import { captureMigrationExecution, verifyMigrationExecution } from "../migration-execution.js";
import { cleanupExecutionStore } from "../execution-store.js";
import { executionDescriptorPath } from "../cotal.js";

if (process.platform !== "linux") throw new Error("migration execution live acceptance requires Linux");
process.umask(0o077);
const originalVersion = "0.164.16";
const childMode = process.argv[2] === "--fixture";
const fixture = childMode ? realpathSync.native(process.argv[3]!) : realpathSync.native(mkdtempSync(join(tmpdir(), "migration-execution-")));
const installedRoot = join(fixture, "prefix/lib/node_modules/cotal-ai");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (command: string, args: string[], label: string, env: NodeJS.ProcessEnv, timeout = 30_000) => {
  const result = spawnSync(command, args, { cwd: join(fixture, "work"), env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(fixture, `${label}.stdout`), result.stdout ?? "", { mode: 0o600, flag: "wx" });
  writeFileSync(join(fixture, `${label}.stderr`), result.stderr ?? "", { mode: 0o600, flag: "wx" });
  assert.equal(result.error, undefined, `${label} failed; private output retained at ${fixture}`);
  assert.equal(result.status, 0, `${label} exited ${result.status}; private output retained at ${fixture}`);
  return result.stdout;
};

if (!childMode) {
  for (const name of ["home", "tmp", "run", "bin", "work", "project"]) mkdirSync(join(fixture, name));
  const node = join(fixture, "bin/node");
  copyFileSync(process.execPath, node); chmodSync(node, 0o700);
  const home = join(fixture, "home");
  const env = {
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: join(fixture, "run"), COTAL_HOME: join(home, ".cotal"), CLAUDE_CONFIG_DIR: join(home, ".claude"), TMPDIR: join(fixture, "tmp"),
    PATH: `${dirname(node)}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, DO_NOT_TRACK: "1", COTAL_NO_UPDATE_CHECK: "1",
  };
  run("npm", ["install", "--global", "--prefix", join(fixture, "prefix"), `cotal-ai@${originalVersion}`, "--ignore-scripts", "--no-audit", "--no-fund"], "install", env, 180_000);
  const target = JSON.parse(run("npm", ["view", "cotal-ai", "version", "--json"], "registry-target", env)) as unknown;
  assert.ok(typeof target === "string" && /^\d+\.\d+\.\d+$/.test(target) && target !== originalVersion, "native updater needs a following published version");
  writeFileSync(join(fixture, "target.json"), JSON.stringify(target), { mode: 0o600, flag: "wx" });
  console.log(`migration execution fixture retained at ${fixture}`);
  console.log(run(node, ["--import", import.meta.resolve("tsx/esm"), fileURLToPath(import.meta.url), "--fixture", fixture], "checks", env, 360_000));
} else {
  assert.equal(realpathSync.native(process.execPath), join(fixture, "bin/node"));
  mkdirSync(join(fixture, "project/.cotal"));
  const lock = acquireMaintenanceLock(join(fixture, "project/.cotal"));
  let count = 0, released = false;
  const cell = (name: string, fn: () => void) => { fn(); console.log(`ok ${++count} ${name}`); };
  try {
    const inventory = { fixture: "manager-inventory-unchanged" };
    const result = captureMigrationExecution({ lock, installedRoot, verifiedSource: installedRoot,
      record: reference => writeMaintenanceResumeDocument(lock, { version: 1, inventory, launch: { kind: "native-node-fixture", migrationExecution: JSON.parse(JSON.stringify(reference)) } }),
    });
    const { reference, resume } = result, directory = dirname(reference.generation.root), node = reference.node.retainedPath;
    writeFileSync(join(fixture, "capture.json"), JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
    cell("retains the real published generation", () => assert.equal(reference.generation.version, originalVersion));
    cell("records the actual running Node", () => assert.equal(reference.node.sourcePath, process.execPath));
    cell("retained executable is private", () => assert.equal(lstatSync(node).mode & 0o777, 0o700));
    cell("resume launch metadata binds the complete receipt", () => assert.deepEqual(JSON.parse(JSON.stringify(readMaintenanceResumeDocument(lock.root, resume).launch)), { kind: "native-node-fixture", migrationExecution: reference }));
    cell("does not change the caller's inventory", () => assert.equal(JSON.stringify(readMaintenanceResumeDocument(lock.root, resume).inventory), JSON.stringify(inventory)));
    cell("does not activate the retained generation", () => assert.equal(existsSync(executionDescriptorPath(installedRoot)), false));
    cell("verifies package and Node under native locks", () => verifyMigrationExecution(lock, installedRoot, reference));
    cell("refuses overwriting an existing Node", () => assert.throws(() => captureMigrationNode(lock, directory), /EEXIST/));
    cell("refuses a receipt for a different generation", () => assert.throws(() => verifyMigrationExecution(lock, installedRoot, { ...reference, generation: { ...reference.generation, id: "0".repeat(32) } }), /does not name/));
    cell("refuses extra receipt fields", () => assert.throws(() => verifyMigrationExecution(lock, installedRoot, Object.assign({}, reference, { extra: true }))));
    const fault = join(fixture, "fault-generation"); mkdirSync(fault); const faultNode = join(fault, "node");
    copyFileSync(node, faultNode); chmodSync(faultNode, 0o700);
    const faultRecord = { ...reference.node, retainedPath: faultNode };
    cell("verifies the standalone copied Node control", () => verifyMigrationNode(lock, fault, faultRecord));
    chmodSync(faultNode, 0o750);
    cell("refuses a nonprivate retained executable", () => assert.throws(() => verifyMigrationNode(lock, fault, faultRecord), /private copy/));
    chmodSync(faultNode, 0o700); writeFileSync(faultNode, "corrupt fixture executable");
    cell("refuses corrupt bytes before execution", () => assert.throws(() => verifyMigrationNode(lock, fault, faultRecord)));
    copyFileSync(node, faultNode); chmodSync(faultNode, 0o700); linkSync(faultNode, join(fault, "second-link"));
    cell("refuses a hardlinked executable", () => assert.throws(() => verifyMigrationNode(lock, fault, faultRecord), /single-link/));
    renameSync(reference.node.sourcePath, `${reference.node.sourcePath}.retired`);
    cell("original Node path is unavailable", () => assert.equal(existsSync(reference.node.sourcePath), false));
    cell("verification never resolves the removed original", () => verifyMigrationExecution(lock, installedRoot, reference));
    const env = { ...process.env, PATH: `${dirname(node)}:${process.env.PATH}`, npm_config_prefix: join(fixture, "prefix") };
    const version = run(node, [join(reference.generation.root, "dist/cotal.js"), "--version"], "retained-before", env);
    cell("retained package runs on retained Node", () => assert.equal(version.split("\n")[0], `cotal-ai ${originalVersion}`));
    const beforeNode = hash(node), beforeInventory = hash(join(directory, "inventory.json"));
    run(node, [join(installedRoot, "dist/cotal.js"), "update", "--self"], "real-update", env, 240_000);
    const after = run(node, [join(installedRoot, "dist/cotal.js"), "--version"], "installed-after", env);
    const target: unknown = JSON.parse(readFileSync(join(fixture, "target.json"), "utf8"));
    cell("ordinary updater advances the same installation", () => assert.equal(after.split("\n")[0], `cotal-ai ${target}`));
    const warnings: string[] = []; cleanupExecutionStore(installedRoot, line => warnings.push(line));
    writeFileSync(join(fixture, "cleanup-warnings.json"), JSON.stringify(warnings), { mode: 0o600, flag: "wx" });
    // The published 0.164.16 updater predates the native transaction completion marker.
    cell("native cleanup retains the unmarked old update transaction", () => assert.deepEqual(warnings, ["execution store cleanup: unmarked transaction retained because completion is not proven for every Cotal home"]));
    cell("update and cleanup retain Node bytes", () => assert.equal(hash(node), beforeNode));
    cell("update and cleanup retain the original inventory", () => assert.equal(hash(join(directory, "inventory.json")), beforeInventory));
    cell("old generation still verifies after update", () => verifyMigrationExecution(lock, installedRoot, reference));
    const old = run(node, [join(reference.generation.root, "dist/cotal.js"), "--version"], "retained-after", env);
    cell("old package still executes after ordinary update", () => assert.equal(old.split("\n")[0], `cotal-ai ${originalVersion}`));
    cell("helpers did not release the root lock", () => assertMaintenanceLock(lock));
    releaseMaintenanceLock(lock); released = true;
    cell("verification refuses a released root lock", () => assert.throws(() => verifyMigrationExecution(lock, installedRoot, reference)));
    console.log(`PASS ${count}/${count} native retained Node checks; ordinary update ${originalVersion} to ${target}`);
  } finally { if (!released) releaseMaintenanceLock(lock); }
}
