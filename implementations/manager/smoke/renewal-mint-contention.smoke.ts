/** Live regression: ordinary serve mint versus real ordinary and sibling fence commits.
 * Only timing seams are wrapped. No product implementation is replaced.
 * Run with an approved nats-server on PATH and the workspace's absolute tsx.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth, DEV_OWNER, epAuthBucket, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, remoteManagerActors, serveIssuanceGateKv, serverConfig, setupSpaceStreams,
  standaloneConnectOpts, commitSiblingIssuance, credentialIdOf, jwtFromCreds, credsClaims,
  type EpIssuanceGate, type EpServeLedgerRow, type Identity,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { Manager } from "../src/manager.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const version = execFileSync("nats-server", ["--version"], { encoding: "utf8" }).trim();
const evidence = mkdtempSync(join(tmpdir(), "renewal-mint-contention-evidence-"));
console.log(`contention evidence: ${evidence}`);
const record = (kind: string, data: Record<string, unknown> = {}) => {
  const row = { at: Date.now(), kind, ...data };
  appendFileSync(join(evidence, "observations.jsonl"), `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
};
record("baseline", { version });
const space = `mintcollision${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(store, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(store, "js") }));
const fd = openSync(join(evidence, "broker.stderr.log"), "a", 0o600);
const broker = spawn("nats-server", ["-D", "-c", join(store, "server.conf")], { stdio: ["ignore", "ignore", fd] });
closeSync(fd);
const releaseBroker = teardownOnSignal(broker, store);
const clients: NatsConnection[] = [];
let manager: Manager | undefined;
const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
type Duty = typeof names[number];
const held = Object.fromEntries(names.map((n) => [n, newIdentity()])) as Record<Duty, Identity>;
const instanceId = mintLifecycleUid(), lifecycleUid = mintLifecycleUid(), owner = DEV_OWNER;
const actors = remoteManagerActors(instanceId);
const initialSign = (n: Duty) => mintCreds(auth, held[n], n === "goalWriter" ? "goal-writer" : n === "sessionLedger" ? "session-ledger" : n === "supervisor" ? "supervisor" : "remote-manager", {
  principal: { owner, actor: n === "serve" ? actors.supervisor : actors[n] }, expiresInSeconds: 12,
  ...(n === "goalWriter" ? { goalWriter: { endpoint: "manager" } } : {}),
  ...(["supervisor", "executor", "serve"].includes(n) ? { remoteManager: { instanceId, owner, actor: n === "serve" ? actors.supervisor : actors[n] } } : {}),
});
const staged = deferred<EpServeLedgerRow>(), release = deferred<void>(), renewalResult = deferred<{ ok: boolean; error?: string }>();
let armed = false, paused = false, attempts = 0;
let renewedServe: string | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const initial = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await initialSign(n)]))) as Record<Duty, string>;
  const registered = await registerRemoteManagerAuthority({ space, server: servers, owner, instanceId, serveActor: actors.serve,
    prepareCreds: initial.executor, tlsRequired: false, evict: async (principals) => principals.map(() => true) });
  const nc = await connect({ servers, ...standaloneConnectOpts({ tls: false, creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint: "manager", instanceId },
  }) }) });
  clients.push(nc);
  const gate = serveIssuanceGateKv(await new Kvm(nc).open(epAuthBucket(space)), space, { endpoint: "manager", instanceId });
  const wrapped: EpIssuanceGate = {
    ...gate,
    observe: async () => { const row = await gate.observe(); if (armed) record("observe", { revision: row?.revision, processEpoch: row?.processEpoch }); return row; },
    stage: async (row) => {
      try { await gate.stage(row); }
      catch (error) { record("stage-error", { credentialId: row.credentialId, error: String(error) }); throw error; }
      if (armed && !paused) { paused = true; record("ordinary-staged", { credentialId: row.credentialId }); staged.resolve(row); await release.promise; }
    },
    commit: async (revision) => { const won = await gate.commit(revision); if (armed) record("ordinary-commit", { revision, won }); return won; },
  };
  const signServe = () => mintCreds(auth, held.serve, "endpoint-serve", { principal: { owner, actor: actors.serve }, expiresInSeconds: 12,
    endpointServe: registered.serveGrant, serveIssuance: wrapped });
  initial.serve = await signServe();
  const unused = async (): Promise<never> => { throw new Error("fixture does not enroll or retire agents"); };
  manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: join(store, "workspace"), remoteAuthority: {
    owner, actors, instanceId, lifecycleUid, identities: held, accountPublicKey: auth.account.pub,
    supervisorCreds: initial.supervisor, executorCreds: initial.executor, serveCreds: initial.serve,
    goalWriterCreds: initial.goalWriter, sessionLedgerCreds: initial.sessionLedger,
    serveGrant: registered.serveGrant, agentBearerExchangeUrl: "https://auth.example.test", renewExecutor: unused,
    renewStandingBundle: async () => {
      attempts++; record("manager-renewal-callback", { attempts });
      try {
        const family = {} as Record<Duty, string>;
        for (const n of names) family[n] = n === "serve" ? await signServe() : await initialSign(n);
        renewedServe = family.serve;
        record("manager-renewal-success", { attempts }); renewalResult.resolve({ ok: true }); return family;
      } catch (error) { record("manager-renewal-failure", { attempts, error: String(error) }); renewalResult.resolve({ ok: false, error: String(error) }); throw error; }
    },
    mintSessionServing: ({ identity, endpoint, sessionId, epoch, exp }) => mintCreds(auth, identity, "session-serving", {
      sessionServing: { endpoint, sessionId, epoch }, expiresAt: exp,
    }),
    mintRetirementRequester: unused, validateRetainedAgent: unused, prepareAgentRetirement: unused,
    scanGoalIndex: async () => [], authorizeAdmin: async () => false,
  } });
  await manager.start();
  record("manager-started");
  // Arm only after startup. The shipped renewal timer must enter the remote callback itself.
  armed = true;
  const row = await Promise.race([staged.promise, wait(20_000).then(() => { throw new Error("SETUP: Manager renewal timer did not reach stage"); })]);
  if (process.argv.includes("--delayed-second-mint")) {
    // Keep the first staged issuance pending across a JWT timestamp boundary, then
    // finish another ordinary mint before allowing the first to attempt its CAS.
    await wait(1200);
    await signServe();
    record("second-ordinary-mint-completed-while-first-paused", { firstCredentialId: row.credentialId });
  }
  const observed = await gate.observe(); assert.ok(observed);
  const siblingCreds = await initialSign("goalWriter");
  const sibling = { ...row, credentialId: credentialIdOf(jwtFromCreds(siblingCreds)!), credentialKey: held.goalWriter.id,
    holderPrincipal: `${owner}.${actors.goalWriter}`, exp: credsClaims(siblingCreds).exp! };
  await commitSiblingIssuance(gate, observed, sibling);
  const touched = await gate.observe(); assert.ok(touched);
  assert.notEqual(touched.revision, observed.revision);
  assert.deepEqual({ ...observed, revision: 0 }, { ...touched, revision: 0 });
  record("sibling-committed", { before: observed.revision, after: touched.revision });
  release.resolve();
  const result = await Promise.race([renewalResult.promise, wait(5000).then(() => { throw new Error("Manager renewal did not finish after contention"); })]);
  assert.equal(result.ok, true, `ordinary mint must survive benign contention: ${result.error}`);
  const installed = manager as unknown as { serviceServe?: { creds?: string } };
  const adoptionDeadline = Date.now() + 5000;
  while (installed.serviceServe?.creds !== renewedServe && Date.now() < adoptionDeadline) await wait(20);
  assert.ok(renewedServe);
  assert.equal(installed.serviceServe?.creds, renewedServe, "Manager must adopt the renewed serving credential");
  record("contention-renewal-adopted");
  // Independent real mint retries with the same held identity and grant, spanning >1 second.
  for (const delay of [0, 1200, 1200]) {
    await wait(delay);
    try { await signServe(); record("retry-recovered", { delay }); }
    catch (error) {
      record("retry-failed", { delay, error: String(error) });
      throw new Error(`post-contention retry did not recover: ${String(error)}`);
    }
  }
  record("complete", { attempts });
} finally {
  release.resolve();
  try {
    await Promise.race([
      manager?.stop({ withAgents: true }),
      wait(8000).then(() => { throw new Error("Manager cleanup exceeded 8000ms"); }),
    ]);
  } finally {
    for (const nc of clients) await nc.close();
    await killAndAwaitExit(broker);
    releaseBroker();
  }
}
