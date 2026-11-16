import strictAssert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { probeLiveness } from "@cotal-ai/workspace/liveness";
import { createHostedManagers } from "../daemon/manager.js";
import { processBirth } from "../daemon/lifetime.js";
import { countedAssert, emitSentinel } from "./sentinel.mjs";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const home = mkdtempSync(join(tmpdir(), "cotal-generation-owner-"));
const managers = createHostedManagers(home);
let child: ChildProcess | undefined;

// Synthetic authenticated-owner boundary: these records use the server's peer tuple
// grammar, but are constructed here, not obtained through an authenticated socket.
// Process birth, liveness, and death below are native observations, not stubs.
function owner(pid: number, birth: string): string {
  return JSON.stringify(["peer", process.getuid?.() ?? 0, pid, birth]);
}
async function prepared(expected: boolean, label: string): Promise<void> {
  const evidence = await managers.preparedGenerationEvidence();
  assert.deepEqual(evidence, { prepared: expected, managers: [] }, label);
}
async function heldFor(ms: number, label: string): Promise<void> {
  const deadline = performance.now() + ms;
  do {
    await prepared(true, label);
    await pause(Math.min(100, Math.max(1, deadline - performance.now())));
  } while (performance.now() < deadline);
  await prepared(true, label);
}
async function released(label: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while ((await managers.preparedGenerationEvidence()).prepared && performance.now() < deadline) await pause(50);
  await prepared(false, label);
}
async function startChild(): Promise<{ pid: number; birth: string; record: string }> {
  assert.equal(child, undefined, "at most one owned child exists");
  child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const pid = child.pid;
  assert.ok(pid, "owned child has an exact PID");
  const birth = processBirth(pid);
  assert.equal(typeof birth, "string", "native birth observation is required, not simulated unknown custody");
  if (birth === undefined) throw new Error("native child birth unavailable");
  assert.equal(probeLiveness(pid), "alive", "native child is live");
  return { pid, birth, record: owner(pid, birth) };
}
async function killChild(): Promise<void> {
  const owned = child;
  if (!owned) return;
  if (owned.exitCode === null && owned.signalCode === null) {
    const exited = once(owned, "exit");
    assert.equal(owned.kill("SIGKILL"), true, "terminate only the exact owned child");
    await exited;
  }
  child = undefined;
}

try {
  await prepared(false, "empty hosted set starts unprepared");
  const first = await startChild();
  await managers.prepareGenerationRestart(first.record);
  await heldFor(2200, "live native owner retains prepared state across reaper ticks");
  await killChild();
  assert.equal(probeLiveness(first.pid), "dead", "SIGKILL and exit observation establish native death");
  await released("native owner death releases within five seconds");

  const second = await startChild();
  // This is simulated PID reuse, not an observed kernel reuse or unknown birth.
  const mismatch = owner(second.pid, `${second.birth}:simulated-reuse`);
  await managers.prepareGenerationRestart(mismatch);
  await released("mismatched birth releases even while PID remains alive");
  assert.equal(probeLiveness(second.pid), "alive", "birth mismatch did not kill the process");

  for (const legacy of ["legacy-owner", "{malformed", JSON.stringify(["peer", 0, second.pid])]) {
    await managers.prepareGenerationRestart(legacy);
    await heldFor(1200, "malformed or legacy owner is conservatively retained");
    await managers.abortGenerationRestart(legacy);
    await prepared(false, "explicit legacy owner abort releases");
  }

  await managers.prepareGenerationRestart(second.record);
  await managers.prepareGenerationRestart(first.record);
  await heldFor(2200, "dead owner cannot unfence another live owner");
  await managers.abortGenerationRestart(second.record);
  await released("last live owner abort leaves no dead owner fence");

  await managers.prepareGenerationRestart(second.record);
  const aborted = managers.abortGenerationRestart(second.record);
  const reacquired = managers.prepareGenerationRestart(second.record);
  await Promise.all([aborted, reacquired]);
  await heldFor(2200, "same-owner queued abort and reacquire retains future owner (ABA)");
  await managers.abortGenerationRestart(second.record);
  await prepared(false, "final owner abort releases stable prepared state");
} finally {
  try { await killChild(); }
  finally {
    await managers.close();
    console.log(`Retained generation-owner fixture: ${home}`);
  }
}

// Not acceptance coverage: no socket authentication, unknown-native probe injection,
// hosted manager IPC, or partial-prepare timeout fixture is exercised here.
emitSentinel({ passed: counted.cells(), failed: 0 });
