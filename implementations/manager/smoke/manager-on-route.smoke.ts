/**
 * INSTANCE-TARGETED ROUTE smoke (control-surface P2 item 3, slice 3b-4: `cotal spawn/ps --on <instance>`).
 *
 * Two managers in one space (two workspace roots, two logical instance ids) each serve their OWN `inst`
 * route (`ep.inst.<endpoint>.<instanceId>.<cmd>`) alongside the class `one` queue. `--on <instance>`
 * resolves the service PINNED to that instance (mode "inst"), so a describe/invoke reaches the EXACT
 * addressed manager, never whichever wins the class anycast. An unknown instance id has no responder —
 * it deadlines, never silently falls through to a peer (no fallbacks).
 *
 * Run: pnpm smoke:manager-on-route   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { connect } from "@nats-io/transport-node";
import { probeConnect, resolveService, invokeCommand, newIdentity, mintLifecycleUid, DEV_OWNER, type EpCaller } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "mgr-on-route";
const mkRoot = (): string => { const r = mkdtempSync(join(tmpdir(), "cotal-onroute-ws-")); mkdirSync(join(r, ".cotal", "agents"), { recursive: true }); return r; };

type MgrPriv = { managerInstanceId: string };
const kids: ChildProcess[] = [];
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-onroute-js-"))], { stdio: "ignore" });
  kids.push(broker);
  for (let i = 0; i < 60; i++) { if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break; await wait(120); }
  const root1 = mkRoot(), root2 = mkRoot();
  for (const r of [root1, root2]) recordMesh({ space: SPACE, server: SERVER, root: r, mode: "open", ts: new Date().toISOString() });

  m1 = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root2 });
  await m1.start();
  await m2.start();
  const IID1 = (m1 as unknown as MgrPriv).managerInstanceId;
  const IID2 = (m2 as unknown as MgrPriv).managerInstanceId;
  check("two managers registered distinct logical instance ids", IID1 !== IID2, { IID1, IID2 });

  // A bare open-mesh caller (no credential system; the manager registered under DEV_OWNER).
  const caller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
  nc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });

  // `--on IID1`: the describe resolves PINNED to instance 1; ps routes to instance 1.
  const s1 = await resolveService(nc, SPACE, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000, instanceId: IID1 });
  check("--on <inst1> resolves PINNED to instance 1 (the describe reached exactly it)", s1.responder.instanceId === IID1 && s1.pinnedInstanceId === IID1, { responder: s1.responder.instanceId, pinned: s1.pinnedInstanceId });
  const ps1 = await invokeCommand(nc, SPACE, s1, "ps", undefined, { deadlineMs: 8_000 });
  check("ps --on <inst1> is answered by instance 1", ps1.reply.ok === true, ps1.reply);

  // `--on IID2`: resolves to the OTHER instance.
  const s2 = await resolveService(nc, SPACE, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000, instanceId: IID2 });
  check("--on <inst2> resolves PINNED to instance 2 (distinct from instance 1)", s2.responder.instanceId === IID2 && IID2 !== IID1, { responder: s2.responder.instanceId });
  const ps2 = await invokeCommand(nc, SPACE, s2, "ps", undefined, { deadlineMs: 8_000 });
  check("ps --on <inst2> is answered by instance 2", ps2.reply.ok === true, ps2.reply);

  // A class resolve (no --on) is answered by SOME registered instance (anycast, unchanged default).
  const sAny = await resolveService(nc, SPACE, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000 });
  check("a class (unpinned) resolve is answered by one of the two instances (anycast default)",
    sAny.pinnedInstanceId === undefined && (sAny.responder.instanceId === IID1 || sAny.responder.instanceId === IID2), { responder: sAny.responder.instanceId });

  // `--on <unknown>`: no instance serves that inst route → deadline, NEVER a silent fall-through to a peer.
  let unknownErr = false;
  try {
    await resolveService(nc, SPACE, MANAGER_ENDPOINT, caller, { deadlineMs: 2_000, instanceId: mintLifecycleUid() });
  } catch { unknownErr = true; }
  check("--on <unknown instance> deadlines (no fallback to another instance)", unknownErr);
} finally {
  try { await nc?.drain(); } catch { /* ignore */ }
  await m2?.stop().catch(() => {});
  await m1?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
}

console.log(`\n${fail === 0 ? "INSTANCE-TARGETED ROUTE SMOKE OK ✅" : "INSTANCE-TARGETED ROUTE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
