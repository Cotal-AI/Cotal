/**
 * Cotal #783 item 3 / #871 — manager BOOT self-heals a frozen registration gate.
 *
 * A manager restart killed mid-barrier leaves the issuance gate frozen under a registration op
 * whose holder is gone. Today the successor refuses (`the issuance gate … is frozen; another
 * barrier holds it`, SPEC 13.8) until an operator runs `cotal reconcile-gate`. The repair itself
 * already exists (`reconcileEndpointGate`); what is missing is that the successor boot path never
 * runs it.
 *
 * WHAT THIS SUITE GRADES, against a REAL JWT broker + a REAL delivery-admin oracle, never the
 * live macfleet stack:
 *   1. REPRO / HAPPY: freeze-holder gone AND sweepComplete=true → successor start SUCCEEDS
 *      (exact-op abort-reopen, then the normal takeover; instanceId preserved, epoch advanced).
 *   2. LIVE HOLDER: a CONNZ-attributed connection for the freeze-holder still exists → start
 *      REFUSES named `holder-alive`, gate stays frozen, family untouched.
 *   3. NO ORACLE: delivery-admin rail down → start REFUSES named `liveness-unestablishable`,
 *      gate stays frozen. Silence is never death.
 *
 * Residue is built by the SHIPPED barrier's own freeze after a real manager has registered and
 * stopped, so the coordinate, principal, and persisted instance identity are the ones a restart
 * actually finds. No hand-written frozen row.
 *
 * COTAL_HOME + every inherited COTAL_* are scrubbed; the suite owns one scratch home and one
 * scratch workspace root. Kills only the nats-server it starts, by exact PID (never pkill).
 *
 * Run: pnpm smoke:boot-self-heal-gate   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
  mintMembershipObserverCreds, mintConnectionEvictorCreds,
  principalKey, standaloneConnectOpts, epAuthBucket, DEV_OWNER,
  endpointRegistrationBarrier, epgateKey, parseEndpointGate, mintLifecycleUid,
  observePrincipalLivenessWithCreds, evictDeniedPrincipalWithCreds,
  CotalEndpoint, CONTROL_DELIVERY_ADMIN,
  type ControlReply,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh, loadManagerInstanceIdentity } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { GateReconcileRefused } from "../src/reconcile-gate.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// ---------------------------------------------------------------------------
// FIRST ACTION: scrub inherited COTAL_* and refuse the live host. This suite starts a manager
// and a delivery-admin responder; it must never be able to do that against macfleet.
// ---------------------------------------------------------------------------
for (const k of Object.keys(process.env)) {
  if (k === "COTAL_HOME" || k.startsWith("COTAL_")) delete process.env[k];
}

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const LIVE_HOSTS = ["broker.cotal.ai"];
for (const host of LIVE_HOSTS) {
  if (SERVERS.includes(host)) {
    console.error(`✗ REFUSING TO RUN: the broker URL "${SERVERS}" names the live host "${host}".`);
    process.exit(1);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(COTAL_SERVER|COTAL_SERVERS|NATS_URL|COTAL_BROKER)$/.test(k) && typeof v === "string" && v.includes(host)) {
      console.error(`✗ REFUSING TO RUN: ${k}="${v}" names the live host "${host}". Ephemeral brokers from scratch dirs only.`);
      process.exit(1);
    }
  }
}
if (!/^nats:\/\/(127\.0\.0\.1|localhost):/.test(SERVERS)) {
  console.error(`✗ REFUSING TO RUN: "${SERVERS}" is not a loopback ephemeral broker.`);
  process.exit(1);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SPACE = `bootheal-${randomUUID().slice(0, 8)}`;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : extra); }
};

const auth = await createSpaceAuth(SPACE);
const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
const workspaceRoot = join(dir, "ws");
mkdirSync(home, { recursive: true });
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
process.env.COTAL_HOME = home;
saveSpaceAuth(authDir(workspaceRoot), auth);

writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const holderConns: NatsConnection[] = [];
let daemon: CotalEndpoint | undefined;
let mgr: InstanceType<typeof Manager> | undefined;

const startDaemon = async (): Promise<CotalEndpoint> => {
  const dlvId = newIdentity();
  const ep = new CotalEndpoint({
    space: SPACE, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  ep.on("error", () => {});
  await ep.start();
  ep.serveControl(CONTROL_DELIVERY_ADMIN, async (req): Promise<ControlReply> => {
    const principal = String((req.args as { principal?: unknown })?.principal ?? "");
    if (req.op === "evictPrincipal") {
      const result = await evictDeniedPrincipalWithCreds({
        servers: SERVERS, observerCreds, evictorCreds, accountId: auth.account.pub, principal,
      });
      return { ok: true, data: result };
    }
    if (req.op === "principalLiveness") {
      const result = await observePrincipalLivenessWithCreds({
        servers: SERVERS, observerCreds, accountId: auth.account.pub, principal,
      });
      return { ok: true, data: result };
    }
    return { ok: false, error: `unsupported delivery-admin op "${req.op}"` };
  }, { boundReply: true });
  return ep;
};

const execKv = async (instanceId: string): Promise<{ kv: KV; nc: NatsConnection }> => {
  const creds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId },
  });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  return { kv: await new Kvm(nc).open(epAuthBucket(SPACE)), nc };
};

const readGate = async (kv: KV, instanceId: string) => {
  const key = epgateKey(MANAGER_ENDPOINT, instanceId);
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT") return null;
  return parseEndpointGate(entry.value, key);
};

/** Freeze the persisted manager instance's issuance gate via the SHIPPED barrier, after the
 *  predecessor has already registered (so the principal and instanceId are the real ones). */
