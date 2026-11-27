import "../../implementations/cli/smoke/update-isolation.js";
import assertions from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, lstatSync, statSync, chmodSync, symlinkSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { acquireLock, inspectLock, writeUpdateRecovery, readUpdateRecovery, clearUpdateRecovery, claimUpdateClosureAccess, connectorConfigDir, retainConnectorConfig, prepareCotalHomeForWrite, ProtectedRecordStore, protectedResolvedDirectory } from "@cotal-ai/workspace";
import { snapshotUpdateClosure } from "../../implementations/cli/src/lib/update-snapshot.js";
import { reclaimInterruptedUpdateSnapshots } from "../daemon/update-snapshot-cleanup.js";
import { countedAssert, emitSentinel } from "./sentinel.mjs";

const counted = countedAssert(assertions);
const assert: typeof assertions = counted.assert as typeof assertions;
const cells = counted.cells;

function leaveDeadLocks(env: NodeJS.ProcessEnv, code: string, ...args: string[]): void {
  const workspace = import.meta.resolve("@cotal-ai/workspace");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const fs = await import("node:fs");
    const { acquireLock, claimUpdateClosureAccess, claimExtensionMutationLock } = await import(${JSON.stringify(workspace)});
    ${code}
    process.kill(process.pid, "SIGKILL");
  `, ...args], { env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
  assert.ifError(child.error);
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

function verifySnapshotRetention(root: string): void {
  const prior = { HOME: process.env.HOME!, COTAL_HOME: process.env.COTAL_HOME!, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! };
  try {
    for (const scenario of ["own journal", "live closure", "different writer", "symlink", "other journal"]) {
      const home = mkdtempSync(join(root, "keep-"));
      Object.assign(process.env, { HOME: home, COTAL_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config") });
      const config = globalConfigDir(), seed = join(config, "seed");
      const closure = join(process.env.COTAL_HOME!, ".update-closure.lock");
      const reconcile = join(seed, "reconcile.lock"), writer = join(config, ".extensions.lock");
      const snapshot = join(config, ".update-snapshot-Part01");
      mkdirSync(seed, { recursive: true, mode: 0o700 });
      leaveDeadLocks(process.env, `
        const [config, reconcile, snapshot] = process.argv.slice(1);
        claimUpdateClosureAccess();
        acquireLock(reconcile);
        claimExtensionMutationLock({}, config);
        fs.mkdirSync(snapshot, { mode: 0o700 });
        fs.mkdirSync(snapshot + "/seed", { mode: 0o700 });
        fs.writeFileSync(snapshot + "/seed/stamp", "partial copy");
      `, config, reconcile, snapshot);
      const locks = [closure, reconcile, writer];
      for (const path of locks) assert.equal(inspectLock(path).state, "stale", `${scenario}: stale ${path}`);
      const birth = lstatSync(snapshot, { bigint: true }).birthtimeNs;
      assert.ok(birth > 0n, "the fixture needs filesystem birth times");
      const reclaim = () => reclaimInterruptedUpdateSnapshots(() => join(home, "prefix/node_modules"));
      let unblock: () => void;
      if (scenario === "own journal" || scenario === "other journal") {
        const referenced = scenario === "own journal" ? snapshot : join(config, ".update-snapshot-Other1");
        if (referenced !== snapshot) mkdirSync(referenced, { mode: 0o700 });
        writeUpdateRecovery({ previous: "1.0.0", target: "2.0.0", installed: "1.0.0", phase: "paused", snapshot: referenced, reason: "fixture" });
        assert.equal(readUpdateRecovery()?.snapshot, referenced);
        unblock = clearUpdateRecovery;
      } else if (scenario === "live closure" || scenario === "different writer") {
        const path = scenario === "live closure" ? closure : writer;
        const saved = join(home, "dead-lock");
        renameSync(path, saved);
        let clearLock: () => void;
        if (scenario === "live closure") {
          const live = acquireLock(path);
          assert.equal(inspectLock(path).state, "active");
          clearLock = () => live.release();
        } else {
          leaveDeadLocks(process.env, "acquireLock(process.argv[1]);", path);
          // Make the mismatched PID the only reason to keep the copy.
          const beforeCopy = new Date(Number(birth / 1_000_000n) - 1000);
          utimesSync(path, beforeCopy, beforeCopy);
          assert.equal(inspectLock(path).state, "stale");
          assert.notEqual(JSON.parse(readFileSync(path, "utf8")).pid, JSON.parse(readFileSync(closure, "utf8")).pid);
          clearLock = () => unlinkSync(path);
        }
        unblock = () => { clearLock(); renameSync(saved, path); };
      } else {
        const outside = join(home, "outside-config");
        const saved = locks.map((path, index) => {
          const copy = join(home, `lock-${index}`);
          linkSync(path, copy);
          return copy;
        });
        renameSync(snapshot, outside);
        symlinkSync(outside, snapshot);
        unblock = () => {
          assert.ok(lstatSync(snapshot).isSymbolicLink(), "the snapshot-shaped link stays in place");
          assert.equal(readFileSync(join(outside, "seed", "stamp"), "utf8"), "partial copy", "the link target stays untouched");
          unlinkSync(snapshot);
          renameSync(outside, snapshot);
          // The scan can retire the locks even when the entry is skipped. Replay their actual inodes for the positive control.
          locks.forEach((path, index) => { if (!existsSync(path)) linkSync(saved[index]!, path); });
        };
      }
      for (const path of [reconcile, writer]) assert.ok(lstatSync(path, { bigint: true }).mtimeNs <= birth, `${scenario}: snapshot passes the age check`);
      reclaim();
      assert.equal(readFileSync(join(snapshot, "seed", "stamp"), "utf8"), "partial copy", `${scenario}: must keep the copy`);
      unblock();
      reclaim();
      assert.equal(existsSync(snapshot), false, `${scenario}: reclaim after clearing the blocker`);
      console.log(`interrupted snapshot: kept with ${scenario}, reclaimed with matching dead writers`);
    }
  } finally { Object.assign(process.env, prior); }
}

// Keep the fixture physical so linked ancestors below belong to the test.
const root = realpathSync(mkdtempSync(join(tmpdir(), "update-snapshot-")));
if (process.platform === "linux") {
  try { verifySnapshotRetention(root); }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.COTAL_HOME = join(root, "home");
const config = globalConfigDir();
const seed = join(config, "seed"), extensions = join(config, "extensions");
mkdirSync(process.env.COTAL_HOME, { recursive: true, mode: 0o700 });
const release = claimUpdateClosureAccess();
try {
  if (process.platform !== "win32") {
    const unsafe = join(root, "unsafe");
    mkdirSync(unsafe, { mode: 0o700 });
    chmodSync(unsafe, 0o777);
    process.env.XDG_CONFIG_HOME = unsafe;
    assert.throws(() => snapshotUpdateClosure());
    assert.equal(existsSync(join(unsafe, "cotal")), false);
    assert.equal(statSync(unsafe).mode & 0o777, 0o777);
    chmodSync(unsafe, 0o700);
    const linked = join(root, "linked");
    symlinkSync(join(root, "missing-target"), linked);
    process.env.XDG_CONFIG_HOME = linked;
    assert.throws(() => snapshotUpdateClosure());
    assert.equal(existsSync(join(root, "missing-target")), false);
    const physical = join(root, "physical-home"), home = join(root, "linked-home");
    mkdirSync(physical, { mode: 0o700 });
    symlinkSync(physical, home);
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    process.env.COTAL_HOME = join(home, ".cotal");
    prepareCotalHomeForWrite();
    prepareCotalHomeForWrite();
    assert.equal(statSync(join(physical, ".cotal")).mode & 0o777, 0o700);
    const store = new ProtectedRecordStore("services", "linked-home", value => value);
    const directory = store.directory(true)!;
    assert.equal(directory, realpathSync(directory), "service children receive a physical state directory");
    for (let attempt = 0; attempt < 2; attempt++) {
      const linkedSnapshot = snapshotUpdateClosure();
      assert.ok(existsSync(linkedSnapshot.path));
      snapshotUpdateClosure(linkedSnapshot.path).discard();
      assert.equal(existsSync(linkedSnapshot.path), false);
    }
    chmodSync(physical, 0o777);
    assert.throws(() => snapshotUpdateClosure(), /writable/);
    assert.throws(() => prepareCotalHomeForWrite(), /writable/);
    chmodSync(physical, 0o700);
    const linkParent = join(root, "link-parent");
    mkdirSync(linkParent, { mode: 0o700 });
    symlinkSync(physical, join(linkParent, "home"));
    process.env.COTAL_HOME = join(linkParent, "home", ".cotal");
    process.env.XDG_CONFIG_HOME = join(linkParent, "home", "fresh-config");
    const linkedStore = new ProtectedRecordStore("services", "link-parent", value => value);
    chmodSync(linkParent, 0o777);
    assert.throws(() => snapshotUpdateClosure(), /link-parent.*writable/);
    assert.equal(existsSync(join(physical, "fresh-config")), false);
    assert.throws(() => prepareCotalHomeForWrite(), /link-parent.*writable/);
    assert.throws(() => linkedStore.directory(true), /link-parent.*writable/);
    assert.throws(() => linkedStore.directory(), /link-parent.*writable/);
    process.env.COTAL_HOME = join(linkParent, "home", "new-cotal-home");
    assert.throws(() => prepareCotalHomeForWrite(), /link-parent.*writable/);
    assert.equal(existsSync(join(physical, "new-cotal-home")), false);
    process.env.COTAL_HOME = join(linkParent, "home", ".cotal");
    chmodSync(linkParent, 0o1777);
    assert.throws(() => protectedResolvedDirectory(join(linkParent, "home")), /link-parent.*writable/);
    chmodSync(linkParent, 0o700);
    const safeSnapshot = snapshotUpdateClosure();
    safeSnapshot.discard();
    assert.ok(linkedStore.directory(true));
    chmodSync(linkParent, 0o777);
    assert.throws(() => snapshotUpdateClosure(), /link-parent.*writable/);
    assert.throws(() => linkedStore.directory(), /link-parent.*writable/);
    chmodSync(linkParent, 0o700);
    const intermediate = join(root, "intermediate");
    symlinkSync(join(linkParent, "home"), intermediate);
    assert.equal(protectedResolvedDirectory(intermediate), physical);
    chmodSync(linkParent, 0o777);
    assert.throws(() => protectedResolvedDirectory(intermediate), /link-parent.*writable/);
    chmodSync(linkParent, 0o700);
    symlinkSync("link-parent/home/..", join(root, "relative-parent"));
    assert.equal(protectedResolvedDirectory(join(root, "relative-parent")), root);
    symlinkSync("loop", join(root, "loop"));
    assert.throws(() => protectedResolvedDirectory(join(root, "loop")), /too many symbolic links/);
    process.env.COTAL_HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "config");
  }
  assert.equal(existsSync(config), false);
  const fresh = snapshotUpdateClosure();
  assert.ok(existsSync(fresh.path));
  if (process.platform !== "win32") assert.equal(statSync(config).mode & 0o777, 0o700);
  fresh.discard();
  if (process.platform !== "win32") {
    chmodSync(config, 0o755);
    const existing = snapshotUpdateClosure();
    assert.equal(statSync(config).mode & 0o777, 0o755);
    existing.discard();
  }
  for (const dir of [seed, extensions]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, "stamp"), "previous"); }
  const snapshot = snapshotUpdateClosure();
  for (const dir of [seed, extensions]) writeFileSync(join(dir, "stamp"), "replacement");
  writeUpdateRecovery({ previous: "1.0.0", target: "2.0.0", installed: "2.0.0", phase: "restoring", snapshot: snapshot.path, reason: "smoke" });
  snapshot.restore();
  for (const dir of [seed, extensions]) assert.equal(readFileSync(join(dir, "stamp"), "utf8"), "previous");
  assert.ok(readUpdateRecovery()!.renames!.every(entry => entry.done));
  snapshot.discard(); clearUpdateRecovery();

  const resumed = snapshotUpdateClosure();
  writeFileSync(join(seed, "stamp"), "replacement");
  const failed = join(resumed.path, "failed-stamp");
  renameSync(join(seed, "stamp"), failed);
  writeUpdateRecovery({ previous: "1.0.0", target: "2.0.0", installed: "2.0.0", phase: "restoring", snapshot: resumed.path, reason: "resume", renames: [
    { from: join(seed, "stamp"), to: failed, done: true },
    { from: `${resumed.path}${sep}seed${sep}..${sep}seed${sep}stamp`, to: join(seed, "stamp"), done: false },
  ] });
  snapshotUpdateClosure(resumed.path).restore();
  assert.equal(readFileSync(join(seed, "stamp"), "utf8"), "previous");
  assert.equal(readFileSync(failed, "utf8"), "replacement");
  assert.ok(readUpdateRecovery()!.renames!.every(entry => entry.done));
  resumed.discard(); clearUpdateRecovery();

  for (const outside of ["from", "to"] as const) {
    const refused = snapshotUpdateClosure();
    const external = join(root, "outside");
    writeFileSync(external, "untouched");
    writeUpdateRecovery({ previous: "1.0.0", target: "2.0.0", installed: "2.0.0", phase: "restoring", snapshot: refused.path, reason: "refuse", renames: [{
      from: outside === "from" ? external : join(seed, "stamp"),
      to: outside === "to" ? external : join(refused.path, "outside"), done: false,
    }] });
    assert.throws(() => refused.restore(), /invalid update rename path/);
    assert.equal(readFileSync(external, "utf8"), "untouched");
    assert.equal(readFileSync(join(seed, "stamp"), "utf8"), "previous");
    refused.discard(); clearUpdateRecovery();
  }
  if (process.platform === "linux" || process.platform === "darwin") {
    const legacy = snapshotUpdateClosure();
    const entry = join(root, "prefix/lib/node_modules/cotal-ai/dist/cotal.js");
    mkdirSync(join(entry, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(entry, "// installed entry\n");
    writeFileSync(join(entry, "../..", "package.json"), JSON.stringify({ name: "cotal-ai", version: "2.0.0", bin: { cotal: "./dist/cotal.js" } }));
    Object.defineProperty(globalThis, Symbol.for("cotal.execution.identity"), { value: Object.freeze({ logicalEntry: entry, loadedEntry: entry }) });
    const retained = retainConnectorConfig();
    assert.notEqual(retained, config);
    assert.equal(connectorConfigDir(), retained);
    for (const name of ["seed", "extensions"]) {
      writeFileSync(join(config, name, "stamp"), "interrupted canonical");
      writeFileSync(join(retained, name, "stamp"), "target retained");
    }
    writeUpdateRecovery({ previous: "1.0.0", target: "2.0.0", installed: "2.0.0", phase: "paused", snapshot: legacy.path, reason: "interrupted after retained selection" });
    snapshotUpdateClosure(legacy.path).restore();
    for (const name of ["seed", "extensions"]) {
      assert.equal(readFileSync(join(config, name, "stamp"), "utf8"), "previous");
      assert.equal(readFileSync(join(retained, name, "stamp"), "utf8"), "target retained");
    }
    assert.ok(readUpdateRecovery()!.renames!.every(entry => entry.done));
    legacy.discard(); clearUpdateRecovery();
    assert.equal(existsSync(legacy.path), false);
    const previous = join(retained, "..", "..", "1.0.0", "cotal");
    const saved = join(previous, ".update-snapshot-previous");
    for (const name of ["seed", "extensions"]) {
      mkdirSync(join(saved, name), { recursive: true, mode: 0o700 });
      writeFileSync(join(saved, name, "stamp"), "previous snapshot");
      mkdirSync(join(previous, name), { mode: 0o700 });
      writeFileSync(join(previous, name, "stamp"), "previous live");
    }
    const recovery = { previous: "1.0.0", target: "2.0.0", installed: "2.0.0", phase: "restoring", snapshot: saved, reason: "interrupted retained update" } as const;
    writeUpdateRecovery({ ...recovery, previous: "3.0.0" });
    assert.throws(() => snapshotUpdateClosure(saved), /invalid update snapshot/);
    const linkedHome = join(root, "retained-home-alias");
    symlinkSync(root, linkedHome);
    const linkedSnapshot = join(linkedHome, relative(root, saved));
    writeUpdateRecovery({ ...recovery, snapshot: linkedSnapshot });
    const rollback = snapshotUpdateClosure(linkedSnapshot);
    rollback.restore();
    for (const name of ["seed", "extensions"]) {
      assert.equal(readFileSync(join(previous, name, "stamp"), "utf8"), "previous snapshot");
      assert.equal(readFileSync(join(retained, name, "stamp"), "utf8"), "target retained");
    }
    rollback.discard(); clearUpdateRecovery();
    for (const kind of ["missing", "file", "symlink", "foreign"] as const) {
      const path = join(kind === "foreign" ? root : config, `.update-snapshot-${kind}`);
      if (kind === "file") writeFileSync(path, "not a directory");
      if (kind === "symlink") symlinkSync(retained, path);
      if (kind === "foreign") mkdirSync(path, { mode: 0o700 });
      assert.throws(() => snapshotUpdateClosure(path));
      assert.equal(readFileSync(join(retained, "seed", "stamp"), "utf8"), "target retained");
    }
  }
  emitSentinel({ passed: cells(), failed: 0 });
} finally { release(); rmSync(root, { recursive: true, force: true }); }
