/**
 * Standing manager renewal through the auth plane's real issuer (a live nats-server, a real
 * registered manager instance): the plane re-derives the serve grant from the registered service
 * spec and content store, binds the held nkeys and process epoch, and keeps run renewal unavailable.
 *
 * Run: tsx implementations/auth/smoke/manager-standing-renewal.smoke.ts (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { connect } from "@nats-io/transport-node";
import {
  createRunSpec, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, openRecordsBucket, remoteManagerActors, serverConfig, setupSpaceStreams, standaloneConnectOpts, writeRunStatus,
  type Identity, type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openAuthAuthorityPlane } from "../src/index.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
import { registerRemoteManagerAuthority } from "../../manager/src/remote-register.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "issued"; } catch (e) { return `${(e as { code?: string }).code ?? "?"}: ${(e as Error).message}`; }
};

const space = `srenew${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
type Name = (typeof names)[number];
const owner = `u_${"e".repeat(26)}`;
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const held = Object.fromEntries(names.map((n) => [n, newIdentity()])) as Record<Name, Identity>;
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: () => {} });
  const prepareCreds = await mintCreds(auth, held.executor, "remote-manager", {
    principal: { owner, actor: actors.executor }, remoteManager: { instanceId, owner, actor: actors.executor },
  });
  const registered = await registerRemoteManagerAuthority({
    space, server: SERVERS, owner, instanceId, serveActor: actors.serve, prepareCreds, tlsRequired: false, evict: async (principals) => principals.map(() => true),
  });
  const request = (over: Partial<RemoteManagerAuthorityRequest> = {}, proofEpoch = registered.processEpoch): RemoteManagerAuthorityRequest => {
    const base = {
      v: 1 as const, kind: "manager-service-authority" as const, operation: "renewStandingBundle" as const,
      space, actor: "cli", instanceId, managerLifecycleUid, requestId: `req${mintLifecycleUid()}`,
      accountPublicKey: dataAccount.pub, processEpoch: registered.processEpoch,
      identities: Object.fromEntries(names.map((n) => [n, { id: held[n].id }])) as RemoteManagerAuthorityRequest["identities"],
      ...over,
    };
    return {
      ...base,
      registrationProof: remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, owner, base, {
        registrationRevision: registered.registrationRevision, processEpoch: proofEpoch,
      }),
    } as RemoteManagerAuthorityRequest;
  };

  console.log("standing renewal through the plane issuer");
  const material = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request() });
  const issued = Object.keys(material.credentials).sort();
  check("standing renewal issues exactly the five standing duties", issued.join(",") === [...names].sort().join(","), issued);
  for (const n of names) {
    const claims = decodeJwt(material.credentials[n]!.jwt) as { sub?: string; nats?: { issuer_account?: string } };
    check(`${n} is signed for the held nkey under the data account`, claims.sub === held[n].id && claims.nats?.issuer_account === dataAccount.pub,
      { sub: claims.sub, account: claims.nats?.issuer_account });
  }
  const serve = decodeJwt(material.credentials.serve!.jwt) as { nats?: { sub?: { allow?: string[] } } };
  const serveSubs = serve.nats?.sub?.allow ?? [];
  const registeredCommands = registered.serveGrant.commands;
  const missing = registeredCommands.filter((c) => !serveSubs.includes(`cotal.${space}.ep.inst.manager.${instanceId}.${c}.>`));
  check("renewed serve grant covers every registered command on this instance's rails",
    registeredCommands.length > 0 && missing.length === 0, { commands: registeredCommands.length, missing });
  const foreignInst = serveSubs.filter((s) => /\.ep\.(v1\.)?inst\./.test(s) && !s.includes(`.inst.manager.${instanceId}.`));
  check("renewed serve grant names no other instance", foreignInst.length === 0, foreignInst.slice(0, 3));

  console.log("refusals");
  check("a stale processEpoch refuses",
    /conflict/.test(await refusal(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request({ processEpoch: registered.processEpoch + 1 }, registered.processEpoch + 1) }))));
  check("another account refuses",
    /permission-denied/.test(await refusal(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request({ accountPublicKey: createSpaceAuthPub() }) }))));
  check("a foreign owner refuses",
    /permission-denied/.test(await refusal(plane.issueManagerServiceAuthority({ owner: `u_${"f".repeat(26)}`, scope: ["supervise"], request: request() }))));
  const swapped = { ...Object.fromEntries(names.map((n) => [n, { id: held[n].id }])), serve: { id: newIdentity().id } } as RemoteManagerAuthorityRequest["identities"];
  const tampered = { ...request(), identities: swapped } as RemoteManagerAuthorityRequest;
  check("an unregistered nkey refuses (the proof binds the held identities)",
    /permission-denied/.test(await refusal(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: tampered }))));

  // Establish an activated run in the records bucket using a run-driver credential
  // (labeled fixture setup: stock records setup path).
  const runId = `run-${"d".repeat(32)}`;
  const takeoverId = "c".repeat(16);
  const driver = newIdentity();
  const mediator = newIdentity();
  const holderId = held.supervisor.id;
  const writerCreds = await mintCreds(auth, newIdentity(), "run-driver", {
    principal: { owner, actor: "wf_fixture" },
    runDriver: { endpoint: "manager", runId, takeoverId, instanceId, epoch: 2, owner },
  });
  const provNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: writerCreds, tls: false }) });
  let statusRevision: number;
  let recordsKv: Awaited<ReturnType<typeof openRecordsBucket>>;
  try {
    recordsKv = await openRecordsBucket(provNc, space);
    await createRunSpec(recordsKv, "manager", runId, {
      pins: { seed: "s", startedAt: Date.now(), yieldEvery: 1, stepBudget: 1, effectCeiling: 1, languageVersion: "1" },
      createdAt: Date.now(),
    });
    statusRevision = await writeRunStatus(recordsKv, "manager", runId, {
      observedSpecRevision: 1, state: "running", holder: `${holderId}.${takeoverId}`, epoch: 2, fencingToken: 5, journalHigh: 1, at: Date.now(),
    });

    const makeRunRequest = (
      runOver: Partial<NonNullable<RemoteManagerAuthorityRequest["run"]>> = {},
      reqOver: Partial<RemoteManagerAuthorityRequest> = {},
      proofEpoch = registered.processEpoch,
    ): RemoteManagerAuthorityRequest => {
      const baseRun = {
        runId,
        holder: `${holderId}.${takeoverId}`,
        takeoverId,
        epoch: 2,
        fencingToken: 5,
        driverId: driver.id,
        mediatorId: mediator.id,
        ...runOver,
      };
      const base = {
        v: 1 as const, kind: "manager-service-authority" as const, operation: "renewRunDriver" as const,
        space, actor: "cli", instanceId, managerLifecycleUid, requestId: `req${mintLifecycleUid()}`,
        accountPublicKey: dataAccount.pub, processEpoch: registered.processEpoch,
        identities: Object.fromEntries(names.map((n) => [n, { id: held[n].id }])) as RemoteManagerAuthorityRequest["identities"],
        run: baseRun,
        ...reqOver,
      };
      return {
        ...base,
        registrationProof: remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, owner, base as RemoteManagerAuthorityRequest, {
          registrationRevision: registered.registrationRevision, processEpoch: proofEpoch,
        }),
      } as RemoteManagerAuthorityRequest;
    };

    console.log("run renewal through the plane issuer");
    // 1. Exact-key positive renewal driving the actual service route on a real recorded activated run
    const runMaterial = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: makeRunRequest() });
    const runIssued = Object.keys(runMaterial.credentials).sort();
    check("run renewal issues exactly runDriver and runMediator", runIssued.join(",") === "runDriver,runMediator", runIssued);
    const driverClaims = decodeJwt(runMaterial.credentials.runDriver!.jwt) as { sub?: string; nats?: { issuer_account?: string } };
    const mediatorClaims = decodeJwt(runMaterial.credentials.runMediator!.jwt) as { sub?: string; nats?: { issuer_account?: string } };
    check("runDriver is signed for the requested driver nkey under data account",
      driverClaims.sub === driver.id && driverClaims.nats?.issuer_account === dataAccount.pub);
    check("runMediator is signed for the requested mediator nkey under data account",
      mediatorClaims.sub === mediator.id && mediatorClaims.nats?.issuer_account === dataAccount.pub);

    // 2. Stale/foreign holder refusal
    check("a foreign supervisor holder prefix refuses",
      /conflict/.test(await refusal(plane.issueManagerServiceAuthority({
        owner, scope: ["supervise"],
        request: makeRunRequest({ holder: `${newIdentity().id}.${takeoverId}` }),
      }))));
    check("a stale takeoverId in holder refuses",
      /conflict/.test(await refusal(plane.issueManagerServiceAuthority({
        owner, scope: ["supervise"],
        request: makeRunRequest({ takeoverId: "f".repeat(16), holder: `${holderId}.${"f".repeat(16)}` }),
      }))));

    // 3. Wrong instance / wrong account refusal
    check("run renewal with a foreign account refuses",
      /permission-denied/.test(await refusal(plane.issueManagerServiceAuthority({
        owner, scope: ["supervise"],
        request: makeRunRequest({}, { accountPublicKey: createSpaceAuthPub() }),
      }))));
    check("run renewal for a wrong instance refuses",
      /failed-precondition|permission-denied/.test(await refusal(plane.issueManagerServiceAuthority({
        owner, scope: ["supervise"],
        request: makeRunRequest({}, { instanceId: mintLifecycleUid() }),
      }))));

    // 4. Fenced manager refusal (stale processEpoch)
    check("fenced manager (stale processEpoch) refuses run renewal",
      /conflict/.test(await refusal(plane.issueManagerServiceAuthority({
        owner, scope: ["supervise"],
        request: makeRunRequest({}, { processEpoch: registered.processEpoch + 1 }, registered.processEpoch + 1),
      }))));

    // 5. Superseded run refusal
    statusRevision = await writeRunStatus(recordsKv, "manager", runId, {
      observedSpecRevision: 1, state: "running", holder: `${holderId}.${takeoverId}`, epoch: 2, fencingToken: 6, journalHigh: 1, at: Date.now(),
    }, statusRevision);
    check("superseded run (stale fencingToken) refuses run renewal",
      /conflict/.test(await refusal(plane.issueManagerServiceAuthority({
        owner, scope: ["supervise"],
        request: makeRunRequest({ fencingToken: 5 }),
      }))));
    check("unrecorded run refuses run renewal",
      /conflict/.test(await refusal(plane.issueManagerServiceAuthority({
        owner, scope: ["supervise"],
        request: makeRunRequest({ runId: `run-${"f".repeat(32)}` }),
      }))));

    // 6. Sibling positive control: standing renewal still succeeds after run operations and fence
    const standingControl = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request() });
    check("sibling standing renewal remains healthy and serves all 5 duties",
      Object.keys(standingControl.credentials).sort().join(",") === [...names].sort().join(","));

    // 7. Sibling manager instance positive control: distinct instance B registers and renews independently
    const instanceIdB = mintLifecycleUid();
    const actorsB = remoteManagerActors(instanceIdB);
    const heldB = Object.fromEntries(names.map((n) => [n, newIdentity()])) as Record<Name, Identity>;
    const prepCredsB = await mintCreds(auth, heldB.executor, "remote-manager", {
      principal: { owner, actor: actorsB.executor }, remoteManager: { instanceId: instanceIdB, owner, actor: actorsB.executor },
    });
    const registeredB = await registerRemoteManagerAuthority({
      space, server: SERVERS, owner, instanceId: instanceIdB, serveActor: actorsB.serve, prepareCreds: prepCredsB, tlsRequired: false, evict: async (principals) => principals.map(() => true),
    });
    const baseReqB = {
      v: 1 as const, kind: "manager-service-authority" as const, operation: "renewStandingBundle" as const,
      space, actor: "cli", instanceId: instanceIdB, managerLifecycleUid: mintLifecycleUid(),
      requestId: `req${mintLifecycleUid()}`, accountPublicKey: dataAccount.pub, processEpoch: registeredB.processEpoch,
      identities: Object.fromEntries(names.map((n) => [n, { id: heldB[n].id }])) as RemoteManagerAuthorityRequest["identities"],
    };
    const reqB: RemoteManagerAuthorityRequest = {
      ...baseReqB,
      registrationProof: remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, owner, baseReqB as RemoteManagerAuthorityRequest, {
        registrationRevision: registeredB.registrationRevision, processEpoch: registeredB.processEpoch,
      }),
    };
    const matB = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: reqB });
    check("sibling manager instance B renews independently on its own gate",
      Object.keys(matB.credentials).sort().join(",") === [...names].sort().join(","));
  } finally {
    await provNc.close().catch(() => {});
  }
} finally {
  try { await plane?.close(); } catch { /* broker may be gone */ }
  await killAndAwaitExit(srv, "SIGKILL");
  releaseBroker();
}
console.log(`manager standing renewal: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);

function createSpaceAuthPub(): string {
  // A syntactically valid account key that is not this space's data account.
  return `A${"B".repeat(55)}`;
}
