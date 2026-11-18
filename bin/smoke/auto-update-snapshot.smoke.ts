import "../../implementations/cli/smoke/update-isolation.js";
import assertions from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, symlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { writeUpdateRecovery, readUpdateRecovery, clearUpdateRecovery, claimUpdateClosureAccess, connectorConfigDir, retainConnectorConfig } from "@cotal-ai/workspace";
import { snapshotUpdateClosure } from "../../implementations/cli/src/lib/update-snapshot.js";
import { countedAssert, emitSentinel } from "./sentinel.mjs";

const counted = countedAssert(assertions);
const assert: typeof assertions = counted.assert as typeof assertions;
const cells = counted.cells;
// The physical path: macOS keeps its temporary folder behind the /var symbolic link, which the
// config protection check refuses.
const root = realpathSync(mkdtempSync(join(tmpdir(), "update-snapshot-")));
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
