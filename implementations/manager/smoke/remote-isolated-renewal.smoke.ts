/**
 * Isolated live Manager.start() renewal for one expired serve, goal-writer, or executor credential.
 * Other standing rails stay healthy while the selected connection closes, or the one-shot executor
 * is invoked after expiry. The real registration gate and shipped renewal authorizer reject a foreign
 * owner, then the accepted all-duty family is adopted for the original nkeys and epoch.
 *
 * Limit: the signer is this smoke's test account key, not the auth-service route. The executor case
 * drives the real one-shot manager method but does not perform a full deregistration with a refused
 * executor credential. Workflow runs are not exercised here.
 *
 * Run: pnpm smoke:remote-isolated-renewal (needs nats-server on PATH)
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
import { remoteManagerRenewalCredentials } from "../src/remote-authority.js";
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
const target = process.env.F_ISOLATED_TARGET;
if (target !== "serve" && target !== "goalWriter" && target !== "executor") throw new Error("select an isolated renewal target");
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
  const TTL = 7;
  const initial = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await sign(n, n === target ? TTL : 3600)]))) as Record<Name, string>;
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
  const renewStandingBundle = async (processEpoch: number) => {
    calls++;
    const current = (await observeManagerGate()) as unknown as { processEpoch: number; registrationRevision: number };
    const base = {
      v: 1 as const, kind: "manager-service-authority" as const, operation: "renewStandingBundle" as const,
      space, actor: "cli", instanceId, managerLifecycleUid, requestId: `req${mintLifecycleUid()}`,
      accountPublicKey: auth.account.pub, processEpoch,
      identities: Object.fromEntries(names.map((n) => [n, { id: held[n].id }])) as RemoteManagerAuthorityRequest["identities"],
    };
    const request = { ...base, registrationProof: remoteManagerCurrentRegistrationProof("proof-secret", owner, base, current) } as RemoteManagerAuthorityRequest;
    // Requests in the first 3s are authenticated as a foreign owner, so the real authorizer refuses
    // each handler's first attempt. Later requests carry the registered owner.
    if (calls === 1) refuseUntil = Date.now() + 3_000;
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
    adopted = remoteManagerRenewalCredentials(material, request, owner, held) as Record<Name, string>;
    return adopted;
  };

  manager = new Manager({
    space, servers: SERVERS, runtime: "pty", workspaceRoot: mkdtempSync(join(tmpdir(), "fstart-")),
    remoteAuthority: {
      owner, actors, instanceId, lifecycleUid: managerLifecycleUid, identities: held,
      accountPublicKey: auth.account.pub,
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

  await cell("Manager.start() brings up supervisor, serve, goal-writer and session-ledger on the initial family", async () => {
    assert.deepEqual(await Promise.all(conns().map(flushes)), [true, true, true, true]);
    assert.equal(calls, 0);
    assert.equal(m.managerInstanceId, instanceId);
  });
  const baseline = [m.ep.nc, m.serviceServe?.nc, m.goalWriter?.nc, m.sessionLedgerConn?.nc];
  await cell("only the selected credential expires while the executor and sibling rails stay healthy", async () => {
    assert.ok(await until(() => inspectCredHealth(initial[target]).state === "expired", (TTL + 15) * 1000));
    for (const n of names) if (n !== target) assert.equal(inspectCredHealth(initial[n]).state, "healthy", `${n} must remain healthy`);
    if (target !== "executor") {
      const i = target === "serve" ? 1 : 2;
      assert.ok(await until(() => baseline[i]?.isClosed() ?? false, 12_000), `${target} connection did not close`);
      assert.equal(await flushes(baseline[target === "serve" ? 2 : 1]), true, "sibling still serves");
    }
  });
  await cell("the isolated path refuses a foreign owner without local remint or holder replacement", async () => {
    if (target === "executor") {
      await assert.rejects((m as unknown as { withEndpointServeExecutor(fn: () => Promise<void>): Promise<void> }).withEndpointServeExecutor(async () => {}), /another owner/);
    } else {
      const label = target === "serve" ? "service endpoint" : "goal-writer";
      assert.ok(await until(() => logged.some((l) => new RegExp(`manager ${label} re-dial attempt failed: .*another owner`).test(l)), 7_000), `${label} close handler did not surface host refusal`);
    }
    assert.ok(refusals >= 1, "issuer must refuse first request");
    assert.equal(m.remoteExecutorCreds, initial.executor, "last-good executor must remain held");
    assert.equal(m.serviceServe!.creds, initial.serve, "last-good serve must remain held");
    assert.equal(m.goalWriter!.creds, initial.goalWriter, "last-good goal writer must remain held");
  });
  await cell("the next isolated attempt adopts the entire family and serves with the held nkeys", async () => {
    if (target === "executor") {
      await wait(3_100);
      await (m as unknown as { withEndpointServeExecutor(fn: () => Promise<void>): Promise<void> }).withEndpointServeExecutor(async () => {});
    } else {
      const i = target === "serve" ? 1 : 2;
      assert.ok(await until(async () => conns()[i] !== baseline[i] && await flushes(conns()[i]), 30_000), `${target} connection was not restored`);
    }
    assert.ok(adopted, "closed host renewal must supply all five duties");
    for (const n of names) assert.equal(credsClaims(adopted![n]).sub, held[n].id);
    assert.equal(m.remoteExecutorCreds, adopted!.executor);
    assert.equal(m.serviceServe!.creds, adopted!.serve);
    assert.equal(m.goalWriter!.creds, adopted!.goalWriter);
    assert.equal(m.managerInstanceId, instanceId);
    assert.equal(m.serviceServe!.grant.epoch, epoch);
  });
  await manager.stop({ withAgents: true });
  await hostNc.close();
} finally {
  console.error = origError;
  await manager?.stop({ withAgents: true }).catch((e: Error) => console.log(`stop: ${e.message}`));
  releaseBroker();
  await killAndAwaitExit(srv);
}

console.log(`\nremote-isolated-renewal-${target}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
