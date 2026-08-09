/**
 * SPAWN-AS-ACTION AUTH-LEG smoke (control-surface P2 item 2, must-5) — the BROKER-ENFORCED
 * security musts the open-mesh functional leg (spawn-action.smoke.ts) cannot exercise:
 *
 *   M7  WRITER SEPARATION  the SERVE credential is broker-DENIED a goal write (Q2 / security pin 3:
 *                          a serve connection carries none of the goal-fact/record rows); the
 *                          goal-writer profile REFUSES to mint without an endpoint (the mint boundary).
 *   FAMILY (b)             the goal-writer credId is STAGED in the §13.1 revocation family
 *                          (epcred.<e>.<iid>) alongside the serve cred — so the takeover barrier's
 *                          existing enumerate + revoke + evict catches it (no barrier code change).
 *   FENCE (a)              a SUPERSEDED incarnation (its gate epoch advanced by a synthetic takeover
 *                          barrier on its OWN iid) is CURRENCY-REFUSED its own terminal commit — the
 *                          corpse never wins a WRONG terminal fact (the own-gate belt). The full
 *                          revoke+evict of the family is the takeover-barrier machinery the FAMILY
 *                          test proves membership in; here the belt is the instant currency refusal.
 *
 * Run: pnpm smoke:manager-spawn-action-auth   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, principalKey, DEV_OWNER, epCall,
  actionContext, readGoalResult, endpointRegistrationBarrier, epAuthBucket, epcredFamilyPrefix, recordsBucket,
  registry, type Connector, type EpCaller, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";

const enc = new TextEncoder(), dec = new TextDecoder();
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
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `spawnact-auth-${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-spawnact-auth-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
for (const n of ["fence"])
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));

// A "stuck" child hangs forever without joining presence — the goal stays inside the readiness
// window, so its terminal is driven by the manager (exactly where the (a) belt gates the commit).
const PATH_ENV = { PATH: process.env.PATH ?? "" };
const stuckCon: Connector = { kind: "connector", name: "stuck", requires: ["node"], buildLaunch: (): LaunchSpec => ({ command: "node", args: ["-e", "setInterval(()=>{},1<<30)"], env: PATH_ENV }) };
registry.register(stuckCon);

const kids: ChildProcess[] = [];
const conns: NatsConnection[] = [];
const srv = spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
kids.push(srv);
let mgr: InstanceType<typeof Manager> | undefined;

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
  (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 1_500; // short window for a fast corpse settle
  await mgr.start();
  const M = mgr as unknown as {
    managerInstanceId: string;
    serviceServe?: { creds?: string };
    goalWriterIdentity?: { id: string };
  };
  // The registration gate + §13.1 family are keyed by the persisted registration instanceId
  // (item 3's split), NOT the per-process lifecycleUid — read/drive at the same key the manager registers under.
  const iid = M.managerInstanceId;

  // A caller instrument: an agent cred with the spawn capability + the spawn endpoint capability.
  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
  const callerCreds = await mintCreds(auth, id, "agent", {
    lifecycleUid: uid, capabilities: ["spawn"],
    endpointCapabilities: [{ endpoint: MANAGER_ENDPOINT, command: "spawn" }],
  });
  const callNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: callerCreds }), maxReconnectAttempts: 0 });
  conns.push(callNc);
  const callSpawn = (args: Record<string, unknown>) =>
    epCall(callNc, space, { mode: "one" }, { endpoint: MANAGER_ENDPOINT, command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args }, { deadlineMs: 30_000, currentEpoch: async () => 0 });

  // ── M7: WRITER SEPARATION (serve cred DENIED a goal write) ──────────────────────────────────
  {
    const serveNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: M.serviceServe!.creds! }), maxReconnectAttempts: 0 });
    // The serve cred lacks every goal row: a KV goal-record write acks only if permitted, so a
    // request-timeout is the broker's silent denial (the manager-service KV-denial pattern).
    let denied = false;
    try {
      await serveNc.request(`$KV.${recordsBucket(space)}.goal.${MANAGER_ENDPOINT}.${DEV_OWNER}.a.b.c.spec`, enc.encode("{}"), { timeout: 1500 });
    } catch { denied = true; }
    check("M7 the SERVE credential is broker-DENIED a goal-record write (Q2 / pin-3 writer separation)", denied);
    await serveNc.drain().catch(() => serveNc.close());
  }

  // ── M7: MINT BOUNDARY (goal-writer refuses without an endpoint) ─────────────────────────────
  {
    let threw = false;
    try { await mintCreds(auth, newIdentity(), "goal-writer", {}); } catch { threw = true; }
    check("M7 the goal-writer profile REFUSES to mint without an endpoint (mint boundary negative)", threw);
  }

  // ── FAMILY (b): the goal-writer credId is STAGED in the §13.1 revocation family ──────────────
  const execCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: iid } });
  {
    const gwPrincipal = principalKey(DEV_OWNER, M.goalWriterIdentity!.id).key;
    const execNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: execCreds }), maxReconnectAttempts: 0 });
    const authKv = await new Kvm(execNc).open(epAuthBucket(space));
    const rows: Array<{ holderPrincipal?: string; state?: string }> = [];
    for await (const k of await authKv.keys(`${epcredFamilyPrefix(MANAGER_ENDPOINT, iid)}.>`)) {
      const e = await authKv.get(k);
      if (e && e.operation === "PUT") rows.push(JSON.parse(dec.decode(e.value)));
    }
    const activeHolders = new Set(rows.filter((r) => r.state === "active").map((r) => r.holderPrincipal));
    check("FAMILY the goal-writer joined the §13.1 revocation family (epcred.<e>.<iid>, staged alongside the serve cred)", activeHolders.has(gwPrincipal), { activeHolders: [...activeHolders], gwPrincipal });
    check("FAMILY the family carries >= 2 distinct active holders (serve + goal-writer) — the barrier revokes+evicts both", activeHolders.size >= 2, [...activeHolders]);
    await execNc.drain().catch(() => execNc.close());
  }

  // ── FENCE (a): a SUPERSEDED incarnation is currency-refused its own terminal commit ─────────
  {
    const r = await callSpawn({ name: "fence", agent: "stuck" }); // accepts, never joins → stays inside the window
    check("FENCE the fence spawn was accepted", r.reply.ok === true, r.reply);
    const goalId = (r.reply.data as { goalId?: string }).goalId!;
    const ref = { endpoint: MANAGER_ENDPOINT, caller, goalId };
    await wait(300); // accepted, in-flight (goal record written), still inside the 1.5s window
    // SUPERSEDE the manager's OWN instance: a synthetic takeover barrier advances its gate epoch
    // (freeze → reopen at epoch+1). We deliberately do NOT evict (that is the $SYS takeover
    // machinery the FAMILY test proves membership in); this isolates the (a) currency belt.
    const execNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: execCreds }), maxReconnectAttempts: 0 });
    const barrier = endpointRegistrationBarrier(await new Kvm(execNc).open(epAuthBucket(space)), space, { endpoint: MANAGER_ENDPOINT, instanceId: iid, opId: mintLifecycleUid() });
    const obs = await barrier.observe();
    const token = await barrier.freeze(obs!.revision);
    const reopened = token !== null && await barrier.reopen(token, { generation: obs!.generation + 1, processEpoch: obs!.processEpoch + 1, registrationRevision: obs!.registrationRevision, nameAuthorityRevision: obs!.nameAuthorityRevision });
    check("FENCE the synthetic takeover advanced the manager's gate epoch (supersession)", reopened === true, { obs, token });
    await execNc.drain().catch(() => execNc.close());
    // The corpse's readiness window elapses → onOutcome → the (a) belt reads gate epoch+1 != its
    // accepted epoch → REFUSES the commit. The corpse writes NO terminal fact.
    await wait(2_000); // past the 1.5s readiness window (+ margin) from the accept
    const gwReadCreds = await mintCreds(auth, newIdentity(), "goal-writer", { goalWriter: { endpoint: MANAGER_ENDPOINT } });
    const readNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: gwReadCreds }), maxReconnectAttempts: 0 });
    conns.push(readNc);
    // Reading an EXECUTOR-PINNED goal terminal resolves the executor's CURRENT epoch (item 3's (i)
    // fence): after the synthetic takeover the gate is at epoch obs+1, so the reader looks at
    // result.<obs+1> and the corpse's fenced (old-epoch) attempt is invisible → no terminal.
    const rctx = await actionContext(readNc, space, { resolveExecutorEpoch: (execIid) => (execIid === iid ? obs!.processEpoch + 1 : null) });
    const result = await readGoalResult(rctx, ref);
    check("FENCE (a) the superseded corpse never committed a terminal (own-gate currency refused — no wrong terminal)", result === undefined, result);
  }

  console.log(`\nspawn-action AUTH-leg smoke: ${pass} passed, ${fail} failed`);
} finally {
  for (const c of conns) await c.drain().catch(() => c.close());
  await mgr?.stop().catch(() => {});
  for (const k of kids) { k.kill("SIGKILL"); }
  await wait(200);
}

process.exit(fail > 0 ? 1 : 0);
