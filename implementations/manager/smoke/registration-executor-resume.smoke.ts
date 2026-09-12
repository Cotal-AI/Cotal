/**
 * Issue #1335: manager re-registration must survive endpoint executor expiry.
 *
 * Real loopback auth broker. A predecessor leaves an eight-holder family and a frozen gate. Boot
 * heal runs first on its own executor. The following registration uses a six-second executor and
 * delays only its last holder verification past expiry. The manager must mint fresh scoped
 * authority, resume the same operation's durable progress, and converge without another gate
 * generation.
 *
 * Run: pnpm smoke:registration-executor-resume
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  CotalEndpoint, CONTROL_DELIVERY_ADMIN, DEV_OWNER,
  createSpaceAuth, endpointRegistrationBarrier, epAuthBucket, epgateKey,
  evictDeniedPrincipalWithCreds, isReachable, mintConnectionEvictorCreds,
  mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity,
  observePrincipalLivenessWithCreds, parseEndpointGate, principalKey,
  serverConfig, serveIssuanceGateKv, setupSpaceStreams, standaloneConnectOpts,
  type ControlReply, type EpServeLedgerRow,
} from "@cotal-ai/core";
import { authDir, loadManagerInstanceIdentity, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

for (const k of Object.keys(process.env)) if (k === "COTAL_HOME" || k.startsWith("COTAL_")) delete process.env[k];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const LIVE_HOSTS = ["broker.cotal.ai"];
for (const host of LIVE_HOSTS) {
  if (SERVERS.includes(host)) {
    console.error(`✗ REFUSING TO RUN: the broker URL "${SERVERS}" names the live host "${host}".`);
    process.exit(1);
  }
}
if (!/^nats:\/\/(127\.0\.0\.1|localhost):/.test(SERVERS)) {
  console.error(`✗ REFUSING TO RUN: "${SERVERS}" is not a loopback ephemeral broker.`);
  process.exit(1);
}

const SPACE = `i1335-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
const workspaceRoot = join(dir, "ws");
mkdirSync(home, { recursive: true });
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
process.env.COTAL_HOME = home;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const auth = await createSpaceAuth(SPACE);
saveSpaceAuth(authDir(workspaceRoot), auth);
const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"),
}));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
let daemon: CotalEndpoint | undefined;
let mgr: InstanceType<typeof Manager> | undefined;
let evictionCalls = 0;
let delayed = false;
const FAMILY = 8;
const HEAL_EVICTS = FAMILY;
const REGISTRATION_LAST_EVICT = HEAL_EVICTS + FAMILY;

const startDaemon = async () => {
  const id = newIdentity();
  const ep = new CotalEndpoint({
    space: SPACE, servers: SERVERS, creds: await mintCreds(auth, id, "delivery"),
    card: { id: id.id, name: "delivery", role: "delivery", kind: "endpoint" }, channels: [],
    consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  ep.on("error", () => {});
  await ep.start();
  ep.serveControl(CONTROL_DELIVERY_ADMIN, async (req): Promise<ControlReply> => {
    const principal = String((req.args as { principal?: unknown })?.principal ?? "");
    if (req.op === "principalLiveness") {
      return { ok: true, data: await observePrincipalLivenessWithCreds({ servers: SERVERS, observerCreds, accountId: auth.account.pub, principal }) };
    }
    if (req.op === "evictPrincipal") {
      evictionCalls++;
      if (!delayed && evictionCalls === REGISTRATION_LAST_EVICT) {
        delayed = true;
        console.log("  probe: delaying only the last holder verification of the new registration past the 6s executor lifetime");
        await wait(7_000);
      }
      return { ok: true, data: await evictDeniedPrincipalWithCreds({ servers: SERVERS, observerCreds, evictorCreds, accountId: auth.account.pub, principal }) };
    }
    if (req.op === "reloadStoreIdentity")
      return { ok: true, data: { kind: "fs", root: resolve(workspaceRoot) } };
    return { ok: false, error: `unsupported ${req.op}` };
  }, { boundReply: true });
  return ep;
};

const execKv = async (iid: string): Promise<{ kv: KV; nc: NatsConnection }> => {
  const creds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: iid }, expiresInSeconds: 30,
  });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  return { kv: await new Kvm(nc).open(epAuthBucket(SPACE)), nc };
};
const gate = async (kv: KV, iid: string) => {
  const key = epgateKey(MANAGER_ENDPOINT, iid);
  const e = await kv.get(key);
  return e?.operation === "PUT" ? parseEndpointGate(e.value, key) : null;
};
const freeze = async (kv: KV, iid: string) => {
  const b = endpointRegistrationBarrier(kv, SPACE, { endpoint: MANAGER_ENDPOINT, instanceId: iid, opId: mintLifecycleUid() });
  const obs = await b.observe();
  if (!obs || obs.state !== "open") throw new Error(`cannot freeze ${JSON.stringify(obs)}`);
  if (await b.freeze(obs.revision) === null) throw new Error("freeze lost");
};
const expandToEightHolders = async (kv: KV, iid: string) => {
  const b = endpointRegistrationBarrier(kv, SPACE, { endpoint: MANAGER_ENDPOINT, instanceId: iid, opId: mintLifecycleUid() });
  const rows = await b.enumerate();
  const holders = new Set(rows.map((r) => r.holderPrincipal));
  let n = 0;
  while (holders.size < FAMILY) {
    const id = newIdentity();
    const holderPrincipal = principalKey(DEV_OWNER, id.id).key;
    holders.add(holderPrincipal);
    const row: EpServeLedgerRow = {
      credentialId: `probe-${n++}-${randomUUID().replaceAll("-", "")}`,
      credentialKey: id.id, holderPrincipal, endpoint: MANAGER_ENDPOINT, lifecycleUid: iid,
      sourceChain: ["root"], state: "active", exp: Math.floor(Date.now() / 1000) + 3600,
      generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
    };
    await serveIssuanceGateKv(kv, SPACE, { endpoint: MANAGER_ENDPOINT, instanceId: iid }).stage(row);
  }
  return holders.size;
};
const attempt = async (label: string, iid: string) => {
  evictionCalls = 0;
  delayed = false;
  const next = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot, endpointServeExecutorExpiresInSeconds: 6 });
  let error: Error | undefined;
  try { await next.start(); mgr = next; }
  catch (e) { error = e as Error; await next.stop({ withAgents: true }).catch(() => {}); }
  const { kv, nc } = await execKv(iid);
  const after = await gate(kv, iid);
  await nc.drain().catch(() => nc.close());
  console.log(`  ${label}: ${error?.message ?? "started"} (evictionCalls=${evictionCalls})`);
  return { error, after, evictionCalls };
};

try {
  for (let i = 0; i < 50 && !(await isReachable(SERVERS)); i++) await wait(200);
  if (!(await isReachable(SERVERS))) throw new Error("broker did not start");
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  recordMesh({ space: SPACE, server: SERVERS, root: workspaceRoot, mode: "auth", ts: new Date().toISOString() });
  daemon = await startDaemon();

  mgr = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot });
  await mgr.start();
  const persisted = loadManagerInstanceIdentity(workspaceRoot, SPACE)!;
  const iid = persisted.instanceId;
  await mgr.stop({ withAgents: true }); mgr = undefined;

  const ek = await execKv(iid);
  check("family expanded to eight distinct holders", (await expandToEightHolders(ek.kv, iid)) === FAMILY);
  await freeze(ek.kv, iid);
  const before = await gate(ek.kv, iid);
  await ek.nc.drain().catch(() => ek.nc.close());
  check("starting residue is frozen generation 1", before?.state === "frozen" && before.generation === 1, before);

  const a1 = await attempt("attempt 1", iid);
  check("compressed-lifetime takeover converges under fresh authority", !a1.error, a1.error?.message);
  check("retry completes with the gate open", a1.after?.state === "open", a1.after);
  check("registration retry keeps one gate generation across executor renewal", a1.after?.generation === 3, { before, after: a1.after });
  check(
    "registration resume skips already-verified holders",
    a1.evictionCalls >= HEAL_EVICTS + FAMILY && a1.evictionCalls < HEAL_EVICTS + 2 * FAMILY,
    a1.evictionCalls,
  );

  console.log(`\nISSUE 1335 COMPRESSED LIFETIME ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error((e as Error).stack ?? String(e));
  process.exitCode = 1;
} finally {
  await mgr?.stop({ withAgents: true }).catch(() => {});
  await daemon?.stop().catch(() => {});
  srv.kill("SIGTERM");
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  delete process.env.COTAL_HOME;
}
