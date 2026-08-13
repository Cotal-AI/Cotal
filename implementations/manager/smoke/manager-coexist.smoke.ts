/**
 * TWO-MANAGERS-ONE-SPACE coexistence smoke (control-surface P2 item 3, slice 3b-1: demote the lease).
 *
 * The ratified construction: two managers in ONE space = two WORKSPACE ROOTS (each persists its own
 * logical instanceId). Today the manager lease is a per-space SINGLETON (one `MANAGER_LEASE_KEY`), so
 * the second manager REFUSES to start ("a manager already serves space X"). The 3b-1 demotion (D9):
 * the lease becomes per-logical-instance LIVENESS (a key per instanceId) — two managers coexist, each
 * holds its OWN lease, and lease loss stops THAT instance only (security pin 6), never the space.
 *
 * RED-FIRST: against the current singleton lease, "both managers register + coexist" FAILS by design.
 *
 * Run: pnpm smoke:manager-coexist   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { probeConnect } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "mgr-coexist";
const mkRoot = (): string => { const r = mkdtempSync(join(tmpdir(), "cotal-coexist-ws-")); mkdirSync(join(r, ".cotal", "agents"), { recursive: true }); return r; };
const root1 = mkRoot();
const root2 = mkRoot();

type MgrPriv = { managerInstanceId: string; serviceServe?: { grant: { instanceId: string } } };
const kids: ChildProcess[] = [];
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-coexist-js-"))], { stdio: "ignore" });
  kids.push(broker);
  for (let i = 0; i < 60; i++) { if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break; await wait(120); }
  for (const r of [root1, root2]) recordMesh({ space: SPACE, server: SERVER, root: r, mode: "open", ts: new Date().toISOString() });

  // Manager 1 (workspace root 1).
  m1 = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root1 });
  await m1.start();
  const M1 = m1 as unknown as MgrPriv;
  check("manager 1 registered its own logical instance", M1.serviceServe !== undefined);

  // Manager 2 (workspace root 2, SAME space) — must COEXIST, not refuse at a per-space singleton lease.
  m2 = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root2 });
  let m2Err: string | undefined;
  try { await m2.start(); } catch (e) { m2Err = (e as Error).message; }
  const M2 = m2 as unknown as MgrPriv;
  check("manager 2 in a SECOND workspace root COEXISTS (no per-space singleton refusal)", m2Err === undefined, m2Err);
  check("the two managers hold DISTINCT logical instance ids (two roots = two ids)",
    M1.serviceServe !== undefined && M2.serviceServe !== undefined
    && M1.managerInstanceId !== M2.managerInstanceId, { i1: M1.managerInstanceId, i2: M2.managerInstanceId });
  check("both registrations are live under their own instance id (neither superseded the other)",
    M1.serviceServe?.grant.instanceId === M1.managerInstanceId
    && M2.serviceServe?.grant.instanceId === M2.managerInstanceId);
} finally {
  await m2?.stop().catch(() => {});
  await m1?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
}

console.log(`\n${fail === 0 ? "MANAGER COEXIST SMOKE OK ✅" : "MANAGER COEXIST SMOKE FAILED (RED-FIRST until the lease is demoted to per-instance liveness)"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
