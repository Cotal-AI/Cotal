/**
 * Real Manager renewal against a broker paused at the original serve handle's native drain.
 * Run: pnpm tsx implementations/manager/smoke/renewal-retirement-bound.smoke.ts
 *
 * The fixture authority owns the test signer. Real public status/ps establish serving before
 * each renewal. Only the owned broker is paused, and the original serve stop still runs.
 * Broker -D stderr and JSONL observations are retained under the printed evidence directory.
 * Never use -V here: protocol traces can contain credential payloads.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth, credsClaims, DEV_OWNER, epAuthBucket, epCall, isReachable, jwtFromCreds,
  mintCreds, mintLifecycleUid, newIdentity, remoteManagerActors,
  serveIssuanceGateKv, serverConfig, setupSpaceStreams, standaloneConnectOpts,
  type AgentHandle, type EpCaller, type Identity, type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { authorizeRemoteManagerRenewal, issueRemoteManagerAuthority } from "../../auth/src/manager-authority.js";
import { remoteManagerCurrentRegistrationProof } from "../../auth/src/retained-manager-validation.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { Manager } from "../src/manager.js";
import { MANAGER_CONTRACTS, MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { remoteManagerRenewalCredentials } from "../src/remote-authority.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const TTL = 120;
const space = `continuity${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
// Evidence is outside the broker store so broker cleanup cannot discard the proof.
const evidence = mkdtempSync(join(tmpdir(), "renewal-continuity-evidence-"));
const eventsPath = join(evidence, "observations.jsonl");
const brokerLog = join(evidence, "broker.stderr.log");
console.log(`continuity evidence: ${evidence}`);
const record = (kind: string, data: Record<string, unknown> = {}) =>
  appendFileSync(eventsPath, `${JSON.stringify({ at: Date.now(), kind, ...data })}\n`);
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(store, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port, storeDir: join(store, "js"),
}));
const logFd = openSync(brokerLog, "a", 0o600);
const broker = spawn("nats-server", ["-D", "-c", join(store, "server.conf")], { stdio: ["ignore", "ignore", logFd] });
closeSync(logFd);
const releaseBroker = teardownOnSignal(broker, store);
const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
type Duty = typeof names[number];
const owner = DEV_OWNER;
const instanceId = mintLifecycleUid();
const lifecycleUid = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const held = Object.fromEntries(names.map((n) => [n, newIdentity()])) as Record<Duty, Identity>;
let signServe: (() => Promise<string>) | undefined;
const sign = (n: Duty) => {
  if (n === "serve" && signServe) return signServe();
  const actor = n === "serve" ? actors.supervisor : actors[n];
  return mintCreds(auth, held[n], n === "goalWriter" ? "goal-writer" : n === "sessionLedger" ? "session-ledger" : "remote-manager", {
    principal: { owner, actor }, expiresInSeconds: TTL,
    ...(n === "goalWriter" ? { goalWriter: { endpoint: "manager" } } : {}),
    ...(["supervisor", "executor", "serve"].includes(n) ? { remoteManager: { instanceId, owner, actor } } : {}),
  });
};
type InventorySeat = {
  name: string; id: string; actor: string; userOwner: string; lifecycleUid: string; spawner: string; startedAt: number;
  agent: string; handle: AgentHandle; launch: { cwd: string }; suppressCleanup: boolean;
};
type Internals = {
  agents: Map<string, InventorySeat>;
  ep: { nc: NatsConnection };
  serviceServe?: { nc: NatsConnection; creds?: string; grant: { epoch: number } };
  goalWriter?: { nc: NatsConnection };
  sessionLedgerConn?: { nc: NatsConnection };
};
type Observation = {
  id: string; command: string; start: number; end?: number; ok?: boolean;
  error?: string; replyReceived?: boolean; replyAttemptAt?: number; executionAt?: number; seat?: string;
};
const calls: Observation[] = [];
const byId = new Map<string, Observation>();
const clients: NatsConnection[] = [];
const children: ReturnType<typeof spawn>[] = [];
const watchers: Promise<void>[] = [];
let manager: Manager | undefined;
let renewals = 0;
let setupComplete = false;
const watched = new WeakSet<NatsConnection>();
function observeConnection(nc: NatsConnection, duty: string) {
  if (watched.has(nc)) return;
  watched.add(nc);
  // Preserve the existing publish implementation and all arguments. Only reply envelope ids
  // are observed, never logged payloads, credentials, or arbitrary application data.
  const publish = nc.publish.bind(nc);
  nc.publish = (...args: Parameters<NatsConnection["publish"]>) => {
    if (args[0].includes(".ep.reply.") || args[0].includes(".ep.v1.reply.")) {
      try {
        const body = JSON.parse(typeof args[1] === "string" ? args[1] : new TextDecoder().decode(args[1]));
        const row = byId.get(String(body.id));
        if (row) { row.replyAttemptAt = Date.now(); record("reply-attempt", { id: row.id, duty, subject: args[0] }); }
      } catch { /* Non-envelope publishes are outside this observation. */ }
    }
    return publish(...args);
  };
  watchers.push((async () => {
    for await (const status of nc.status()) {
      record("connection-status", { duty, type: status.type, data: "data" in status ? String(status.data) : undefined });
    }
  })());
}
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const initial = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await sign(n)]))) as Record<Duty, string>;
  const registered = await registerRemoteManagerAuthority({
    space, server: servers, owner, instanceId, serveActor: actors.serve,
    prepareCreds: initial.executor, tlsRequired: false, evict: async (principals) => principals.map(() => true),
  });
  const hostNc = await connect({ servers, ...standaloneConnectOpts({
    creds: await mintCreds(auth, newIdentity(), "issuer", { principal: { owner, actor: "host_issuer" } }), tls: false,
  }) });
  clients.push(hostNc);
  const gate = serveIssuanceGateKv(await new Kvm(hostNc).open(epAuthBucket(space)), space, { endpoint: "manager", instanceId });
  // Issuer observes registration but cannot write the serving credential ledger. The host
  // uses a separate one-instance executor for the actual mint fence, never wider issuer grants.
  const mintNc = await connect({ servers, ...standaloneConnectOpts({ tls: false,
    creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
      endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId },
    }),
  }) });
  clients.push(mintNc);
  const mintGate = serveIssuanceGateKv(await new Kvm(mintNc).open(epAuthBucket(space)), space, { endpoint: MANAGER_ENDPOINT, instanceId });
  signServe = () => mintCreds(auth, held.serve, "endpoint-serve", {
    principal: { owner, actor: actors.serve }, expiresInSeconds: TTL,
    endpointServe: registered.serveGrant, serveIssuance: mintGate,
  });
  // Registration creates the branded grant and its live mint fence. The placeholder serve
  // credential above is never dialed. Release real serving authority only after registration.
  initial.serve = await signServe();
  const observeManagerGate = async () => {
    const g = await gate.observe();
    return g ? { state: g.state, principal: g.principal, processEpoch: g.processEpoch, registrationRevision: g.registrationRevision } as never : null;
  };
  const renewStandingBundle = async (processEpoch: number) => {
    const current = (await observeManagerGate()) as unknown as { processEpoch: number; registrationRevision: number };
    const base = {
      v: 1 as const, kind: "manager-service-authority" as const, operation: "renewStandingBundle" as const,
      space, actor: "cli", instanceId, managerLifecycleUid: lifecycleUid, requestId: `renew${mintLifecycleUid()}`,
      accountPublicKey: auth.account.pub, processEpoch,
      identities: Object.fromEntries(names.map((n) => [n, { id: held[n].id }])) as RemoteManagerAuthorityRequest["identities"],
    };
    const request = { ...base, registrationProof: remoteManagerCurrentRegistrationProof("fixture-proof", owner, base, current) } as RemoteManagerAuthorityRequest;
    const material = await issueRemoteManagerAuthority({
      request, owner, scope: ["supervise"],
      authorizeRenewal: ({ owner: o, request: r }) => authorizeRemoteManagerRenewal({
        request: r, owner: o, space, accountPublicKey: auth.account.pub, proofSecret: "fixture-proof",
        observeManagerGate, observeRun: async () => null,
      }),
      issue: async () => {
        const credentials = {} as NonNullable<RemoteManagerAuthorityMaterial["credentials"]>;
        for (const n of names) {
          const c = await sign(n);
          credentials[n] = { jwt: jwtFromCreds(c)!, exp: credsClaims(c).exp! };
        }
        return { credentials };
      },
    });
    const family = remoteManagerRenewalCredentials(material, request, owner, held) as Record<Duty, string>;
    renewals++;
    record("authority-renewal", { count: renewals, processEpoch, expires: credsClaims(family.serve).exp });
    return family;
  };
  let slowRead: { entered: () => void; resume: Promise<void> } | undefined;
  const unused = async (): Promise<never> => { throw new Error("fixture does not enroll or retire agents"); };
  manager = new Manager({
    space, servers, runtime: "pty", workspaceRoot: join(store, "workspace"),
    remoteAuthority: {
      owner, actors, instanceId, lifecycleUid, identities: held, accountPublicKey: auth.account.pub,
      supervisorCreds: initial.supervisor, executorCreds: initial.executor, serveCreds: initial.serve,
      goalWriterCreds: initial.goalWriter, sessionLedgerCreds: initial.sessionLedger,
      renewExecutor: unused, renewStandingBundle, serveGrant: registered.serveGrant,
      agentBearerExchangeUrl: "https://auth.example.test", mintSessionServing: unused,
      mintRetirementRequester: unused, validateRetainedAgent: unused, prepareAgentRetirement: unused,
      scanGoalIndex: async () => [], authorizeAdmin: async () => {
        if (slowRead) { slowRead.entered(); await slowRead.resume; }
        return false;
      },
    },
  });
  await manager.start();
  const m = manager as unknown as Internals;
  const dispatchObserved = new WeakSet<NatsConnection>();
  const instrument = () => {
    for (const [duty, nc] of [["supervisor", m.ep.nc], ["serve", m.serviceServe?.nc],
      ["goalWriter", m.goalWriter?.nc], ["sessionLedger", m.sessionLedgerConn?.nc]] as const)
      if (nc) observeConnection(nc, duty);
    const nc = m.serviceServe?.nc;
    if (!nc || dispatchObserved.has(nc)) return;
    dispatchObserved.add(nc);
    // Fixture-only observation of the installed client's actual dispatch boundary.
    // Preserve the original callback, receiver and message without delaying or retrying it.
    // A replacement can receive requests before the next observation tick, so dispatch counts
    // are a diagnostic lower bound. Public replies determine continuity acceptance.
    const observedServe = nc as unknown as { protocol: { subscriptions: { all(): { subject: string; callback(error: Error | null, message: { data: Uint8Array; subject: string }): void }[] } } };
    for (const subscription of observedServe.protocol.subscriptions.all()) {
      if (!subscription.subject.includes(".ep.")) continue;
      const callback = subscription.callback;
      subscription.callback = function (error, message) {
        if (!error) {
          try {
            const body = JSON.parse(new TextDecoder().decode(message.data));
            if (byId.has(String(body.id))) record("request-dispatch", { id: body.id, subject: message.subject });
          } catch { /* Only fixture request envelope ids are observed. */ }
        }
        return callback.call(this, error, message);
      };
    }
  };
  instrument();
  // start() installs subscriptions synchronously, but their SUB frames may still be buffered.
  // Establish broker-side interest before the first measured caller on another connection.
  assert.ok(m.serviceServe, "SETUP: Manager must install the real service");
  await m.serviceServe.nc.flush();
  const callerIdentity = newIdentity();
  const caller: EpCaller = { owner, actor: callerIdentity.id, uid: mintLifecycleUid() };
  const callerNc = await connect({ servers, ...standaloneConnectOpts({ tls: false,
    creds: await mintCreds(auth, callerIdentity, "agent", {
      lifecycleUid: caller.uid, capabilities: ["spawn"],
      endpointCapabilities: [
        { endpoint: MANAGER_ENDPOINT, command: "status" },
        { endpoint: MANAGER_ENDPOINT, command: "ps" },
        { endpoint: MANAGER_ENDPOINT, command: "despawn", target: { mode: "owner", tOwner: owner } },
      ],
    }),
  }) });
  clients.push(callerNc);
  const epoch = async () => { const g = await gate.observe(); assert.ok(g); return g.processEpoch; };
  async function call(command: string, nc = callerNc, who = caller, seat?: InventorySeat) {
    const row: Observation = { id: `call${mintLifecycleUid()}`, command, start: Date.now(), ...(seat ? { seat: seat.name } : {}) };
    calls.push(row); byId.set(row.id, row); record("call-start", { ...row, renewals });
    try {
      const r = await epCall(nc, space, { mode: "one" }, {
        endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller: who, id: row.id,
        ...(seat ? { args: { graceful: true }, target: command === "stop" ? { mode: "self" as const } :
          { mode: "owner" as const, owner, actor: seat.actor, lifecycleUid: seat.lifecycleUid } } : {}),
      }, { deadlineMs: 1800, currentEpoch: epoch });
      row.replyReceived = true;
      row.ok = r.reply.ok;
      if (!r.reply.ok) row.error = r.reply.error?.code;
    } catch (error) { row.ok = false; row.error = error instanceof Error ? error.message : String(error); }
    finally { row.end = Date.now(); record("call-end", { ...row, renewals }); }
    return row;
  }
  // Fail setup separately. A bad credential or contract is not continuity evidence.
  assert.equal((await call("status")).ok, true, "SETUP: status must answer before sampling");
  assert.equal((await call("ps")).ok, true, "SETUP: ps must answer before sampling");
  setupComplete = true;
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  slowRead = { entered: enter, resume: new Promise<void>((resolve) => { resume = resolve; }) };
  const slowCall = call("ps");
  await Promise.race([entered, wait(3000).then(() => { throw new Error("public ps did not reach authority await"); })]);
  const normalOldNc = m.serviceServe!.nc;
  const normalDiagnostics: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { normalDiagnostics.push(args.map(String).join(" ")); originalError(...args); };
  const renew = () => (manager as unknown as { renewRemoteStandingBundle(force: boolean): Promise<void> }).renewRemoteStandingBundle(true);
  const normalRenewal = renew();
  await wait(300);
  assert.notEqual(m.serviceServe!.nc, normalOldNc, "replacement adopted while original public ps is pending");
  assert.equal(normalOldNc.isClosed(), false, "old transport retains pending native public ps");
  resume();
  assert.equal((await slowCall).ok, true, "slow public ps retains original reply through renewal");
  slowRead = undefined;
  await normalRenewal;
  console.error = originalError;
  assert.equal(normalDiagnostics.some((line) => line.includes("retired serve drainage")), false, "successful drain reports no unfinished work");
  const old = m.serviceServe! as NonNullable<Internals["serviceServe"]> & { handle: { stop(): Promise<void> } };
  const oldNc = old.nc;
  const originalStop = old.handle.stop.bind(old.handle);
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => { reached = resolve; });
  old.handle.stop = () => {
    assert.equal(broker.kill("SIGSTOP"), true, "pause only the fixture broker");
    record("broker-paused-at-real-drain");
    reached();
    return originalStop();
  };
  const diagnostics: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { diagnostics.push(args.map(String).join(" ")); error(...args); };
  const renewal = (manager as unknown as { renewRemoteStandingBundle(force: boolean): Promise<void> }).renewRemoteStandingBundle(true);
  await blocked;
  const replacement = m.serviceServe!.nc;
  assert.notEqual(replacement, oldNc, "replacement adopted before old drain");
  let finished = false;
  void renewal.then(() => { finished = true; });
  await wait(6500);
  record("bounded-drain-observation", { finished, oldClosed: oldNc.isClosed(), replacementClosed: replacement.isClosed() });
  // Always recover the real broker before cleanup, including on the unchanged failing baseline.
  broker.kill("SIGCONT");
  assert.equal(oldNc.isClosed(), true, "EXPECTED BASELINE FAILURE: old transport remains open in real serve drain after 6500ms");
  assert.equal(replacement.isClosed(), false, "active replacement must survive old drain timeout");
  await renewal;
  console.error = error;
  assert.ok(diagnostics.some((line) => line.includes("old serve drain unfinished after 5000ms") && line.includes("must not be retried")), "unfinished drainage and no-retry outcomes must be reported");
  await Promise.race([manager.stop({ withAgents: true }), wait(5000).then(() => { throw new Error("Manager stop did not complete after broker recovery"); })]);
  manager = undefined;
  console.log("PASS: bounded real serve retirement, replacement retained, Manager stop completed");
} finally {
  broker.kill("SIGCONT");
  record("cleanup", { setupComplete, renewals });
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await manager?.stop({ withAgents: true }).catch(() => {});
  await Promise.all(clients.map((nc) => nc.close()));
  await Promise.allSettled(watchers);
  releaseBroker();
  await killAndAwaitExit(broker);
}
