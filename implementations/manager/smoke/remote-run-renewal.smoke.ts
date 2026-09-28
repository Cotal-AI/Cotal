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
  createSpaceAuth, credsClaims, inspectCredHealth, isReachable, jwtFromCreds, mintCreds, mintLifecycleUid, newIdentity,
  remoteManagerActors, serverConfig, type RemoteManagerAuthorityMaterial, type RemoteManagerAuthorityRequest,
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

  const holderId = `${owner}.mgr`;
  const runId = `run-${"d".repeat(32)}`;
  const takeoverId = "c".repeat(16);
  const driver = newIdentity();
  const mediator = newIdentity();
  // The journal's activated attempt, as the issuer's authoritative reader would see it.
  let journal = { state: "running", holder: `${holderId}.${takeoverId}`, takeoverId, epoch: 2, fencingToken: 5, instanceId };
  let signed = 0;
  // When set, the issuer signs a pair that has already expired by the time it returns.
  let issueExpired = false;

  const hosting = new RunHosting({
    space, servers: SERVERS, endpoint: "manager", instanceId,
    holder: { id: holderId, lifecycleUid: mintLifecycleUid() }, auth: undefined, log: () => undefined,
    renewRun: async (a) => {
      const request = {
        ...base, requestId: `renewRunDriver${mintLifecycleUid()}`, registrationProof,
        run: { runId: a.runId, holder: a.holder, takeoverId: a.takeoverId, epoch: a.epoch, fencingToken: a.fencingToken, driverId: a.driver.id, mediatorId: a.mediator.id },
      } as RemoteManagerAuthorityRequest;
      const material = await issueRemoteManagerAuthority({
        request, owner, scope: ["supervise"],
        authorizeRenewal: ({ owner: o, request: r }) => authorizeRemoteManagerRenewal({
          request: r, owner: o, space, accountPublicKey: auth.account.pub, proofSecret: "proof-secret",
          observeManagerGate: async () => gate, observeRun: async () => journal,
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
          return { credentials };
        },
      });
      return remoteRunRenewalCredentials(material, request, owner, a.driver, a.mediator);
    },
  });

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

  journal = { ...journal, fencingToken: 6 };
  await hosting.renew();
  await cell("a superseded fencing token keeps last-good, records debt and never signs", () => {
    assert.equal(signed, 0);
    assert.equal(slot.creds, expiring.driver);
    assert.equal(slot.mediatorCreds, expiring.mediator);
    assert.match(String((slot.renewalDebt as { reason?: string } | undefined)?.reason), /activated run/);
  });

  journal = { ...journal, fencingToken: 5 };
  issueExpired = true;
  await hosting.renew();
  issueExpired = false;
  await cell("an issued pair that is already expired is not adopted: last-good and debt kept", () => {
    assert.equal(signed, 1);
    assert.equal(slot.creds, expiring.driver);
    assert.equal(slot.mediatorCreds, expiring.mediator);
    assert.match(String((slot.renewalDebt as { reason?: string } | undefined)?.reason), /unusable run-driver/);
  });

  await hosting.renew();
  await cell("the activated attempt adopts a host-issued pair for the same nkeys and clears debt", async () => {
    assert.equal(signed, 2);
    assert.notEqual(slot.creds, expiring.driver);
    assert.equal(credsClaims(slot.creds as string).sub, driver.id);
    assert.equal(credsClaims(slot.mediatorCreds as string).sub, mediator.id);
    assert.equal(slot.renewalDebt, undefined);
    assert.equal(await brokerAccepts(slot.creds as string), true);
    assert.equal(await brokerAccepts(slot.mediatorCreds as string), true);
  });

  await hosting.renew();
  await cell("a healthy pair does not re-issue", () => assert.equal(signed, 2));
} finally {
  releaseBroker();
  await killAndAwaitExit(srv);
}

console.log(`\nremote-run-renewal: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
