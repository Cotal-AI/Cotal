/**
 * A signerless manager's closed standing connection recovers through the all-duty family only.
 * The manager's own session-ledger dialer opens a connection under a short-lived JWT, and the broker
 * expires it until the client closes. The manager's real close handler then runs. The first
 * all-duty candidate is refused, so the attempt fails with last-good and debt kept. The next
 * attempt adopts the repaired family for the same held nkeys and re-dials. The per-duty executor
 * renewal and every local mint path stay unused.
 *
 * Limit: the serve and goal-writer close handlers share this routing but are not driven live here,
 * and full Manager.start() is not run.
 *
 * Run: tsx implementations/manager/smoke/remote-closed-connection-recovery.smoke.ts (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  createSpaceAuth, credsClaims, inspectCredHealth, isReachable, mintCreds, mintLifecycleUid, newIdentity, remoteManagerActors, serverConfig,
  type Identity, type SpaceAuth,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { Manager } from "../src/manager.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => Promise<void> | void) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await wait(100);
  return pred();
}

const space = `closed${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
type Name = (typeof names)[number];
const owner = `u_${"b".repeat(26)}`;
const instanceId = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const held: Record<Name, Identity> = { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() };
const sign = async (signer: SpaceAuth, name: Name, ttl: number) => {
  const actor = name === "serve" ? actors.supervisor : actors[name];
  return mintCreds(signer, held[name], name === "goalWriter" ? "goal-writer" : name === "sessionLedger" ? "session-ledger" : "remote-manager", {
    principal: { owner, actor },
    ...(name === "goalWriter" ? { goalWriter: { endpoint: "manager" } } : {}),
    ...(name === "supervisor" || name === "executor" || name === "serve" ? { remoteManager: { instanceId, owner, actor } } : {}),
    expiresInSeconds: ttl,
  });
};
const family = async (ttl: number) =>
  Object.fromEntries(await Promise.all(names.map(async (n) => [n, await sign(auth, n, ttl)]))) as Record<Name, string>;

type Internals = {
  dialSessionLedgerConnection(sw: { nc: NatsConnection; creds?: string }, identity: Identity): Promise<void>;
  sessionLedgerIdentity?: Identity;
  sessionLedgerConn?: { nc: NatsConnection; creds?: string };
  remoteSupervisorCreds?: string; remoteExecutorCreds?: string; goalWriterCreds?: string; sessionLedgerCreds?: string;
  serviceServe?: { nc: NatsConnection; identity: Identity; grant: { epoch: number }; creds?: string };
  ep: { reconnect(): Promise<void> };
  remoteRenewalDebt?: { processEpoch: number; reason: string; unadoptedSubjects: string[] };
  leaseStopping: boolean;
};

let m!: Internals;
try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });
  const TTL = 6;
  const initial = await family(TTL);
  let bundleCalls = 0;
  let executorCalls = 0;
  let refuse = true;
  const renewed: { value?: Record<Name, string> } = {};
  const manager = new Manager({
    space, servers: SERVERS, runtime: "pty",
    remoteAuthority: {
      owner, actors, instanceId, lifecycleUid: mintLifecycleUid(), identities: held,
      accountPublicKey: auth.account.pub,
      supervisorCreds: initial.supervisor, executorCreds: initial.executor, serveCreds: initial.serve,
      goalWriterCreds: initial.goalWriter, sessionLedgerCreds: initial.sessionLedger,
      renewExecutor: async () => { executorCalls++; throw new Error("per-duty executor renewal entered from a closed-connection handler"); },
      renewStandingBundle: async (processEpoch) => {
        bundleCalls++;
        assert.equal(processEpoch, 7);
        if (refuse) { refuse = false; throw new Error("injected issuer refusal"); }
        renewed.value = await family(3600);
        return renewed.value;
      },
      serveGrant: { epoch: 7 } as never,
      agentBearerExchangeUrl: "https://auth.example.test",
      mintSessionServing: async () => "", mintRetirementRequester: async () => "",
      validateRetainedAgent: async () => { throw new Error("zero-agent smoke"); },
      scanGoalIndex: async () => [], authorizeAdmin: async () => false,
      prepareAgentRetirement: async () => { throw new Error("zero-agent smoke"); },
    },
  });
  m = manager as unknown as Internals;
  // The standing holders registerManagerService seeds from the remote authority. The serve,
  // supervisor, executor and goal-writer connections are not dialed here.
  m.remoteSupervisorCreds = initial.supervisor;
  m.remoteExecutorCreds = initial.executor;
  m.goalWriterCreds = initial.goalWriter;
  m.sessionLedgerCreds = initial.sessionLedger;
  m.sessionLedgerIdentity = held.sessionLedger;
  m.ep = { reconnect: async () => {} };
  m.serviceServe = { nc: { reconnect: async () => {} } as never, identity: held.serve, grant: { epoch: 7 }, creds: initial.serve };
  const sw: { nc: NatsConnection; creds?: string } = { nc: undefined as never, creds: initial.sessionLedger };
  m.sessionLedgerConn = sw;
  await m.dialSessionLedgerConnection(sw, held.sessionLedger);
  const first = sw.nc;

  await cell("the manager's session-ledger connection is live under the initial JWT", async () => {
    await first.flush();
  });
  await cell("the broker expires the JWT and the client closes the connection", async () => {
    const closed = await Promise.race([first.closed().then(() => true), wait((TTL + 20) * 1000).then(() => false)]);
    assert.ok(closed, "connection never closed after expiry");
    assert.equal(inspectCredHealth(initial.sessionLedger).state, "expired");
  });
  await cell("the first recovery attempt asks for the all-duty family, is refused, and keeps last-good with debt", async () => {
    assert.ok(await until(() => bundleCalls >= 1, 5_000), "the close handler never requested the all-duty family");
    assert.ok(await until(() => m.remoteRenewalDebt !== undefined, 2_000));
    assert.match(m.remoteRenewalDebt!.reason, /injected issuer refusal/);
    assert.equal(m.remoteRenewalDebt!.processEpoch, 7);
    assert.equal(sw.creds, initial.sessionLedger);
    assert.equal(m.remoteExecutorCreds, initial.executor);
  });
  await cell("the next attempt adopts the repaired family and re-dials on a new connection", async () => {
    assert.ok(await until(() => sw.nc !== first, 15_000), "the session ledger was never re-dialed");
    await sw.nc.flush();
    assert.equal(bundleCalls, 2);
    assert.equal(m.remoteRenewalDebt, undefined);
    assert.equal(sw.creds, renewed.value!.sessionLedger);
    assert.equal(m.sessionLedgerCreds, renewed.value!.sessionLedger);
    assert.equal(m.serviceServe!.creds, renewed.value!.serve);
    assert.equal(m.goalWriterCreds, renewed.value!.goalWriter);
  });
  await cell("every duty keeps its held nkey, and no per-duty or local path ran", async () => {
    for (const n of names) assert.equal(credsClaims(renewed.value![n]).sub, held[n].id, `${n} keeps its held nkey`);
    assert.equal(executorCalls, 0);
  });
  await cell("the re-dialed connection stays served past the initial expiry", async () => {
    await wait(2_000);
    await sw.nc.flush();
  });
} finally {
  if (m) m.leaseStopping = true;
  await m?.sessionLedgerConn?.nc?.close().catch(() => {});
  releaseBroker();
  await killAndAwaitExit(srv);
}

console.log(`\nremote-closed-connection-recovery: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
