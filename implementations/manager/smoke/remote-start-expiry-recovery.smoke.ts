/**
 * Full remote-authority Manager.start() with zero agents recovers from broker expiry through the
 * closed all-duty renewal only. The space is registered through the real registerRemoteManagerAuthority,
 * and the real Manager starts its supervisor, serve, goal-writer and session-ledger connections under
 * short-lived JWTs for five held nkeys. The broker expires them and the manager's own close handlers
 * run. The issuer side runs the shipped authorizeRemoteManagerRenewal and issueRemoteManagerAuthority
 * against the live registration gate, and the manager validates the echo with
 * remoteManagerRenewalCredentials. Requests in the first 3s carry a foreign owner, and each close handler's first attempt is refused. The
 * manager keeps last-good and records debt. The next request is adopted for the same nkeys, and
 * every standing connection serves again under the same instance and serve epoch.
 *
 * Limit: the issuer signer is this smoke's test account key standing in for the host service route,
 * which the auth-service owner has not wired yet. Clean deregistration with an expired executor is not
 * reached, because recovery renews the executor first. Run-driver and mediator renewal are not exercised.
 *
 * Run: tsx implementations/manager/smoke/remote-start-expiry-recovery.smoke.ts (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/transport-node";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth, credsClaims, epAuthBucket, inspectCredHealth, isReachable, jwtFromCreds, mintCreds, mintLifecycleUid, newIdentity,
  remoteManagerActors, serveIssuanceGateKv, serverConfig, setupSpaceStreams, standaloneConnectOpts,
  type Identity, type RemoteManagerAuthorityMaterial, type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { authorizeRemoteManagerRenewal, issueRemoteManagerAuthority } from "../../auth/src/manager-authority.js";
import { remoteManagerCurrentRegistrationProof } from "../../auth/src/retained-manager-validation.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { Manager } from "../src/manager.js";
import { remoteStandingBundleRenewal } from "../src/remote-authority.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => Promise<void> | void) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await wait(200); }
  return pred();
}
const flushes = (nc: NatsConnection | undefined) =>
  nc ? Promise.race([nc.flush().then(() => true, () => false), wait(1500).then(() => false)]) : Promise.resolve(false);

const space = `start${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
type Name = (typeof names)[number];
const owner = `u_${"d".repeat(26)}`;
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const held = Object.fromEntries(names.map((n) => [n, newIdentity()])) as Record<Name, Identity>;
/** Host-side profile and grants, chosen from the duty name only. */
const sign = (n: Name, ttl?: number) => {
  const actor = n === "serve" ? actors.supervisor : actors[n];
  return mintCreds(auth, held[n], n === "goalWriter" ? "goal-writer" : n === "sessionLedger" ? "session-ledger" : "remote-manager", {
    principal: { owner, actor },
    ...(n === "goalWriter" ? { goalWriter: { endpoint: "manager" } } : {}),
    ...(n === "supervisor" || n === "executor" || n === "serve" ? { remoteManager: { instanceId, owner, actor } } : {}),
    ...(ttl !== undefined ? { expiresInSeconds: ttl } : {}),
  });
};

type Internals = {
  ep: { nc?: NatsConnection };
  serviceServe?: { nc: NatsConnection; creds?: string; grant: { epoch: number } };
  goalWriter?: { nc: NatsConnection; creds?: string };
  sessionLedgerConn?: { nc: NatsConnection; creds?: string };
  remoteSupervisorCreds?: string; remoteExecutorCreds?: string;
  remoteRenewalDebt?: { processEpoch: number; reason: string; unadoptedSubjects: string[] };
  managerInstanceId: string;
};