const freezeRegisteredGate = async (instanceId: string, serveActor: string): Promise<void> => {
  const { kv, nc } = await execKv(instanceId);
  try {
    const before = await readGate(kv, instanceId);
    if (before === null) throw new Error("no issuance gate after the predecessor registered");
    // A failed successor leaves the residue in place. Reusing it is the right crash state;
    // requiring `open` would abort later cells whenever the heal under test has not landed.
    if (before.state === "frozen" && before.op?.kind === "registration") return;
    if (before.state !== "open") throw new Error(`gate was ${before.state}, not open, before the crash freeze`);
    const observed = await endpointRegistrationBarrier(kv, SPACE, {
      endpoint: MANAGER_ENDPOINT, instanceId, opId: mintLifecycleUid(),
    }).observe();
    if (observed === null) throw new Error("barrier observe returned null for a gate that parseEndpointGate just read");
    const frozen = await endpointRegistrationBarrier(kv, SPACE, {
      endpoint: MANAGER_ENDPOINT, instanceId, opId: mintLifecycleUid(),
    }).freeze(observed.revision);
    if (frozen === null) throw new Error("the shipped barrier did not freeze the gate — residue not built");
    const after = await readGate(kv, instanceId);
    if (after?.state !== "frozen" || after.op?.kind !== "registration")
      throw new Error(`residue is not a frozen registration gate: ${JSON.stringify(after)}`);
    if (after.principal !== principalKey(DEV_OWNER, serveActor).key)
      throw new Error(`freeze-holder ${after.principal} is not the persisted serve principal`);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
};

const startSuccessor = async (): Promise<{ ok: true; mgr: InstanceType<typeof Manager> } | { ok: false; error: Error }> => {
  const next = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot });
  try {
    await next.start();
    return { ok: true, mgr: next };
  } catch (e) {
    await next.stop().catch(() => {});
    return { ok: false, error: e as Error };
  }
};

