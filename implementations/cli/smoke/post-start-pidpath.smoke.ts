/** Built lifecycle entrypoints with real pidfile resolution and provider callbacks.
 * Process launch/identity/readiness are stubbed, so no daemon is started or signalled. */
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import type { AuthPrepared } from "@cotal-ai/core";
import * as workspace from "@cotal-ai/workspace";
import * as selfExec from "../dist/lib/self-exec.js";

const root = mkdtempSync(join(tmpdir(), "cotal-post-start-pidpath-"));
const meshA = join(root, "mesh-a"), meshB = join(root, "mesh-b");
for (const mesh of [meshA, meshB]) mkdirSync(join(mesh, ".cotal"), { recursive: true });
const cwd = process.cwd();
const space = "post-start";
const key = workspace.spaceKey(space);
const launchedPid = 12345;
let launches = 0, cells = 0;
let onRead: ((path: string) => void) | undefined;
let capabilityChecks = 0, allowReady = false;
let beforeCapability: (() => void) | undefined;
const check = (name: string): void => { cells++; console.log(`PASS ${name}`); };

try {
  // Mock only process boundaries. Path resolution, parsing and pidfile reads stay native.
  mock.module("node:child_process", { namedExports: {
    ...childProcess,
    spawn: () => { launches++; return { pid: launchedPid, unref() {} }; },
  } });
  mock.module(new URL("../dist/lib/self-exec.js", import.meta.url), {
    namedExports: { ...selfExec, selfArgv: () => [process.execPath, "fixture-entry"] },
  });
  mock.module("@cotal-ai/workspace", { namedExports: {
    ...workspace,
    identityRecord: (pid: number) => ({ pid, token: "fixture-start" }),
    assertRecordIdentity: () => ({ kind: "match" }),
    writePidPair: (path: string, pid: number) => writeFileSync(path, String(pid)),
    assertManagerCanSpare: () => {
      capabilityChecks++;
      beforeCapability?.();
      if (allowReady && capabilityChecks > 1) return {};
      throw new Error("fixture manager not ready");
    },
    readPidfile: (path: string) => {
      const raw = workspace.readPidfile(path);
      onRead?.(path);
      return raw;
    },
  } });
  const { ensureAuthService } = await import("../dist/lib/auth-proc.js");
  const { ensureManager } = await import("../dist/lib/manager-proc.js");

  async function authCase(name: string, initial: "canonical" | "legacy" | "absent" | "contested",
    duringReady: (canonical: string, legacy: string) => void, success = false): Promise<void> {
    const mesh = join(root, name);
    mkdirSync(join(mesh, ".cotal"), { recursive: true });
    process.chdir(mesh);
    const canonical = join(mesh, ".cotal", `auth-service.${key}.pid`);
    const legacy = join(mesh, ".cotal", `auth-service.${encodeURIComponent(space)}.pid`);
    const expected = initial === "legacy" ? legacy : canonical;
    if (initial !== "absent") writeFileSync(expected, initial === "contested" ? "unattributable" : String(process.pid));
    const prepared: AuthPrepared = { extraAccounts: [], publicAuth: {}, service: {
      command: "fixture-auth",
      ready: async ({ pid }) => {
        assert.equal(pid, initial === "absent" ? launchedPid : initial === "contested" ? undefined : process.pid);
        duringReady(canonical, legacy);
        if (success) return { ready: true };
        throw new Error("fixture provider readiness failed");
      },
    } };
    const run = () => ensureAuthService({ space, server: "nats://127.0.0.1:1", stateDir: mesh, prepared });
    if (success) assert.deepEqual(await run(), { ready: true });
    else await assert.rejects(run, { message: `fixture provider readiness failed - the daemon's pid is recorded at ${expected}, its log is at ${join(mesh, ".cotal", `auth-service.${key}.log`)}` });
    if (initial === "contested") assert.equal(workspace.readPidfile(canonical), "unattributable");
    check(name);
  }

  await authCase("auth-control", "canonical", () => {});
  await authCase("auth-both-appear", "canonical", (_canonical, legacy) => writeFileSync(legacy, String(process.pid)));
  await authCase("auth-record-moves", "canonical", (canonical, legacy) => renameSync(canonical, legacy));
  await authCase("auth-legacy-control", "legacy", () => {});
  await authCase("auth-legacy-moves", "legacy", (canonical, legacy) => renameSync(legacy, canonical));
  await authCase("auth-root-changes", "canonical", () => process.chdir(meshB));
  await authCase("auth-ready-control", "canonical", () => {}, true);
  assert.equal(launches, 0, "reusing live auth records starts no daemon");
  await authCase("auth-launched-path", "absent", (canonical, legacy) => renameSync(canonical, legacy));
  assert.equal(launches, 1, "fresh auth start reaches the launch boundary once");
  await authCase("auth-contested-slot", "contested", (_canonical, legacy) => writeFileSync(legacy, String(process.pid)));
  assert.equal(launches, 1, "an unattributable slot is never stolen");

  // Initial ambiguity must still refuse before the provider, not degrade to one spelling.
  process.chdir(meshA);
  for (const name of [`auth-service.${key}.pid`, `auth-service.${encodeURIComponent(space)}.pid`])
    writeFileSync(join(meshA, ".cotal", name), String(process.pid));
  await assert.rejects(() => ensureAuthService({ space, server: "nats://127.0.0.1:1", stateDir: meshA,
    prepared: { extraAccounts: [], publicAuth: {}, service: { command: "fixture-auth", ready: async () => { assert.fail("ambiguous initial record reached provider"); } } },
  }), /ambiguous auth-service record/);
  check("auth-initial-ambiguity-stays-loud");

  async function managerCase(name: string, move: "none" | "legacy" | "both" | "root", matching = false): Promise<void> {
    const mesh = join(root, name);
    mkdirSync(join(mesh, ".cotal"), { recursive: true });
    process.chdir(mesh);
    const canonical = join(mesh, ".cotal", `manager.${key}.pid`);
    const legacy = join(mesh, ".cotal", "manager.pid");
    const reads: string[] = [];
    capabilityChecks = 0;
    allowReady = matching;
    onRead = path => {
      reads.push(path);
      assert.equal(path, canonical);
      if (move === "legacy") renameSync(canonical, legacy);
      if (move === "both") writeFileSync(legacy, String(launchedPid));
      if (move === "root") process.chdir(meshB);
    };
    beforeCapability = matching ? undefined : () => writeFileSync(canonical, String(launchedPid + 1));
    const run = () => ensureManager({ space }, () => "dead", () => { throw new Error("fixture forbids process command reads"); });
    if (matching) {
      assert.deepEqual(await run(), { running: true, started: true, pid: launchedPid });
      assert.equal(capabilityChecks, 2);
    } else {
      await assert.rejects(run, error => error instanceof Error && error.message.includes(`lost ${canonical} to another process`));
    }
    assert.deepEqual(reads, [canonical]);
    check(name);
    onRead = undefined;
    beforeCapability = undefined;
  }
  await managerCase("manager-matching-control", "none", true);
  await managerCase("manager-lost-control", "none");
  await managerCase("manager-record-moves", "legacy");
  await managerCase("manager-both-appear", "both");
  await managerCase("manager-root-changes", "root");
  console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells} failed=0`);
} finally {
  onRead = undefined;
  mock.restoreAll();
  process.chdir(cwd);
  // Keep fixture files as diagnostic evidence for callers retaining their private TMPDIR.
  console.log("POST_START_PIDPATH_TERMINAL");
}
