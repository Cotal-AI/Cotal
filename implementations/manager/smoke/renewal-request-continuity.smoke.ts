/**
 * Live public requests across 20 real all-duty Manager renewals. No production overrides.
 * Run: pnpm tsx implementations/manager/smoke/renewal-request-continuity.smoke.ts
 *
 * The fixture authority owns the test signer. Seats are real child processes installed in the
 * manager inventory, not enrolled agents: suppressCleanup intentionally excludes host retirement.
 * This tests the shipped stop handlers and runtime exit, not enrollment or retirement protocols.
 * Broker -D stderr and JSONL observations are retained under the printed evidence directory.
 * Never use -V here: protocol traces can contain credential payloads.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth, credsClaims, DEV_OWNER, epAuthBucket, epCall, isReachable, jwtFromCreds,
  mintCreds, mintLifecycleUid, newIdentity, principalKey, remoteManagerActors,
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
const TTL = 8;
const REQUIRED = 20;
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
let lastIssuedServe: string | undefined;
let setupComplete = false;
let running = true;
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
    lastIssuedServe = family.serve;
    renewals++;
    record("authority-renewal", { count: renewals, processEpoch, expires: credsClaims(family.serve).exp });
    return family;
  };
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
      scanGoalIndex: async () => [], authorizeAdmin: async () => false,
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
  const pending = new Set<Promise<unknown>>();
  const launch = (p: Promise<unknown>) => { pending.add(p); void p.finally(() => pending.delete(p)); };
  const deadline = Date.now() + 230_000;
  const readLoop = (async () => {
    let i = 0;
    while (running) { instrument(); launch(call(i++ % 2 ? "ps" : "status")); await wait(40); }
  })();
  let seatNumber = 0;
  try {
    while (renewals < REQUIRED && Date.now() < deadline) {
      const identity = newIdentity();
      const uid = mintLifecycleUid();
      const name = `fixture-${seatNumber++}`;
      const self: EpCaller = { owner, actor: identity.id, uid };
      const nc = await connect({ servers, ...standaloneConnectOpts({ tls: false, creds: await mintCreds(auth, identity, "agent", { lifecycleUid: uid }) }) });
      clients.push(nc);
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      children.push(child);
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      const exited = new Promise<void>((resolve) => child.once("exit", () => { record("seat-exit", { name }); resolve(); }));
      const handle: AgentHandle = {
        name, kind: "continuity-fixture", pid: child.pid,
        status: () => child.exitCode !== null || child.signalCode !== null ? "exited" : "running",
        stop: () => {
          const row = [...calls].reverse().find((c) => c.seat === name);
          if (row) row.executionAt = Date.now();
          record("runtime-stop", { name, id: row?.id, command: row?.command }); child.kill("SIGTERM");
        },
        waitForExit: () => exited, interrupt: () => { child.kill("SIGINT"); },
        attach: () => { throw new Error("fixture has no terminal"); },
      };
      const seat: InventorySeat = { name, id: principalKey(owner, identity.id).key, actor: identity.id, userOwner: owner,
        lifecycleUid: uid, spawner: principalKey(owner, caller.actor).key,
        startedAt: Date.now(), agent: "fixture", handle, launch: { cwd: store }, suppressCleanup: true };
      m.agents.set(name, seat);
      await wait(120);
      const row = await call(seatNumber % 2 ? "stop" : "despawn", seatNumber % 2 ? nc : callerNc, seatNumber % 2 ? self : caller, seat);
      // Never retry an unknown outcome. Clean up only this fixture's process and inventory slot.
      if (!row.executionAt) { child.kill("SIGTERM"); m.agents.delete(name); }
      await exited;
      await nc.close();
      await wait(100);
    }
  } finally { running = false; await readLoop; await Promise.all(pending); }
  // Observe the final returned family actually being applied before claiming 20 renewals.
  await wait(1200);
  const missing = calls.filter((c) => !c.replyReceived);
  const refusals = calls.filter((c) => c.replyReceived && !c.ok);
  const brokerText = readFileSync(brokerLog, "utf8");
  const errors = brokerText.split("\n").filter((line) => /\[ERR\]|permissions violation|permission.*denied/i.test(line));
  for (const line of errors) record("broker-error", { line });
  for (const row of missing) record("missing-classification", {
    ...row,
    classification: row.replyAttemptAt ? "reply-attempted-no-successful-reply" : row.executionAt ? "executed-no-observed-reply-attempt" : "gap-or-unobserved-handler",
    // A permission denial is evidence only when the broker itself emits it. Temporal proximity
    // alone does not attribute a denial to one request, nor prove dynamic response permissions.
    brokerPermissionDenialObserved: errors.some((line) => /permission/i.test(line)),
  });
  record("summary", { renewals, requests: calls.length, missing: missing.length, refusals: refusals.length, brokerErrors: errors.length });
  console.log(JSON.stringify({ renewals, requests: calls.length, missing: missing.length, refusals: refusals.length, brokerErrors: errors.length, evidence }));
  assert.ok(renewals >= REQUIRED, `only ${renewals} real authority renewals before deadline`);
  assert.equal(m.serviceServe?.creds, lastIssuedServe, "last issued family must actually be adopted");
  assert.ok(calls.some((c) => c.command === "stop" && c.executionAt), "real self-stop must execute");
  assert.ok(calls.some((c) => c.command === "despawn" && c.executionAt), "real despawn must execute");
  assert.equal(missing.length, 0, "public requests lost across real renewals, see timestamped evidence");
  assert.equal(refusals.length, 0, "public requests received structured refusals, see timestamped evidence");
  assert.equal(errors.length, 0, "broker emitted errors during renewal, see retained broker stderr");
} finally {
  running = false;
  record("cleanup", { setupComplete, renewals });
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await manager?.stop({ withAgents: true }).catch(() => {});
  await Promise.all(clients.map((nc) => nc.close()));
  await Promise.allSettled(watchers);
  releaseBroker();
  await killAndAwaitExit(broker);
}