let manager: Manager | undefined;
const logged: string[] = [];
const origError = console.error;
console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); origError(...args); };
try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const TTL = 10;
  const initial = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await sign(n, TTL)]))) as Record<Name, string>;
  const registered = await registerRemoteManagerAuthority({
    space, server: SERVERS, owner, instanceId, serveActor: actors.serve,
    prepareCreds: initial.executor, tlsRequired: false, evict: async (principals) => principals.map(() => true),
  });

  // The host's live registration-gate reader, over its own provisioner connection.
  const hostNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "issuer", { principal: { owner, actor: "host_issuer" } }), tls: false }) });
  const gate = serveIssuanceGateKv(await new Kvm(hostNc).open(epAuthBucket(space)), space, { endpoint: "manager", instanceId });
  const observeManagerGate = async () => {
    const g = await gate.observe();
    return g ? { state: g.state, principal: g.principal, processEpoch: g.processEpoch, registrationRevision: g.registrationRevision } as never : null;
  };
  let calls = 0;
  let refusals = 0;
  let refuseUntil = 0;
  let adopted: Record<Name, string> | undefined;
  const current = (await observeManagerGate()) as unknown as { processEpoch: number; registrationRevision: number };
  const base = {
    v: 1 as const, kind: "manager-service-authority" as const, operation: "renewStandingBundle" as const,
    space, actor: "cli", instanceId, managerLifecycleUid, requestId: `req${mintLifecycleUid()}`,
    accountPublicKey: auth.account.pub, processEpoch: current.processEpoch,
    identities: Object.fromEntries(names.map((n) => [n, { id: held[n].id }])) as RemoteManagerAuthorityRequest["identities"],
  };
  const registrationProof = remoteManagerCurrentRegistrationProof("proof-secret", owner, base, current);
  const standing = remoteStandingBundleRenewal({
    state: { v: 1, space, instanceId, lifecycleUid: managerLifecycleUid, identities: held },
    owner, registrationProof, supervisorCreds: initial.supervisor,
    call: async (request) => {
    calls++;
    assert.equal(request.operation, "renewStandingBundle");
    assert.equal(request.registrationProof, registrationProof);
    assert.equal(request.accountPublicKey, auth.account.pub);
    assert.deepEqual(request.identities, base.identities);
    // Requests in the first 3s are authenticated as a foreign owner, so the real authorizer refuses
    // each handler's first attempt. Later requests carry the registered owner.
    if (calls === 1) refuseUntil = Date.now() + 6_000;
    const caller = Date.now() < refuseUntil ? `u_${"f".repeat(26)}` : owner;
    let material: RemoteManagerAuthorityMaterial;
    try {
      material = await issueRemoteManagerAuthority({
        request, owner: caller, scope: ["supervise"],
        authorizeRenewal: ({ owner: o, request: r }) => authorizeRemoteManagerRenewal({
          request: r, owner: o, space, accountPublicKey: auth.account.pub, proofSecret: "proof-secret",
          observeManagerGate, observeRun: async () => null,
        }),
        issue: async () => {
          const credentials = {} as NonNullable<RemoteManagerAuthorityMaterial["credentials"]>;
          for (const n of names) { const c = await sign(n); credentials[n] = { jwt: jwtFromCreds(c)!, exp: credsClaims(c).exp! }; }
          return { credentials };
        },
      });
    } catch (e) { refusals++; throw e; }
    return material;
    },
  });
  const renewStandingBundle = async (processEpoch: number) => {
    adopted = await standing.renewStandingBundle(processEpoch);
    return adopted;
  };

  manager = new Manager({
    space, servers: SERVERS, runtime: "pty", workspaceRoot: mkdtempSync(join(tmpdir(), "fstart-")),
    remoteAuthority: {
      owner, actors, instanceId, lifecycleUid: managerLifecycleUid, identities: held,
      accountPublicKey: standing.accountPublicKey,
      supervisorCreds: initial.supervisor, executorCreds: initial.executor, serveCreds: initial.serve,
      goalWriterCreds: initial.goalWriter, sessionLedgerCreds: initial.sessionLedger,
      renewExecutor: async () => { throw new Error("per-duty executor renewal must not run under the all-duty family"); },
      renewStandingBundle,
      serveGrant: registered.serveGrant,
      agentBearerExchangeUrl: "https://auth.example.test",
      mintSessionServing: async () => { throw new Error("zero-agent smoke"); },
      mintRetirementRequester: async () => { throw new Error("zero-agent smoke"); },
      validateRetainedAgent: async () => { throw new Error("zero-agent smoke"); },
      scanGoalIndex: async () => [], authorizeAdmin: async () => false,
      prepareAgentRetirement: async () => { throw new Error("zero-agent smoke"); },
    },
  });
  const m = manager as unknown as Internals;
  await manager.start();
  const epoch = m.serviceServe!.grant.epoch;
  const conns = () => [m.ep.nc, m.serviceServe?.nc, m.goalWriter?.nc, m.sessionLedgerConn?.nc];
  const firstConns = conns();

  await cell("Manager.start() brings up supervisor, serve, goal-writer and session-ledger on the initial family", async () => {
    assert.deepEqual(await Promise.all(conns().map(flushes)), [true, true, true, true]);
    assert.equal(calls, 0);
    assert.equal(m.managerInstanceId, instanceId);
  });
  await cell("the broker expires the family and the serve, goal-writer and session-ledger connections close", async () => {
    assert.ok(await until(async () => (await Promise.all(firstConns.slice(1).map((nc) => nc!.isClosed()))).every(Boolean), (TTL + 25) * 1000),
      "a standing connection did not close after expiry");
    for (const n of names) assert.equal(inspectCredHealth(initial[n]).state, "expired");
  });
  await cell("the close handlers ask for the all-duty family, the foreign-owner request is refused, and last-good is kept with debt", async () => {
    assert.ok(await until(() => refusals >= 1, 10_000), "no all-duty request was refused");
    // Each close handler re-dials through `boundedReconnect`, which waits out a retry delay BEFORE its
    // first attempt, and the gate above stops refusing 6s after the FIRST call reaches it. So whether
    // a given handler ever sees the refusal depends on where its first attempt lands relative to a
    // window another handler opened, and nothing sequences the three against it. Requiring all three
    // to report the refusal asserts an ordering the system does not provide: on 2026-09-30 the service
    // endpoint closed last, its first attempt succeeded (`manager service endpoint re-dialed`), and
    // shard 3 reddened on a handler that behaved correctly. What every handler owes is a terminal
    // outcome in the log; silence is the defect. The refusal itself stays asserted twice over, by
    // `refusals >= 1` above and by the aggregate below.
    const refused = (label: string) => new RegExp(`manager ${label} re-dial attempt failed: .*another owner`);
    // The three terminal shapes `boundedReconnect`'s callers actually emit. The pre-re-dial
    // `manager <label> connection closed: ...` line is deliberately NOT one of them: matching it
    // would make this cell vacuous, since it is logged before any attempt is made.
    const settled = (label: string) => new RegExp(`manager ${label} (?:re-dialed|could not be re-dialed|could not be restored)`);
    for (const label of ["service endpoint", "goal-writer", "session-ledger"])
      assert.ok(await until(() => logged.some((l) => refused(label).test(l) || settled(label).test(l)), 5_000),
        `the ${label} close handler reported neither the all-duty refusal nor a re-dial outcome`);
    assert.ok(["service endpoint", "goal-writer", "session-ledger"].some((label) => logged.some((l) => refused(label).test(l))),
      "no close handler reported the all-duty refusal, so the refusal reached no operator-visible log");
    assert.ok(m.remoteRenewalDebt === undefined || m.remoteRenewalDebt.processEpoch === epoch);
    if (!adopted) {
      assert.equal(m.remoteSupervisorCreds, initial.supervisor);
      assert.equal(m.remoteExecutorCreds, initial.executor);
      assert.match(m.remoteRenewalDebt!.reason, /another owner/);
    }
  });
  await cell("the next attempt adopts the repaired family for the same nkeys and every standing connection serves again", async () => {
    assert.ok(await until(async () => adopted !== undefined && (await Promise.all(conns().map(flushes))).every(Boolean), 40_000),
      `standing connections not restored: ${JSON.stringify(await Promise.all(conns().map(flushes)))}`);
    assert.ok(refusals >= 1);
    assert.equal(m.remoteRenewalDebt, undefined);
    assert.equal(m.remoteSupervisorCreds, adopted!.supervisor);
    assert.equal(m.remoteExecutorCreds, adopted!.executor);
    assert.equal(m.serviceServe!.creds, adopted!.serve);
    assert.equal(m.goalWriter!.creds, adopted!.goalWriter);
    assert.equal(m.sessionLedgerConn!.creds, adopted!.sessionLedger);
    for (const n of names) assert.equal(credsClaims(adopted![n]).sub, held[n].id, `${n} keeps its held nkey`);
  });
  await cell("the control identity and serve epoch are unchanged after recovery", async () => {
    assert.equal(m.managerInstanceId, instanceId);
    assert.equal(m.serviceServe!.grant.epoch, epoch);
    assert.equal((await observeManagerGate() as unknown as { processEpoch: number }).processEpoch, epoch);
  });
  await cell("clean stop deregisters through the adopted family, not the per-duty executor renewal", async () => {
    await manager!.stop({ withAgents: true });
    assert.ok(logged.some((l) => /deregistered manager instance/.test(l)), "clean deregistration did not happen");
    assert.ok(!logged.some((l) => /per-duty executor renewal must not run/.test(l)), "per-duty executor renewal ran");
  });
  await hostNc.close();
} finally {
  console.error = origError;
  await manager?.stop({ withAgents: true }).catch((e: Error) => console.log(`stop: ${e.message}`));
  releaseBroker();
  await killAndAwaitExit(srv);
}

console.log(`\nremote-start-expiry-recovery: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