const conditionOf = (e: Error): string => {
  if (e instanceof GateReconcileRefused) return e.condition;
  const m = e.message;
  if (/holder-alive|is ALIVE/.test(m)) return "holder-alive";
  if (/liveness-unestablishable|CANNOT BE ESTABLISHED|not reachable on the ctl.delivery-admin/.test(m)) return "liveness-unestablishable";
  if (/is frozen; another barrier holds it/.test(m)) return "frozen-conflict";
  return "other";
};

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`the ephemeral broker did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  recordMesh({ space: SPACE, server: SERVERS, root: workspaceRoot, mode: "auth", ts: new Date().toISOString() });

  daemon = await startDaemon();

  // ── predecessor registers for real, then stops (lease released, serve connections gone) ──
  mgr = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot });
  await mgr.start();
  const persisted = loadManagerInstanceIdentity(workspaceRoot, SPACE);
  if (!persisted) throw new Error("predecessor did not persist a manager instance identity");
  const iid = persisted.instanceId;
  const serveActor = persisted.serveIdentity.id;
  const M1 = mgr as unknown as { serviceServe?: { grant: { epoch: number } } };
  const epoch1 = M1.serviceServe!.grant.epoch;
  check("predecessor registered a persisted instanceId at epoch 0", typeof iid === "string" && iid.length > 0 && epoch1 === 0, { iid, epoch1 });
  await mgr.stop();
  mgr = undefined;

  // ── CELL 1: holder GONE + complete sweep → successor start must SUCCEED (the #783/#871 heal)
  {
    await freezeRegisteredGate(iid, serveActor);
    const { kv, nc } = await execKv(iid);
    const before = await readGate(kv, iid);
    check(
      "RESIDUE (dead holder): shipped freeze left the gate frozen under a registration op",
      before?.state === "frozen" && before.op?.kind === "registration",
      before,
    );
    await nc.drain().catch(() => nc.close());

    const r = await startSuccessor();
    check(
      "DEAD HOLDER: successor start SUCCEEDS without `cotal reconcile-gate` (boot self-heal)",
      r.ok === true,
      r.ok ? undefined : { condition: conditionOf(r.error), message: r.error.message },
    );
    if (r.ok) {
      mgr = r.mgr;
      const M2 = mgr as unknown as { managerInstanceId: string; serviceServe?: { grant: { epoch: number; instanceId: string } } };
      check("DEAD HOLDER: logical instanceId is preserved", M2.managerInstanceId === iid, { iid, got: M2.managerInstanceId });
      check("DEAD HOLDER: process epoch ADVANCED through the normal takeover after abort-reopen",
        (M2.serviceServe?.grant.epoch ?? -1) > epoch1, { epoch1, epoch2: M2.serviceServe?.grant.epoch });
      await mgr.stop();
      mgr = undefined;
    }
  }

  // ── CELL 2: freeze-holder still has a live CONNZ-attributed connection → named refuse, no mutate
  {
    await freezeRegisteredGate(iid, serveActor);
    const hcreds = await mintCreds(auth, newIdentity(), "agent", {
      principal: { owner: DEV_OWNER, actor: serveActor },
      lifecycleUid: mintLifecycleUid(),
    });
    const live = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: hcreds, tls: false }), maxReconnectAttempts: 0 });
    holderConns.push(live);
    await wait(300);

    const { kv, nc } = await execKv(iid);
    const before = await readGate(kv, iid);
    const familyBefore = await endpointRegistrationBarrier(kv, SPACE, { endpoint: MANAGER_ENDPOINT, instanceId: iid, opId: mintLifecycleUid() }).enumerate();

    const r = await startSuccessor();
    check("LIVE HOLDER: successor start REFUSES", r.ok === false, r.ok ? "started" : undefined);
    check("LIVE HOLDER: the refusal is named `holder-alive`",
      r.ok === false && conditionOf(r.error) === "holder-alive",
      r.ok ? undefined : { condition: conditionOf(r.error), message: r.error.message });
    const after = await readGate(kv, iid);
    check("LIVE HOLDER: the gate is UNTOUCHED — still frozen", after?.state === "frozen" && after.generation === before?.generation, { before, after });
    const familyAfter = await endpointRegistrationBarrier(kv, SPACE, { endpoint: MANAGER_ENDPOINT, instanceId: iid, opId: mintLifecycleUid() }).enumerate();
    check("LIVE HOLDER: the credential family is UNTOUCHED (refuse happened before mutation)",
      familyAfter.length === familyBefore.length && familyAfter.every((row, i) => row.state === familyBefore[i]?.state),
      { before: familyBefore.map((x) => x.state), after: familyAfter.map((x) => x.state) });
    await nc.drain().catch(() => nc.close());
    await live.close();
    holderConns.length = 0;
  }

  // ── CELL 3: no delivery-admin oracle → named unestablishable, gate stays frozen ──
  {
    await freezeRegisteredGate(iid, serveActor);
    await daemon.stop();
    daemon = undefined;
    await wait(200);

    const { kv, nc } = await execKv(iid);
    const before = await readGate(kv, iid);
    const r = await startSuccessor();
    check("NO ORACLE: successor start REFUSES", r.ok === false, r.ok ? "started" : undefined);
    check("NO ORACLE: the refusal is named `liveness-unestablishable` (silence is not death)",
      r.ok === false && conditionOf(r.error) === "liveness-unestablishable",
      r.ok ? undefined : { condition: conditionOf(r.error), message: r.error.message });
    const after = await readGate(kv, iid);
    check("NO ORACLE: the gate stays frozen — an unreachable sweep never authorizes the repair",
      after?.state === "frozen" && after.generation === before?.generation, { before, after });
    await nc.drain().catch(() => nc.close());
  }

  console.log(`\nBOOT SELF-HEAL GATE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  console.log(`\nBOOT SELF-HEAL GATE FAILED ❌  (${pass} passed, ${fail} failed)`);
  process.exitCode = 1;
} finally {
  await mgr?.stop().catch(() => {});
  await daemon?.stop().catch(() => {});
  for (const c of holderConns) await c.close().catch(() => {});
  srv.kill("SIGTERM");
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  delete process.env.COTAL_HOME;
}
