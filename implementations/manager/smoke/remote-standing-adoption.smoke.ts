/**
 * Live adoption of the closed all-duty standing renewal by the real Manager renewal path, with zero
 * agents. Five standing connections dial a real nats-server under short-lived JWTs for the SAME
 * held nkeys and read the manager's current credential on every (re)connect. The broker expires
 * them; a failed, a foreign-account and an epoch-fenced candidate each leave the last-good family
 * untouched and record explicit cleanup debt; the repaired candidate is preflighted and adopted,
 * and every connection is back on the broker under the renewed JWT with the same nkey.
 * Authority delay, two sequential delayed broker handshakes, and post-adoption reconnect delay
 * exercise the shared ten-second budget. Late authority results and PONGs cannot adopt.
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
import { createServer, connect as tcpConnect, type Socket } from "node:net";
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  createSpaceAuth, credsClaims, jwtFromCreds, isReachable, mintCreds, mintLifecycleUid, newIdentity, remoteManagerActors, serverConfig,
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
  dialServeConnection(state: { identity: Identity; creds?: string }, readCreds: () => string): Promise<{ nc: NatsConnection; handle: { stop(): Promise<void> } }>;
  renewRemoteStandingBundle(force?: boolean): Promise<void>;
  remoteSupervisorCreds?: string; remoteExecutorCreds?: string; goalWriterCreds?: string; sessionLedgerCreds?: string;
  serviceServe?: { nc: NatsConnection; identity: Identity; grant: { epoch: number }; creds?: string };
  goalWriter?: { nc: NatsConnection; creds?: string };
  sessionLedgerConn?: { nc: NatsConnection; creds?: string };
  ep: { refreshCredsRequestSafe(): Promise<void> };
  remoteRenewalDebt?: { processEpoch: number; reason: string; unadoptedSubjects: string[] };
};

const conns: NatsConnection[] = [];
const sockets = new Set<Socket>();
const holds = new Set<string>();
const heldDials: number[] = [];
const proxy = createServer((inbound) => {
  const outbound = tcpConnect(PORT, "127.0.0.1");
  sockets.add(inbound); sockets.add(outbound);
  const drop = () => { inbound.destroy(); outbound.destroy(); sockets.delete(inbound); sockets.delete(outbound); };
  inbound.on("error", drop); outbound.on("error", drop);
  inbound.on("close", drop); outbound.on("close", drop);
  let connectBytes = "";
  let hold = false;
  let held = false;
  inbound.on("data", (chunk) => {
    if (holds.size) {
      connectBytes = (connectBytes + chunk.toString()).slice(-65_536);
      for (const jwt of holds) if (connectBytes.includes(jwt)) {
        holds.delete(jwt); hold = true; heldDials.push(performance.now());
      }
    }
    outbound.write(chunk);
  });
  outbound.on("data", (chunk) => {
    if (hold && !held && chunk.includes("PONG\r\n")) {
      held = true;
      setTimeout(() => { if (!inbound.destroyed) inbound.write(chunk); }, 6_000);
    } else if (!inbound.destroyed) inbound.write(chunk);
  });
});
try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const TTL = 16;
  const initial = await family(auth, TTL);
  let mode: "fail" | "foreign" | "fenced" | "good" | "late" | "slow" = "fail";
  let finishLate: (() => void) | undefined;
  let lateAuthorityDone: Promise<void> | undefined;
  let calls = 0;
  let m!: Internals;
  const renewed: { value?: Record<Name, string> } = {};
  const manager = new Manager({
    space, servers: `nats://127.0.0.1:${address.port}`, runtime: "pty",
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
        const candidate = await family(auth, 3600);
        if (mode === "slow") {
          holds.add(jwtFromCreds(candidate.supervisor)!);
          holds.add(jwtFromCreds(candidate.executor)!);
        }
        if (mode === "late") {
          lateAuthorityDone = new Promise<void>((resolve) => { finishLate = resolve; });
          await lateAuthorityDone;
        }
        renewed.value = candidate;
        return candidate;
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
  m.ep = { refreshCredsRequestSafe: async () => { await supNc.reconnect(); await execNc.reconnect(); } };
  m.serviceServe = { nc: undefined as never, identity: held.serve, grant: { epoch: 7 }, creds: initial.serve };
  m.serviceServe.nc = await live(() => m.serviceServe!.creds!, held.serve);
  Object.assign(m.serviceServe, { handle: { stop: async () => {} } });
  // This fixture tests family adoption, not branded endpoint authorization or dispatch.
  // Keep its transport-only seam explicit. The continuity smoke covers native serving.
  m.dialServeConnection = async (_state, readCreds) => {
    const nc = await live(readCreds, held.serve);
    await nc.flush();
    conns[conns.indexOf(m.serviceServe!.nc)] = nc;
    conns.pop();
    return { nc, handle: { stop: async () => {} } };
  };
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
  await cell("a stalled authority has one aggregate budget and records all possibly issued subjects", async () => {
    mode = "late";
    const started = performance.now();
    const scheduled = m.renewRemoteStandingBundle();
    await wait(50);
    const forced = m.renewRemoteStandingBundle(true);
    await Promise.all([scheduled, forced]);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 9_500 && elapsed < 12_000, `renewal took ${elapsed}ms`);
    assert.deepEqual(holders(), initial);
    assert.match(m.remoteRenewalDebt!.reason, /aggregate budget.*issuance outcome is unknown/);
    assert.deepEqual(new Set(m.remoteRenewalDebt!.unadoptedSubjects), new Set(names.map((n) => held[n].id)));
  });
  await cell("the repaired family is adopted for all five duties and debt is cleared", async () => {
    mode = "good";
    await m.renewRemoteStandingBundle();
    assert.deepEqual(holders(), renewed.value);
    assert.equal(m.remoteRenewalDebt, undefined);
    for (const n of names) assert.equal(credsClaims(renewed.value![n]).sub, held[n].id, `${n} keeps its held nkey`);
  });
  await cell("the timed-out authority's late result cannot overwrite a newer adoption or its debt", async () => {
    const adopted = holders();
    finishLate!();
    await lateAuthorityDone;
    await wait(100);
    assert.deepEqual(holders(), adopted);
    assert.equal(m.remoteRenewalDebt, undefined);
  });
  await cell("every standing connection is back on the broker under the renewed JWT", async () => {
    let ok: boolean[] = [];
    for (let i = 0; i < 20; i++) { ok = await flushAll(); if (ok.every(Boolean)) break; await wait(250); }
    assert.deepEqual(ok, [true, true, true, true, true]);
  });
  await cell("two sub-budget preflight handshakes share one aggregate deadline and retain the healthy old family", async () => {
    mode = "slow";
    const previous = holders();
    const started = performance.now();
    await assert.rejects(m.renewRemoteStandingBundle(true), /aggregate budget|TIMEOUT/i);
    const elapsed = performance.now() - started;
    assert.equal(heldDials.length, 2, "both six-second handshakes must be reached");
    assert.ok(elapsed >= 9_500 && elapsed < 12_000, `preflight took ${elapsed}ms`);
    assert.deepEqual(holders(), previous);
    assert.deepEqual(await flushAll(), [true, true, true, true, true]);
    await wait(2_500);
    assert.deepEqual(holders(), previous, "a late PONG cannot adopt the abandoned family");
    mode = "good";
  });
  await cell("a post-adoption reconnect wait expires without undoing adoption or inventing unadopted debt", async () => {
    const reconnect = m.ep.refreshCredsRequestSafe;
    let finishReconnect!: () => void;
    const pending = new Promise<void>((resolve) => { finishReconnect = resolve; });
    m.ep.refreshCredsRequestSafe = () => pending;
    try {
      const started = performance.now();
      await m.renewRemoteStandingBundle(true);
      assert.ok(performance.now() - started < 12_000, "adopted reconnect exceeded the shared budget");
      assert.deepEqual(holders(), renewed.value);
      assert.equal(m.remoteRenewalDebt, undefined);
    } finally {
      finishReconnect();
      m.ep.refreshCredsRequestSafe = reconnect;
    }
  });
  await cell("the renewed connections stay served well past the initial expiry", async () => {
    await wait(TTL * 1000 / 2);
    assert.deepEqual(await flushAll(), [true, true, true, true, true]);
  });
} finally {
  await Promise.all(conns.map((nc) => nc.close().catch(() => {})));
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  releaseBroker();
  await killAndAwaitExit(srv);
}

console.log(`\nremote-standing-adoption: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
