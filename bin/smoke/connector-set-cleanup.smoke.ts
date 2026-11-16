import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupExecutionStore, type ConnectorSetCleanup } from "../execution-store.js";

if (["linux", "darwin"].includes(process.platform)) {
  const scratch = mkdtempSync(join(tmpdir(), "connector-set-cleanup-"));
  const installed = join(scratch, "prefix/lib/node_modules/cotal-ai"), root = join(scratch, "config/installs/0123456789abcdef/sets");
  mkdirSync(installed, { recursive: true }); mkdirSync(root, { recursive: true, mode: 0o700 });
  const warnings: string[] = [];
  const create = (version: string) => { mkdirSync(join(root, version, "extensions"), { recursive: true, mode: 0o700 }); writeFileSync(join(root, version, "extensions/data"), version, { mode: 0o600 }); };
  const spec: ConnectorSetCleanup = { root, installRoot: installed, current: "0.4.0", previous: "0.3.0", holders: [{ version: "0.2.0", state: "live" }, { version: "0.1.0", state: "unknown" }] };
  const clean = (value: ConnectorSetCleanup = spec) => cleanupExecutionStore(installed, line => warnings.push(line), value);
  try {
    for (const version of ["0.0.1", "0.1.0", "0.2.0", "0.3.0", "0.4.0"]) create(version);
    cleanupExecutionStore(installed, line => warnings.push(line));
    assert.equal(existsSync(join(root, "0.0.1")), true, "absent spec leaves connector data untouched");
    clean();
    assert.deepEqual(readdirSync(root).sort(), ["0.1.0", "0.2.0", "0.3.0", "0.4.0"], "without an execution store, sets still keep current/previous/live/unknown only");
    assert.equal(warnings.length, 0);
    create("0.0.2");
    clean({ ...spec, holders: [{ state: "unknown" }] });
    assert.equal(existsSync(join(root, "0.0.2")), true, "unversioned unknown holder keeps every set");
    clean({ ...spec, holders: [{ state: "live" }] });
    assert.equal(existsSync(join(root, "0.0.2")), true, "unversioned live holder is conservatively unknown");
    clean({ ...spec, holders: [] });
    assert.deepEqual(readdirSync(root).sort(), ["0.3.0", "0.4.0"], "gone records are omitted by resolver and no longer pin old sets");

    const outside = join(scratch, "outside"); mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "keep");
    create("0.0.3"); symlinkSync(outside, join(root, "0.0.3/extensions/peer"));
    clean();
    assert.equal(existsSync(join(root, "0.0.3")), false, "owned peer symlink is removed without following it");
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
    symlinkSync(outside, join(root, "0.0.4"));
    const before = warnings.length;
    clean();
    assert.equal(warnings.length, before + 1, "symlink set root warns once");
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
    rmSync(join(root, "0.0.4"));

    create("0.0.5"); chmodSync(join(root, "0.0.5/extensions"), 0o500);
    const failedBefore = warnings.length;
    try { clean(); if (process.getuid?.() !== 0) assert.equal(warnings.length, failedBefore + 1); }
    finally { chmodSync(join(root, "0.0.5/extensions"), 0o700); rmSync(join(root, "0.0.5"), { recursive: true, force: true }); }
    create("0.0.6");
    clean({ ...spec, installRoot: outside });
    assert.equal(existsSync(join(root, "0.0.6")), true, "wrong logical installation cannot select cleanup root");
    clean({ ...spec, current: "../outside" });
    assert.equal(existsSync(join(root, "0.0.6")), true, "invalid version never becomes a deletion path");
    clean({ ...spec, current: "9.9.9" });
    assert.equal(existsSync(join(root, "0.0.6")), true, "missing own current set cannot silently collect existing sets");
    if (process.platform === "linux" && process.getuid?.() !== 0) {
      const foreign = lstatSync("/var/tmp");
      assert.equal(foreign.uid, 0);
      const warningBefore = warnings.length;
      clean({ ...spec, root: "/var/tmp" });
      assert.equal(warnings.length, warningBefore, "foreign-owned root is skipped without mutation or warning");
      assert.equal(existsSync(join(dirname(installed), ".cotal-update.lock")), false);
      assert.equal(lstatSync("/var/tmp").ino, foreign.ino);
    }

    const workspace = new URL("../../packages/workspace/dist/index.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `const{claimGlobalNpmUpdateLock}=await import(${JSON.stringify(workspace)});const release=claimGlobalNpmUpdateLock(${JSON.stringify(dirname(installed))});process.stdout.write('held\\n');process.stdin.resume();process.stdin.on('end',()=>{release();process.exit(0)});`], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.stdout.once("data", () => resolve()); });
      clean();
      assert.equal(existsSync(join(root, "0.0.6")), true, "same global update lock guards set deletion");
    } finally { const ended = new Promise<void>(resolve => child.once("exit", () => resolve())); child.stdin.end(); await ended; }
    clean();
    assert.equal(existsSync(join(root, "0.0.6")), false);
    assert.equal(existsSync(join(root, "0.3.0")), true);
    assert.equal(existsSync(join(root, "0.4.0")), true);
    const module = new URL("../dist/execution-store.js", import.meta.url).href;
    const unavailable = (value: ConnectorSetCleanup) => spawnSync(process.execPath, ["--input-type=module", "-e", `const{cleanupExecutionStore}=await import(${JSON.stringify(module)});Reflect.set(process,'getuid',undefined);cleanupExecutionStore(${JSON.stringify(installed)},line=>process.stdout.write(line+'\\n'),${JSON.stringify(value)});cleanupExecutionStore(${JSON.stringify(installed)},line=>process.stdout.write(line+'\\n'),${JSON.stringify(value)});`], { encoding: "utf8" });
    create("0.0.7");
    const kept = unavailable({ ...spec, holders: [] });
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /requires native ownership support/);
    assert.equal(existsSync(join(root, "0.0.7")), true, "missing POSIX ownership support is not a Windows simulation");
    console.log("connector set cleanup: optional spec, current/previous/live/unknown retention, global lock, path and symlink boundaries, nonfatal removal");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.platform === "win32") await import("./connector-set-cleanup-win32.smoke.js");
