/** Crash/concurrency smoke for update-owned extension mutations (no NATS). */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  beginExtensionNpmMutation,
  beginGlobalUpdateChild,
  claimExtensionMutationLock,
  claimExtensionUpdatePass,
  claimGlobalNpmUpdateLock,
  extensionNpmMutationPath,
  processExitIsAmbiguous,
} from "@cotal-ai/workspace";
import { EXT_UPDATE_PARENT_ENV } from "../src/commands/ext.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await sleep(25);
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const globalChildHelperRoot = process.env.COTAL_UPDATE_GLOBAL_CHILD_HELPER;
if (globalChildHelperRoot) {
  const operation = process.env.COTAL_UPDATE_GLOBAL_CHILD_OPERATION as "install" | "reconcile";
  const ready = process.env.COTAL_UPDATE_GLOBAL_CHILD_READY!;
  const releaseFile = process.env.COTAL_UPDATE_GLOBAL_CHILD_RELEASE!;
  claimGlobalNpmUpdateLock(globalChildHelperRoot);
  const mutation = beginGlobalUpdateChild(globalChildHelperRoot, operation);
  const child = spawn(
    process.execPath,
    ["-e", "const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(process.env.COTAL_CHILD_RELEASE))process.exit(0)},20)"],
    { env: { ...process.env, COTAL_CHILD_RELEASE: releaseFile }, stdio: "ignore" },
  );
  mutation.markLive(child.pid!);
  writeFileSync(ready, String(child.pid));
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

const globalHelperRoot = process.env.COTAL_UPDATE_GLOBAL_LOCK_HELPER;
if (globalHelperRoot) {
  const ready = process.env.COTAL_UPDATE_GLOBAL_LOCK_READY!;
  const releaseFile = process.env.COTAL_UPDATE_GLOBAL_LOCK_RELEASE!;
  const release = claimGlobalNpmUpdateLock(globalHelperRoot);
  writeFileSync(ready, String(process.pid));
  await waitFor(() => existsSync(releaseFile), "global update lock release");
  release();
  process.exit(0);
}

// The global binary mutation is keyed by npm's canonical global root, not by a configurable Cotal
// home. Two update parents using different homes therefore cannot reify the same package tree.
{
  const root = mkdtempSync(join(tmpdir(), "cotal-update-global-lock-"));
  const ready = join(root, "holder-ready");
  const releaseFile = join(root, "holder-release");
  const holder = spawn(
    process.execPath,
    [...process.execArgv, import.meta.filename],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "other-cotal-home"),
        COTAL_UPDATE_GLOBAL_LOCK_HELPER: root,
        COTAL_UPDATE_GLOBAL_LOCK_READY: ready,
        COTAL_UPDATE_GLOBAL_LOCK_RELEASE: releaseFile,
      },
      stdio: "ignore",
    },
  );
  try {
    await waitFor(() => existsSync(ready), "the first global update parent");
    assert.throws(
      () => claimGlobalNpmUpdateLock(root),
      /another cotal-ai update is using npm global root/,
      "a second update parent cannot enter the same npm global root",
    );
    writeFileSync(releaseFile, "release");
    await waitForExit(holder);
    assert.equal(holder.exitCode, 0);
    const release = claimGlobalNpmUpdateLock(root);
    release();
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}

