/**
 * Closed signerless standing renewal against a real broker. The host issuer authorizes the
 * current registration gate, signs the five-identity family under the assigned account, and
 * the manager-side validator accepts only the exact echo before each JWT connects. Stale epoch,
 * foreign owner, superseded run fence and foreign-account material are refused, and the
 * foreign-account credential is also refused by the broker itself.
 *
 * Run: tsx implementations/manager/smoke/remote-renewal-broker.smoke.ts (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createSpaceAuth, credsClaims, credsFromJwt, isReachable, jwtFromCreds, mintCreds, mintLifecycleUid, newIdentity, remoteManagerActors, serverConfig,
  type HostedRunAttempt, type RemoteManagerAuthorityMaterial, type RemoteManagerAuthorityRequest, type SpaceAuth,
} from "@cotal-ai/core";
import { authorizeRemoteManagerRenewal, issueRemoteManagerAuthority } from "../../auth/src/manager-authority.js";
import { remoteManagerCurrentRegistrationProof } from "../../auth/src/retained-manager-validation.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { remoteManagerRenewalCredentials, remoteRunRenewalCredentials } from "../src/remote-authority.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => Promise<void> | void) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}
async function rejects(name: string, fn: () => Promise<unknown> | unknown, re: RegExp) {
  await cell(name, async () => {
    let error: unknown;
    try { await fn(); } catch (e) { error = e; }
    assert.ok(error instanceof Error, "expected a refusal");
    assert.match(error.message, re);
  });
}

const space = `renew${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
const foreign = await createSpaceAuth(space);
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

async function brokerAccepts(creds: string): Promise<boolean> {
  try {
    const nc = await connect({ servers: SERVERS, reconnect: false, timeout: 3000, authenticator: credsAuthenticator(new TextEncoder().encode(creds)) });
    await nc.flush();
    await nc.close();
    return true;
  } catch { return false; }
}

try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });
  const owner = `u_${"a".repeat(26)}`;
  const instanceId = mintLifecycleUid();
  const actors = remoteManagerActors(instanceId);
  const held = { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() };
  const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
  const gate = { state: "open" as const, principal: `${owner}.${actors.serve}`, processEpoch: 3, registrationRevision: 9 };
  const base = {
    v: 1 as const, kind: "manager-service-authority" as const, operation: "renewStandingBundle" as const,
    space, actor: "cli", instanceId, managerLifecycleUid: mintLifecycleUid(), requestId: `req${mintLifecycleUid()}`,
    accountPublicKey: auth.account.pub, processEpoch: 3,
    identities: Object.fromEntries(names.map((n) => [n, { id: held[n].id }])) as RemoteManagerAuthorityRequest["identities"],
  };
  const request = { ...base, registrationProof: remoteManagerCurrentRegistrationProof("proof-secret", owner, base, gate) } as RemoteManagerAuthorityRequest;

  /** The server-side signer. The profile and grants are chosen here from the name, never from input. */
  const sign = async (signer: SpaceAuth, name: (typeof names)[number], id = held[name]) => {
    const actor = name === "serve" ? actors.supervisor : actors[name];
    const creds = await mintCreds(signer, id, name === "goalWriter" ? "goal-writer" : name === "sessionLedger" ? "session-ledger" : "remote-manager", {
      principal: { owner, actor },
      ...(name === "goalWriter" ? { goalWriter: { endpoint: "manager" } } : {}),
      ...(name === "supervisor" || name === "executor" || name === "serve" ? { remoteManager: { instanceId, owner, actor } } : {}),
    });
    return { jwt: jwtFromCreds(creds)!, exp: credsClaims(creds).exp! };
  };
  let issued = 0;
  const issueWith = (signer: SpaceAuth, observed: { gate?: typeof gate; owner?: string } = {}, req: RemoteManagerAuthorityRequest = request) =>
    issueRemoteManagerAuthority({
      request: req, owner: observed.owner ?? owner, scope: ["supervise"],
      authorizeRenewal: ({ owner: o, request: r }) => authorizeRemoteManagerRenewal({
        request: r, owner: o, space, accountPublicKey: auth.account.pub, proofSecret: "proof-secret",
        observeManagerGate: async () => observed.gate ?? gate,
        observeRun: async () => null,
      }),
      issue: async () => {
        issued++;
        const credentials = {} as NonNullable<RemoteManagerAuthorityMaterial["credentials"]>;
        for (const n of names) credentials[n] = await sign(signer, n);
        return { credentials };
      },
    });

  await cell("current gate issues a five-identity family that validates and connects on the broker", async () => {
    const material = await issueWith(auth);
    const family = remoteManagerRenewalCredentials(material, request, owner, held);
    assert.deepEqual(Object.keys(family), [...names]);
    for (const n of names) assert.equal(await brokerAccepts(family[n]), true, `${n} must connect`);
  });
  const before = issued;
  await rejects("stale process epoch refuses before any signing", () => issueWith(auth, { gate: { ...gate, processEpoch: 4 } }), /processEpoch is stale/);
  await rejects("foreign owner refuses before any signing", () => issueWith(auth, { owner: `u_${"b".repeat(26)}` }), /another owner|proof/);
  await rejects("frozen registration gate refuses before any signing", () => issueWith(auth, { gate: { ...gate, state: "frozen" as never } }), /open registration gate/);
  await rejects("foreign assigned account refuses before any signing",
    () => issueWith(auth, {}, { ...request, accountPublicKey: foreign.account.pub }), /host-assigned space and account/);
  await cell("no refused request reached the signer", () => assert.equal(issued, before));

  await cell("foreign-account material is refused by the validator and by the broker", async () => {
    const material = await issueWith(foreign);
    assert.throws(() => remoteManagerRenewalCredentials(material, request, owner, held), /foreign account/);
    const serve = await sign(foreign, "serve");
    assert.equal(await brokerAccepts(credsFromJwt(serve.jwt, held.serve)), false);
  });
  await cell("a JWT for a different nkey never adopts under the caller-held seed", async () => {
    const material = await issueWith(auth);
    const other = newIdentity();
    const wrong = { ...material, credentials: { ...material.credentials, executor: await sign(auth, "executor", other) } };
    assert.throws(() => remoteManagerRenewalCredentials(wrong, request, owner, held), /requested identity/);
  });

  const driver = newIdentity();
  const mediator = newIdentity();
  const run = { runId: `run-${"d".repeat(32)}`, holder: `holder.${"c".repeat(16)}`, takeoverId: "c".repeat(16), epoch: 2, fencingToken: 5, driverId: driver.id, mediatorId: mediator.id };
  const runRequest = { ...request, operation: "renewRunDriver" as const, run } as RemoteManagerAuthorityRequest;
  const runIssue = (observed: HostedRunAttempt | null) => issueRemoteManagerAuthority({
    request: runRequest, owner, scope: ["supervise"],
    authorizeRenewal: ({ owner: o, request: r }) => authorizeRemoteManagerRenewal({
      request: r, owner: o, space, accountPublicKey: auth.account.pub, proofSecret: "proof-secret",
      observeManagerGate: async () => gate, observeRun: async () => observed,
    }),
    issue: async () => {
      issued++;
      const credentials = {} as NonNullable<RemoteManagerAuthorityMaterial["credentials"]>;
      for (const [name, id] of [["runDriver", driver], ["runMediator", mediator]] as const) {
        const binding = { endpoint: "manager", runId: run.runId, takeoverId: run.takeoverId, instanceId, epoch: run.epoch, owner };
        const creds = await mintCreds(auth, id, name === "runDriver" ? "run-driver" : "run-mediator", {
          principal: { owner, actor: "wf_renew" }, ...(name === "runDriver" ? { runDriver: binding } : { runMediator: binding }),
        });
        credentials[name] = { jwt: jwtFromCreds(creds)!, exp: credsClaims(creds).exp! };
      }
      return { credentials };
    },
  });
  const active = { ...run, state: "running" as const, instanceId };
  await cell("activated run holder renews its driver and mediator pair on the broker", async () => {
    const pair = remoteRunRenewalCredentials(await runIssue(active), runRequest, owner, driver, mediator);
    assert.equal(await brokerAccepts(pair.driver), true);
    assert.equal(await brokerAccepts(pair.mediator), true);
  });
  const runBefore = issued;
  await rejects("superseded holder refuses before signing", () => runIssue({ ...active, holder: `next.${"e".repeat(16)}`, takeoverId: "e".repeat(16) }), /activated run/);
  await rejects("another holder on the same takeover refuses before signing", () => runIssue({ ...active, holder: `other.${"c".repeat(16)}` }), /activated run/);
  await rejects("advanced fencing token refuses before signing", () => runIssue({ ...active, fencingToken: 6 }), /activated run/);
  await rejects("run owned by another manager instance refuses before signing", () => runIssue({ ...active, instanceId: mintLifecycleUid() }), /activated run/);
  await rejects("terminal run refuses before signing", () => runIssue({ ...active, state: "completed" }), /activated run/);
  await cell("no refused run renewal reached the signer", () => assert.equal(issued, runBefore));
} finally {
  releaseBroker();
  await killAndAwaitExit(srv);
}

console.log(`\nremote-renewal-broker: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
