/**
 * Live adoption of the closed all-duty standing renewal by the real Manager renewal path, with zero
 * agents. Five standing connections dial a real nats-server under short-lived JWTs for the SAME
 * held nkeys and read the manager's current credential on every (re)connect. The broker expires
 * them; a failed, a foreign-account and an epoch-fenced candidate each leave the last-good family
 * untouched and record explicit cleanup debt; the repaired candidate is preflighted and adopted,
 * and every connection is back on the broker under the renewed JWT with the same nkey.
 *
 * Limit: the five connections are dialed by this smoke through the manager's own dialer and read
 * the manager's own credential holders, with ignoreAuthErrorAbort so an expired connection keeps
 * retrying. The manager's closed-connection handlers and full Manager.start() are not exercised here.
 *
 * Run: tsx implementations/manager/smoke/remote-standing-adoption.smoke.ts (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  createSpaceAuth, credsClaims, isReachable, mintCreds, mintLifecycleUid, newIdentity, remoteManagerActors, serverConfig,
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

const space = `adopt${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
const foreign = await createSpaceAuth(space);
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
type Name = (typeof names)[number];
const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const held: Record<Name, Identity> = { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() };
const sign = async (signer: SpaceAuth, name: Name, ttl: number, id = held[name]) => {
  const actor = name === "serve" ? actors.supervisor : actors[name];
  return mintCreds(signer, id, name === "goalWriter" ? "goal-writer" : name === "sessionLedger" ? "session-ledger" : "remote-manager", {
    principal: { owner, actor },
    ...(name === "goalWriter" ? { goalWriter: { endpoint: "manager" } } : {}),
    ...(name === "supervisor" || name === "executor" || name === "serve" ? { remoteManager: { instanceId, owner, actor } } : {}),
    expiresInSeconds: ttl,
  });
};
const family = async (signer: SpaceAuth, ttl: number) =>
  Object.fromEntries(await Promise.all(names.map(async (n) => [n, await sign(signer, n, ttl)]))) as Record<Name, string>;

type Internals = {
  dial(opts: object): Promise<NatsConnection>;
  renewRemoteStandingBundle(force?: boolean): Promise<void>;
  remoteSupervisorCreds?: string; remoteExecutorCreds?: string; goalWriterCreds?: string; sessionLedgerCreds?: string;
  serviceServe?: { nc: NatsConnection; identity: Identity; grant: { epoch: number }; creds?: string };
  goalWriter?: { nc: NatsConnection; creds?: string };
  sessionLedgerConn?: { nc: NatsConnection; creds?: string };
  ep: { reconnect(): Promise<void> };
  remoteRenewalDebt?: { processEpoch: number; reason: string; unadoptedSubjects: string[] };
};

const conns: NatsConnection[] = [];
try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });
  const TTL = 16;
  const initial = await family(auth, TTL);
  let mode: "fail" | "foreign" | "fenced" | "good" = "fail";
  let calls = 0;
  let m!: Internals;
  const renewed: { value?: Record<Name, string> } = {};
  const manager = new Manager({
    space, servers: SERVERS, runtime: "pty",
    remoteAuthority: {
      owner, actors, instanceId, lifecycleUid: mintLifecycleUid(), identities: held,
      accountPublicKey: auth.account.pub,
      supervisorCreds: initial.supervisor, executorCreds: initial.executor, serveCreds: initial.serve,
      goalWriterCreds: initial.goalWriter, sessionLedgerCreds: initial.sessionLedger,
      renewExecutor: async () => { throw new Error("per-duty executor renewal must not run when the all-duty family is configured"); },
      renewStandingBundle: async (processEpoch) => {
        calls++;
        assert.equal(processEpoch, 7);
        if (mode === "fail") throw new Error("injected issuer outage");
        if (mode === "foreign") return family(foreign, 3600);
        if (mode === "fenced") { const f = await family(auth, 3600); m.serviceServe!.grant.epoch = 8; return f; }
        renewed.value = await family(auth, 3600);
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
  const enc = new TextEncoder();
  // Every connection reads the manager's CURRENT holder at each (re)connect, like the real dialers.
  const live = async (read: () => string, id: Identity) => {
    const nc = await m.dial({ authenticator: (nonce?: string) => credsAuthenticator(enc.encode(read()))(nonce), inboxPrefix: `_INBOX_${id.id}`, maxReconnectAttempts: -1, reconnectTimeWait: 150, ignoreAuthErrorAbort: true });
    conns.push(nc);
    return nc;
  };
  const supNc = await live(() => m.remoteSupervisorCreds!, held.supervisor);
  const execNc = await live(() => m.remoteExecutorCreds!, held.executor);
  m.ep = { reconnect: async () => { await supNc.reconnect(); await execNc.reconnect(); } };
  m.serviceServe = { nc: undefined as never, identity: held.serve, grant: { epoch: 7 }, creds: initial.serve };
  m.serviceServe.nc = await live(() => m.serviceServe!.creds!, held.serve);
  // Manager.startServiceEndpoint seeds these two holders from the remote authority before dialing.
  m.goalWriterCreds = initial.goalWriter;
  m.sessionLedgerCreds = initial.sessionLedger;
  m.goalWriter = { nc: undefined as never, creds: initial.goalWriter };
  m.goalWriter.nc = await live(() => m.goalWriter!.creds!, held.goalWriter);
  m.sessionLedgerConn = { nc: undefined as never, creds: initial.sessionLedger };
  m.sessionLedgerConn.nc = await live(() => m.sessionLedgerConn!.creds!, held.sessionLedger);
  const holders = () => ({ supervisor: m.remoteSupervisorCreds, executor: m.remoteExecutorCreds, serve: m.serviceServe!.creds,
    goalWriter: m.goalWriter!.creds, sessionLedger: m.sessionLedgerConn!.creds });
  const flushAll = () => Promise.all(conns.map((nc) => Promise.race([nc.flush().then(() => true, () => false), wait(1500).then(() => false)])));

  await cell("five standing connections are live on the broker under the initial family", async () => {
    assert.deepEqual(await flushAll(), [true, true, true, true, true]);
  });
  await cell("a healthy family is not renewed", async () => {
    await m.renewRemoteStandingBundle();
    assert.equal(calls, 0);
  });
  await wait((TTL + 1.5) * 1000);
  await cell("the broker expired every initial JWT, so no connection is serving", async () => {
    assert.deepEqual(await flushAll(), [false, false, false, false, false]);
    for (const n of names) assert.equal((await import("@cotal-ai/core")).inspectCredHealth(initial[n]).state, "expired");
  });
  await cell("a failed issuer response keeps last-good and records cleanup debt", async () => {
    await m.renewRemoteStandingBundle();
    assert.equal(calls, 1);
    assert.deepEqual(holders(), initial);
    assert.equal(m.remoteRenewalDebt?.processEpoch, 7);
    assert.match(m.remoteRenewalDebt!.reason, /injected issuer outage/);
  });
  await cell("a foreign-account family is refused, keeps last-good and names the unadopted subjects", async () => {
    mode = "foreign";
    await m.renewRemoteStandingBundle();
    assert.deepEqual(holders(), initial);
    assert.match(m.remoteRenewalDebt!.reason, /another account/);
    assert.deepEqual(new Set(m.remoteRenewalDebt!.unadoptedSubjects), new Set(names.map((n) => held[n].id)));
  });
  await cell("a family returned after the serve epoch moved is fenced and never adopted", async () => {
    mode = "fenced";
    await m.renewRemoteStandingBundle();
    assert.deepEqual(holders(), initial);
    assert.match(m.remoteRenewalDebt!.reason, /serve epoch/);
    m.serviceServe!.grant.epoch = 7;
  });
  await cell("forced renewal surfaces a refused candidate to its caller", async () => {
    mode = "fail";
    await assert.rejects(m.renewRemoteStandingBundle(true), /injected issuer outage/);
    assert.deepEqual(holders(), initial);
  });
  await cell("the repaired family is adopted for all five duties and debt is cleared", async () => {
    mode = "good";
    await m.renewRemoteStandingBundle();
    assert.deepEqual(holders(), renewed.value);
    assert.equal(m.remoteRenewalDebt, undefined);
    for (const n of names) assert.equal(credsClaims(renewed.value![n]).sub, held[n].id, `${n} keeps its held nkey`);
  });
  await cell("every standing connection is back on the broker under the renewed JWT", async () => {
    let ok: boolean[] = [];
    for (let i = 0; i < 20; i++) { ok = await flushAll(); if (ok.every(Boolean)) break; await wait(250); }
    assert.deepEqual(ok, [true, true, true, true, true]);
  });
  await cell("the renewed connections stay served well past the initial expiry", async () => {
    await wait(TTL * 1000 / 2);
    assert.deepEqual(await flushAll(), [true, true, true, true, true]);
  });
} finally {
  await Promise.all(conns.map((nc) => nc.close().catch(() => {})));
  releaseBroker();
  await killAndAwaitExit(srv);
}

console.log(`\nremote-standing-adoption: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