// A fresh npm prefix reports a node_modules root that does not exist yet. Locking establishes it,
// then canonicalizes it so aliases converge on one global mutation key.
{
  const temp = mkdtempSync(join(tmpdir(), "cotal-update-fresh-root-"));
  const root = join(temp, "prefix", "lib", "node_modules");
  try {
    assert.equal(existsSync(root), false);
    const release = claimGlobalNpmUpdateLock(root);
    assert.equal(existsSync(root), true);
    release();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Killing the old update parent cannot orphan either the global npm install or the verified
// reconcile child behind a stale parent-owned lock. The root-scoped child record is authoritative.
if (process.platform !== "win32") {
  for (const operation of ["install", "reconcile"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cotal-update-global-${operation}-`));
    const ready = join(root, "child-ready");
    const releaseFile = join(root, "child-release");
    const holder = spawn(process.execPath, [...process.execArgv, import.meta.filename], {
      env: {
        ...process.env,
        COTAL_UPDATE_GLOBAL_CHILD_HELPER: root,
        COTAL_UPDATE_GLOBAL_CHILD_OPERATION: operation,
        COTAL_UPDATE_GLOBAL_CHILD_READY: ready,
        COTAL_UPDATE_GLOBAL_CHILD_RELEASE: releaseFile,
      },
      stdio: "ignore",
    });
    let childPid: number | undefined;
    try {
      await waitFor(() => existsSync(ready), `${operation} child publication`);
      childPid = Number(readFileSync(ready, "utf8"));
      holder.kill("SIGKILL");
      await waitForExit(holder);
      assert.ok(pidAlive(childPid), `${operation} child survives its old parent`);
      assert.throws(
        () => claimGlobalNpmUpdateLock(root),
        new RegExp(`global ${operation} is still running`),
      );
      writeFileSync(releaseFile, "release");
      await waitFor(() => !pidAlive(childPid!), `${operation} child exit`);
      const release = claimGlobalNpmUpdateLock(root);
      release();
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      if (childPid && pidAlive(childPid)) {
        writeFileSync(releaseFile, "release");
        await waitFor(() => !pidAlive(childPid!), `${operation} child cleanup`).catch(() => process.kill(childPid!, "SIGKILL"));
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// Marker bytes are a fail-closed boundary. Bad PID/start/nonce types are never interpreted as dead
// evidence and deleted, including the reproduced live-PID + numeric-start shape.
{
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "cotal-update-marker-schema-"));
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const path = extensionNpmMutationPath();
    mkdirSync(dirname(path), { recursive: true });
    const malformed = [
      { phase: "live", owner: process.pid, pid: process.pid, start: 123, intermediary: false, nonce: "0".repeat(24) },
      { phase: "live", owner: process.pid, pid: 0, intermediary: false, nonce: "0".repeat(24) },
      { phase: "pending", owner: process.pid, ownerStart: 123, intermediary: false, nonce: "0".repeat(24) },
      { phase: "pending", owner: process.pid, intermediary: false, nonce: "bad" },
    ];
    for (const record of malformed) {
      writeFileSync(path, JSON.stringify(record));
      assert.throws(() => claimExtensionMutationLock(), /process mutation marker is invalid/);
      assert.equal(existsSync(path), true, "invalid evidence is retained for operator inspection");
      rmSync(path);
    }

    assert.equal(processExitIsAmbiguous(1, null, true), true, "a Windows npm intermediary failure is ambiguous");
    assert.equal(processExitIsAmbiguous(0, null, true), false);
    const mutation = beginExtensionNpmMutation();
    mutation.markLive(process.pid);
    mutation.markAmbiguous("Windows npm intermediary exited 1; descendant completion is unproved");
    assert.throws(() => claimExtensionMutationLock(), /ended ambiguously/);
    mutation.clear();

    const failedTransition = beginExtensionNpmMutation(true);
    failedTransition.markLive(process.pid);
    const live = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...live, nonce: "f".repeat(24) }));
    assert.throws(
      () => failedTransition.complete(1, null, "descendant completion is unproved"),
      /marker changed before ambiguity was recorded/,
    );
    assert.equal(existsSync(path), true, "a failed ambiguity transition preserves the prior live evidence");
    assert.throws(() => claimExtensionMutationLock(), /is still running/);
    rmSync(path);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
  }
}

// Windows npm runs through a cmd.exe intermediary, so a killed wrapper can leave the real npm
// mutator alive; the claim must stay fail-closed on that live `intermediary` record until an
// operator repairs. A live cmd.exe / detached-descendant fixture depends on non-deterministic
// Windows process-tree kill timing (too flaky for CI), so the invariant is asserted directly
// against written records here -- platform-agnostic and deterministic.
{
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "cotal-update-intermediary-"));
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const path = extensionNpmMutationPath();
    mkdirSync(dirname(path), { recursive: true });
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid ?? 2 ** 30;
    // Intermediary and wrapper (owner) both gone: the wrapper died before classifying the descendant,
    // so completion is unproved -- the next claim fails closed and keeps the evidence for repair.
    writeFileSync(path, JSON.stringify({ phase: "live", owner: deadPid, pid: deadPid, intermediary: true, nonce: "0".repeat(24) }));
    assert.throws(() => claimExtensionMutationLock(), /intermediary exited after its wrapper died/);
    assert.equal(existsSync(path), true, "wrapper-first death keeps the intermediary evidence for operator repair");
    // Wrapper still alive: it is trusted to finish classifying, so the claim retries rather than fails.
    writeFileSync(path, JSON.stringify({ phase: "live", owner: process.pid, pid: deadPid, intermediary: true, nonce: "0".repeat(24) }));
    assert.throws(() => claimExtensionMutationLock(), /still classifying descendant state/);
    rmSync(path);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
  }
}

if (process.platform !== "win32") {
  const root = mkdtempSync(join(tmpdir(), "cotal-update-orphan-"));
  const xdg = join(root, "xdg");
  const fixture = join(root, "fixture");
  const fakeBin = join(root, "bin");
  const counter = join(root, "npm-count");
  const ready = join(root, "npm-ready");
  const releaseNpm = join(root, "npm-release");
  const secondStarted = join(root, "npm-second-started");
  const pkg = "@cotal-ai/orphan-smoke";
  const priorXdg = process.env.XDG_CONFIG_HOME;
  let wrapper: ChildProcess | undefined;
  let npmPid: number | undefined;
  let releasePass: (() => void) | undefined;
  try {
    mkdirSync(fixture, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({
      name: pkg,
      version: "1.0.0",
      type: "module",
      peerDependencies: { "@cotal-ai/core": "*" },
    }));
    const fakeNpm = join(fakeBin, "npm");
    writeFileSync(fakeNpm, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const count = existsSync(process.env.FAKE_NPM_COUNT) ? Number(readFileSync(process.env.FAKE_NPM_COUNT, "utf8")) + 1 : 1;
writeFileSync(process.env.FAKE_NPM_COUNT, String(count));
if (count > 1) {
  writeFileSync(process.env.FAKE_NPM_SECOND, String(process.pid));
  process.exit(1);
}
writeFileSync(process.env.FAKE_NPM_READY, String(process.pid));
const timer = setInterval(() => {
  if (existsSync(process.env.FAKE_NPM_RELEASE)) {
    clearInterval(timer);
    process.exit(1);
  }
}, 20);
`);
    chmodSync(fakeNpm, 0o755);

    process.env.XDG_CONFIG_HOME = xdg;
    releasePass = claimExtensionUpdatePass();
    const cli = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
    const env = {
      ...process.env,
      COTAL_SKIP_CONNECTOR_SEED: "1",
      [EXT_UPDATE_PARENT_ENV]: String(process.pid),
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPM_COUNT: counter,
      FAKE_NPM_READY: ready,
      FAKE_NPM_RELEASE: releaseNpm,
      FAKE_NPM_SECOND: secondStarted,
    };
    wrapper = spawn(
      process.execPath,
      [...process.execArgv, cli, "ext", "__update-add", pkg, fixture],
      { env, stdio: "ignore" },
    );
    await waitFor(() => existsSync(ready), "the first npm child");
    npmPid = Number(readFileSync(ready, "utf8"));
    assert.ok(pidAlive(npmPid), "the fake npm mutator is live");

    wrapper.kill("SIGKILL");
    await waitForExit(wrapper);
    assert.ok(pidAlive(npmPid), "killing the ext wrapper leaves its npm child alive");

    const second = spawnSync(
      process.execPath,
      [...process.execArgv, cli, "ext", "__update-add", pkg, fixture],
      { env, encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(second.status, 1, second.stderr);
    assert.equal(existsSync(secondStarted), false, "the next replay must stop before spawning npm");

    releasePass();
    releasePass = undefined;
    assert.throws(
      () => claimExtensionMutationLock(),
      /extension npm mutation is still running/,
      "ordinary mutation remains excluded after the dead update parent releases its pass",
    );

    writeFileSync(releaseNpm, "release");
    await waitFor(() => !pidAlive(npmPid!), "the orphan npm child to exit");
    const release = claimExtensionMutationLock();
    release();
  } finally {
    releasePass?.();
    if (npmPid && pidAlive(npmPid)) {
      writeFileSync(releaseNpm, "release");
      await waitFor(() => !pidAlive(npmPid!), "fake npm cleanup").catch(() => process.kill(npmPid!, "SIGKILL"));
    }
    if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
  }
}

console.log("update-concurrency.smoke: all assertions passed");
