/**
 * Signerless hosted-run renewal through `RunHosting.renew()` against a real broker. The host
 * holds no space signer. An expired driver/mediator pair re-issues only through the closed
 * `renewRunDriver` chain: the issuer authorizes the current gate and the activated run's holder,
 * takeover, epoch and fencing token, and the manager validates the echo before adopting both.
 * A superseded fence keeps last-good, records debt and never reaches the signer. An issued pair
 * that is already unusable is not adopted.
 *
 * Limit: the hosted slot is installed by hand. This proves the renewal path, not a parked
 * workflow timer or accepted goal surviving expiry.
 *
 * Run: tsx implementations/manager/smoke/remote-run-renewal.smoke.ts (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createRunSpec, createSpaceAuth, credsClaims, inspectCredHealth, isReachable, jwtFromCreds, mintCreds, mintLifecycleUid, newIdentity,
  observeHostedRunAttempt, openRecordsBucket, remoteManagerActors, serverConfig, setupSpaceStreams, standaloneConnectOpts, writeRunStatus, type RemoteManagerAuthorityMaterial, type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { authorizeRemoteManagerRenewal, issueRemoteManagerAuthority } from "../../auth/src/manager-authority.js";
import { remoteManagerCurrentRegistrationProof } from "../../auth/src/retained-manager-validation.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { remoteRunRenewalCredentials } from "../src/remote-authority.js";
import { RunHosting } from "../src/run-hosting.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => Promise<void> | void) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}

const space = `rrun${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
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
  const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
  const held = Object.fromEntries(names.map((n) => [n, newIdentity()])) as Record<(typeof names)[number], ReturnType<typeof newIdentity>>;
  const gate = { state: "open" as const, principal: `${owner}.${actors.serve}`, processEpoch: 3, registrationRevision: 9 };
  const base = {
    v: 1 as const, kind: "manager-service-authority" as const, operation: "renewRunDriver" as const,
    space, actor: "cli", instanceId, managerLifecycleUid: mintLifecycleUid(), accountPublicKey: auth.account.pub, processEpoch: 3,
    identities: Object.fromEntries(names.map((n) => [n, { id: held[n].id }])) as RemoteManagerAuthorityRequest["identities"],
  };
  const registrationProof = remoteManagerCurrentRegistrationProof("proof-secret", owner, { ...base, requestId: "x" } as RemoteManagerAuthorityRequest, gate);

  // The registered supervisor nkey: the hosting manager's endpoint id and the holder prefix.
  const holderId = held.supervisor.id;
  const runId = `run-${"d".repeat(32)}`;
  const takeoverId = "c".repeat(16);
  const driver = newIdentity();
  const mediator = newIdentity();
  // The run's authoritative status record on the real records bucket; the issuer reads it back
  // through the core observation, bound to the REGISTERED supervisor id and instance only.
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisioner });
  // The status is written as the run's own driver, the principal the hosted drive writes it as.
  const writerCreds = await mintCreds(auth, newIdentity(), "run-driver", {
    principal: { owner, actor: "wf_renew" }, runDriver: { endpoint: "manager", runId, takeoverId, instanceId, epoch: 2, owner },
  });
  const pnc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: writerCreds, tls: false }) });
  const kv = await openRecordsBucket(pnc, space);
  // The issuer's reader: a separate trusted connection, as the host's own authority plane reads.
  const rnc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: provisioner, tls: false }) });
  const readKv = await openRecordsBucket(rnc, space);
  await createRunSpec(kv, "manager", runId, {
    pins: { seed: "s", startedAt: Date.now(), yieldEvery: 1, stepBudget: 1, effectCeiling: 1, languageVersion: "1" }, createdAt: Date.now(),
  });
  let statusRevision = await writeRunStatus(kv, "manager", runId,
    { observedSpecRevision: 1, state: "running", holder: `${holderId}.${takeoverId}`, epoch: 2, fencingToken: 5, journalHigh: 1, at: Date.now() });
  const setStatus = async (patch: { holder?: string; fencingToken?: number }) => {
    statusRevision = await writeRunStatus(kv, "manager", runId, {
      observedSpecRevision: 1, state: "running", holder: patch.holder ?? `${holderId}.${takeoverId}`, epoch: 2,
      fencingToken: patch.fencingToken ?? 5, journalHigh: 1, at: Date.now(),
    }, statusRevision);
  };
  const registered = { supervisorId: held.supervisor.id, instanceId };
  let signed = 0;
  // When set, the issuer signs a pair that has already expired by the time it returns.
  let issueExpired = false;
  let holdIssue: { entered: () => void; release: Promise<void> } | undefined;

  const renewRun: ConstructorParameters<typeof RunHosting>[0]["renewRun"] = async (a) => {
      const request = {
        ...base, requestId: `renewRunDriver${mintLifecycleUid()}`, registrationProof,
        run: { runId: a.runId, holder: a.holder, takeoverId: a.takeoverId, epoch: a.epoch, fencingToken: a.fencingToken, driverId: a.driver.id, mediatorId: a.mediator.id },
      } as RemoteManagerAuthorityRequest;
      const material = await issueRemoteManagerAuthority({
        request, owner, scope: ["supervise"],
        authorizeRenewal: ({ owner: o, request: r }) => authorizeRemoteManagerRenewal({
          request: r, owner: o, space, accountPublicKey: auth.account.pub, proofSecret: "proof-secret",
          observeManagerGate: async () => gate, observeRun: (id) => observeHostedRunAttempt(readKv, "manager", id, registered),
        }),
        issue: async () => {
          signed++;
          const credentials = {} as NonNullable<RemoteManagerAuthorityMaterial["credentials"]>;
          for (const [name, id] of [["runDriver", driver], ["runMediator", mediator]] as const) {
            const binding = { endpoint: "manager", runId, takeoverId, instanceId, epoch: 2, owner };
            const creds = await mintCreds(auth, id, name === "runDriver" ? "run-driver" : "run-mediator", {
              principal: { owner, actor: "wf_renew" }, ...(name === "runDriver" ? { runDriver: binding } : { runMediator: binding }),
              ...(issueExpired ? { expiresInSeconds: 1 } : {}),
            });
            credentials[name] = { jwt: jwtFromCreds(creds)!, exp: credsClaims(creds).exp! };
          }
          if (issueExpired) await new Promise((r) => setTimeout(r, 2100));
          const hold = holdIssue;
          if (hold) { hold.entered(); await hold.release; }
          return { credentials };
        },
      });
      return remoteRunRenewalCredentials(material, request, owner, a.driver, a.mediator);
  };
  const unusedHostCall = async (): Promise<never> => { throw new Error("not exercised by the renewal suite"); };
  const hostAs = (id: string) => new RunHosting({
    space, servers: SERVERS, endpoint: "manager", instanceId,
    holder: { id, lifecycleUid: mintLifecycleUid() }, auth: undefined, log: () => undefined, renewRun,
    // The signerless set is all-or-nothing; this suite exercises renewal only, so the rest refuse.
    admitRun: unusedHostCall, issueAttempt: unusedHostCall, issueOperator: unusedHostCall,
  });
  const hosting = hostAs(holderId);

  // An activated attempt whose pair has already expired: last-good the broker now refuses.
  const binding = { endpoint: "manager", runId, takeoverId, instanceId, epoch: 2, owner };
  const expiring = {
    driver: await mintCreds(auth, driver, "run-driver", { principal: { owner, actor: "wf_renew" }, runDriver: binding, expiresInSeconds: 1 }),
    mediator: await mintCreds(auth, mediator, "run-mediator", { principal: { owner, actor: "wf_renew" }, runMediator: binding, expiresInSeconds: 1 }),
  };
  const slot = { runId, takeoverId, epoch: 2, fencingToken: 5, identity: driver, mediatorIdentity: mediator, placements: [], creds: expiring.driver, mediatorCreds: expiring.mediator } as Record<string, unknown>;
  (hosting as unknown as { runs: Map<string, unknown> }).runs.set(runId, slot);
  await new Promise((r) => setTimeout(r, 2100));

  await cell("the expired pair is refused by the broker before renewal", async () => {
    assert.equal(inspectCredHealth(expiring.driver).state, "expired");
    assert.equal(await brokerAccepts(expiring.driver), false);
  });

  await setStatus({ fencingToken: 6 });
  await hosting.renew();
  await cell("a superseded fencing token keeps last-good, records debt and never signs", () => {
    assert.equal(signed, 0);
    assert.equal(slot.creds, expiring.driver);
    assert.equal(slot.mediatorCreds, expiring.mediator);
    assert.match(String((slot.renewalDebt as { reason?: string } | undefined)?.reason), /activated run/);
  });

  // Same takeover suffix and fence, but under a holder prefix that is not the registered
  // supervisor: the observation binds no instance, so the gate refuses before signing.
  await setStatus({ holder: `${newIdentity().id}.${takeoverId}` });
  await hosting.renew();
  await cell("a holder under an unregistered supervisor prefix binds no instance and never signs", () => {
    assert.equal(signed, 0);
    assert.equal(slot.creds, expiring.driver);
    assert.match(String((slot.renewalDebt as { reason?: string } | undefined)?.reason), /activated run/);
  });

  // The registered caller names another manager's holder in its own request: holder, takeover
  // and fence all match the record, and only the registered-prefix binding refuses.
  const foreignId = newIdentity().id;
  await setStatus({ holder: `${foreignId}.${takeoverId}` });
  const claimant = hostAs(foreignId);
  const claimed = { ...slot };
  (claimant as unknown as { runs: Map<string, unknown> }).runs.set(runId, claimed);
  await claimant.renew();
  await cell("a registered caller claiming another manager's holder binds no instance and never signs", () => {
    assert.equal(signed, 0);
    assert.equal(claimed.creds, expiring.driver);
    assert.match(String((claimed.renewalDebt as { reason?: string } | undefined)?.reason), /activated run/);
  });

  await setStatus({});
  issueExpired = true;
  await hosting.renew();
  issueExpired = false;
  await cell("an issued pair that is already expired is not adopted: last-good and debt kept", () => {
    assert.equal(signed, 1);
    assert.equal(slot.creds, expiring.driver);
    assert.equal(slot.mediatorCreds, expiring.mediator);
    assert.match(String((slot.renewalDebt as { reason?: string } | undefined)?.reason), /unusable run-driver/);
  });

  await cell("overlapping renewal calls share one host issuance and adoption", async () => {
    let entered!: () => void, release!: () => void;
    const accepted = new Promise<void>((resolve) => { entered = resolve; });
    holdIssue = { entered, release: new Promise<void>((resolve) => { release = resolve; }) };
    const first = hosting.renew();
    await accepted;
    const second = hosting.renew();
    let issuedWhileHeld: number;
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      issuedWhileHeld = signed;
    } finally {
      holdIssue = undefined;
      release();
      await Promise.all([first, second]);
    }
    console.log(`    host issuances while first renewal held: ${issuedWhileHeld} (one prior expired candidate)`);
    assert.equal(issuedWhileHeld, 2, "an overlapping renewal must join the accepted issuance");
    assert.equal(signed, 2, "an overlapping renewal must not issue after the first finishes");
  });
  await cell("the activated attempt adopts a host-issued pair for the same nkeys and clears debt", async () => {
    assert.equal(signed, 2);
    assert.notEqual(slot.creds, expiring.driver);
    assert.equal(credsClaims(slot.creds as string).sub, driver.id);
    assert.equal(credsClaims(slot.mediatorCreds as string).sub, mediator.id);
    assert.equal(slot.renewalDebt, undefined);
    assert.equal(await brokerAccepts(slot.creds as string), true);
    assert.equal(await brokerAccepts(slot.mediatorCreds as string), true);
  });

  await cell("overlapping refused renewals share one host call and release the flight", async () => {
    let entered!: () => void, release!: () => void;
    const accepted = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const failing = new RunHosting({
      space, servers: SERVERS, endpoint: "manager", instanceId,
      holder: { id: holderId, lifecycleUid: mintLifecycleUid() }, auth: undefined, log: () => undefined,
      renewRun: async () => { calls++; entered(); await released; throw new Error("issuer unavailable"); },
      admitRun: unusedHostCall, issueAttempt: unusedHostCall, issueOperator: unusedHostCall,
    });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const refusedSlot: Record<string, unknown> = { ...slot, creds: expiring.driver, mediatorCreds: expiring.mediator };
    (failing as unknown as { runs: Map<string, unknown> }).runs.set(runId, refusedSlot);
    const first = failing.renew();
    await accepted;
    const second = failing.renew();
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(refusedSlot.creds, expiring.driver);
    assert.equal(refusedSlot.mediatorCreds, expiring.mediator);
    assert.match(String((refusedSlot.renewalDebt as { reason?: string } | undefined)?.reason), /issuer unavailable/);
    await failing.renew();
    assert.equal(calls, 2, "a settled refusal must permit the next renewal");
    await failing.stop();
    await failing.renew();
    assert.equal(calls, 2, "a stopped host must not issue another renewal");
  });

  await hosting.renew();
  await cell("a healthy pair does not re-issue", () => assert.equal(signed, 2));

  await cell("renewal stays single-flight through both native reconnects", async () => {
    const nc = await connect({ servers: SERVERS, reconnectTimeWait: 10, ...standaloneConnectOpts({ creds: slot.creds as string, tls: false }) });
    const mediatorNc = await connect({ servers: SERVERS, reconnectTimeWait: 10, ...standaloneConnectOpts({ creds: slot.mediatorCreds as string, tls: false }) });
    let entered!: () => void, release!: () => void;
    const accepted = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reconnects = 0;
    for (const connection of [nc, mediatorNc]) {
      const reconnect = connection.reconnect.bind(connection);
      connection.reconnect = async () => { reconnects++; entered(); await released; await reconnect(); };
    }
    slot.nc = nc; slot.mediatorNc = mediatorNc;
    slot.creds = expiring.driver; slot.mediatorCreds = expiring.mediator;
    const before = signed;
    const first = hosting.renew();
    await accepted;
    const second = hosting.renew();
    let joined = false;
    void second.then(() => { joined = true; });
    let settledBeforeRelease: boolean;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settledBeforeRelease = joined;
    } finally {
      release();
      await Promise.all([first, second]);
      await nc.close(); await mediatorNc.close();
      delete slot.nc; delete slot.mediatorNc;
    }
    assert.equal(settledBeforeRelease, false, "joined callers must wait for native reconnects");
    assert.equal(signed, before + 1);
    assert.equal(reconnects, 2, "each held transport reconnects once");
  });

  await cell("stop fences an accepted renewal before adoption and prevents later issuance", async () => {
    slot.creds = expiring.driver; slot.mediatorCreds = expiring.mediator;
    let entered!: () => void, release!: () => void;
    const accepted = new Promise<void>((resolve) => { entered = resolve; });
    holdIssue = { entered, release: new Promise<void>((resolve) => { release = resolve; }) };
    const before = signed;
    const renewing = hosting.renew();
    await accepted;
    try { await hosting.stop(); } finally { holdIssue = undefined; release(); await renewing; }
    assert.equal(slot.creds, expiring.driver);
    assert.equal(slot.mediatorCreds, expiring.mediator);
    assert.match(String((slot.renewalDebt as { reason?: string } | undefined)?.reason), /left this host/);
    await hosting.renew();
    assert.equal(signed, before + 1);
  });
  await pnc.close();
  await rnc.close();
} finally {
  releaseBroker();
  await killAndAwaitExit(srv);
}

console.log(`\nremote-run-renewal: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
