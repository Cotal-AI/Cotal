/**
 * Issued caller generation expiry (SPEC 13.15, 14.8) through the shipped auth service and its
 * manager-service-authority door, on an isolated user-auth mesh:
 *  - R51-R53: a manager-caller connection publishes a run-start before its 3 s credential expires,
 *    the expired bearer cannot reconnect, and a forward of a request the host never observed refuses;
 *  - R54: a first-run admission forwarded after that expiry is refused as expired, never admitted;
 *  - R55: a run admitted while its caller's generation was live keeps renewing after it expires;
 *  - C5a: IssuedStore.resolve() refuses an expired user-caller generation with the expiry diagnostic.
 *
 * Run: tsx implementations/auth/smoke/issued-caller-expiry.smoke.ts (needs nats-server on PATH)
 */
// The manager's agent auth preflight runs its own entry file (process.argv[1]) as `agent-bearer`.
if (process.argv[2] === "agent-bearer") {
  await import("../src/index.js");
  const { registry } = await import("@cotal-ai/core");
  const raw = process.argv.slice(3);
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i]!;
    if (!flag.startsWith("--")) throw new Error("agent-bearer fixture takes flags only");
    const next = raw[i + 1];
    if (next !== undefined && !next.startsWith("--")) { values[flag.slice(2)] = next; i++; }
    else values[flag.slice(2)] = true;
  }
  await registry.resolve<import("@cotal-ai/core").Command>("command", "agent-bearer").run({ values, positionals: [], raw });
  process.exit(0);
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { connect, credsAuthenticator, tokenAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  issuedUserCaller, mintCreds, mintLifecycleUid, newIdentity,
  setupSpaceStreams, standaloneConnectOpts, withIssuerSession, CotalEndpoint, epRequestSubject, readRunAdmission,
  createRunSpec, credsClaims, newTakeoverId, openRecordsBucket, writeRunStatus, type RunAdmission,
  registry, type Connector, type LaunchOpts, type RuntimeProvider, type AgentHandle,
  type IssuedCaller, type RemoteManagerAuthorityMaterial, type RemoteRunAdmissionResult,
} from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import {
  deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, startAuthService,
  findManagedActor, ledgerActorSourceIsLive, type AuthServiceHandle,
} from "../src/index.js";
import { remoteManagerRegistrationProof } from "../src/authority-client.js";
import { Manager, managerClusterArtifacts, registerRemoteManagerAuthority } from "../../manager/src/index.js";
import * as remote from "../../manager/src/remote-authority.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import "../../runtime/src/index.js";
import { agentLifecycleSecretFilePaths } from "@cotal-ai/workspace";

let pass = 0, fail = 0;

async function cell(name: string, fn: (obs: Record<string, unknown>) => Promise<void>) {
  const obs: Record<string, unknown> = {};
  try {
    await fn(obs);
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    console.error(`    observed: ${JSON.stringify(obs)}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mintRunId = () => `run-${randomBytes(16).toString("hex")}`;

const fx = await startHostedAuthFixture("expiry", 1);
const a = fx.accounts[0]!;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "expiry-idp", alg: "EdDSA" };
const idp = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
rmSync(join(a.stateDir, "idp.json"));
ensurePinnedIdp(a.stateDir, `${origin}/api/auth`);
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "expiry-human");
grantActor(a.stateDir, { owner, actor: "cli", scope: ["admin", "spawn", "run", "supervise"], allowSubscribe: [">"], allowPublish: [">"] });
const idpToken = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "expiry-idp" }).setSubject("expiry-human").setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("10m").sign(privateKey);

let service: AuthServiceHandle | undefined;
let manager: Manager | undefined;
const endpoints: CotalEndpoint[] = [];
const launches = new Map<string, LaunchOpts>();
const connector: Connector = {
  kind: "connector",
  name: "expiry-fixture",
  requires: [],
  buildLaunch: (opts) => { launches.set(opts.name, opts); return { command: "fixture", args: [] }; },
};
const runtime: RuntimeProvider = {
  kind: "runtime",
  name: "expiry-fixture",
  available: () => true,
  create: () => ({
    kind: "expiry-fixture",
    spawn: (name): AgentHandle => {
      const opts = launches.get(name)!;
      const closed = { value: false };
      void (async () => {
        assert.ok(opts.userAuth && opts.lifecycleUid);
        const files = agentLifecycleSecretFilePaths(opts.workspaceRoot!, a.space, name, opts.lifecycleUid);
        const actorToken = readFileSync(files.actorToken, "utf8").trim();
        const exchange = await post<{ token: string }>("/exchange", { owner, actor: name, actorToken });
        const ep = new CotalEndpoint({
          space: a.space,
          servers: fx.servers,
          bearer: exchange.token,
          sentinelCreds: a.sentinelCreds,
          lifecycleUid: opts.lifecycleUid,
          card: { owner, actor: name, name, kind: "agent" },
          channels: [],
          consume: false,
          watchChannels: false,
        });
        endpoints.push(ep);
        ep.on("error", () => {});
        await ep.start();
      })().catch((error) => {
        console.error("managed endpoint fixture refused:", error instanceof Error ? error.message : "unknown");
        closed.value = true;
      });
      return {
        name,
        kind: "expiry-fixture",
        status: () => (closed.value ? "exited" : "running"),
        stop: () => { closed.value = true; },
        release: () => {},
        interrupt: () => {},
        attach: () => { throw new Error("no terminal in fixture"); },
      };
    },
  }),
};
registry.register(connector, runtime);

const state = remote.loadOrCreateRemoteManagerIdentity(join(fx.dir, "mgr"), a.space);

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${service!.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error ?? "refused"}`);
  return result;
}

const authority = (request: import("@cotal-ai/core").RemoteManagerAuthorityRequest) =>
  post<RemoteManagerAuthorityMaterial>("/manager-service-authority", { idpToken, request });

try {
  const provCreds = await mintCreds(a.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: provCreds });

  service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space,
    servers: fx.servers,
    stateDir: a.stateDir,
    store: a.store,
    storeIdentity: a.store.identity,
    publicFace: { port: 0, trustedProxy: false },
  });

  const prepared = await authority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
  const registered = await registerRemoteManagerAuthority({
    space: a.space,
    server: fx.servers,
    owner,
    instanceId: state.instanceId,
    serveActor: prepared.actors.serve,
    prepareCreds: remote.materialCredential(prepared, "executor", state.identities.executor),
    tlsRequired: false,
    evict: async () => [],
  });
  const cluster = managerClusterArtifacts();
  const contractArtifacts = [cluster.document, cluster.manifest];
  const activated = await authority(
    remote.remoteManagerAuthorityRequest(state, "cli", "activate", {
      registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts),
      contractArtifacts,
    }),
  );
  const proof = remote.currentRegistrationProof(activated);
  const supervisorCreds = remote.materialCredential(prepared, "supervisor", state.identities.supervisor);
  const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: authority });
  const managerRoot = join(fx.dir, "manager-root");
  mkdirSync(join(managerRoot, ".cotal", "agents"), { recursive: true });
  manager = new Manager({
    space: a.space,
    servers: fx.servers,
    workspaceRoot: managerRoot,
    runtime: "expiry-fixture",
    remoteAuthority: {
      ...standing,
      owner,
      actors: prepared.actors,
      instanceId: state.instanceId,
      lifecycleUid: state.lifecycleUid,
      identities: state.identities,
      supervisorCreds,
      executorCreds: remote.materialCredential(prepared, "executor", state.identities.executor),
      renewExecutor: async () =>
        remote.materialCredential(
          await authority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })),
          "executor",
          state.identities.executor,
        ),
      serveCreds: remote.materialCredential(activated, "serve", state.identities.serve),
      goalWriterCreds: remote.materialCredential(activated, "goalWriter", state.identities.goalWriter),
      sessionLedgerCreds: remote.materialCredential(activated, "sessionLedger", state.identities.sessionLedger),
      serveGrant: registered.serveGrant,
      mintSessionServing: async () => { throw new Error("unused"); },
      mintRetirementRequester: async () => { throw new Error("unused"); },
      prepareAgentRetirement: async () => { throw new Error("unused"); },
      validateRetainedAgent: async () => { throw new Error("unused"); },
      scanGoalIndex: async () => {
        const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
        return remote.remoteManagerGoalIndexEntries(await post("/manager-service-authority", { idpToken, request }), request, owner);
      },
      authorizeAdmin: async (caller) => {
        const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
        return remote.remoteManagerAdminAuthorized(await post("/manager-service-authority", { idpToken, request }), request, owner);
      },
      agentBearerExchangeUrl: service.publicUrl!,
      enrollManagedAgent: async ({ target }) => {
        const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target);
        return remote.remoteManagedAgentEnrollmentMaterial(await post("/manager-service-authority", { idpToken, request }), request);
      },
    },
  });
  await manager.start();

  writeFileSync(join(managerRoot, ".cotal", "agents", "runner.md"), "---\nname: runner\nagent: expiry-fixture\ncapabilities: [spawn, run]\n---\n");
  const startedRunner = await manager.startAgent({ name: "runner", events: false }, `${owner}.cli`);
  assert.ok(startedRunner.ok, startedRunner.error);
  const runnerRow = findManagedActor(a.stateDir, owner, "runner")!;
  const uid = runnerRow.lifecycleUid!;
  const secretPaths = agentLifecycleSecretFilePaths(managerRoot, a.space, "runner", uid);
  const actorToken = readFileSync(secretPaths.actorToken, "utf8").trim();

  const runStartCmd = cluster.document.commands.find((c) => c.name === "run-start")!;
  let r5Caller!: IssuedCaller;
  let r5Opts!: Record<string, unknown>;
  let r5Exp = 0;
  let r5Served = "";

  // R51: Native caller connects with a short-lived (ttlSec=3) manager-caller bearer and publishes a
  // real v1 run-start request on its issued subject before expiry (which the auth-service's
  // observedRunRequests subscription observes over the broker).
  await cell("R51 native caller published run-start before expiry", async (obs) => {
    const ex = await post<{ token: string; exp: number }>("/exchange", {
      owner,
      actor: "runner",
      actorToken,
      ttlSec: 3,
      view: "manager-caller",
      managerInstanceId: state.instanceId,
    });
    r5Exp = ex.exp;
    r5Opts = standaloneConnectOpts({ bearer: ex.token, sentinelCreds: a.sentinelCreds, tls: false });
    const dial = await connect({ servers: fx.servers, ...r5Opts, maxReconnectAttempts: 0 });
    try {
      r5Caller = await issuedUserCaller(dial, a.space, String(r5Opts.name), { owner, actor: "runner", uid });
      const nonce = mintLifecycleUid();
      r5Served = epRequestSubject(a.space, {
        route: { mode: "inst", instanceId: state.instanceId },
        endpoint: "manager",
        command: "run-start",
        caller: r5Caller,
        nonce,
      });
      dial.publish(
        r5Served,
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            id: nonce,
            op: {
              endpoint: "manager",
              command: "run-start",
              inputDigest: runStartCmd.inputDigest,
              outputDigest: runStartCmd.outputDigest,
            },
            class: "ephemeral",
            replyExpected: true,
            deadlineMs: 8000,
            args: { source: 'log("review");' },
            from: { id: `${owner}.runner`, name: "runner" },
          }),
        ),
      );
      await dial.flush();
      const nowSec = Math.floor(Date.now() / 1000);
      assert.ok(r5Served.includes(".run-start."));
      assert.ok(nowSec < r5Exp, `expected publish before expiry ${r5Exp}, now=${nowSec}`);
      obs.generation = r5Caller.generation;
      obs.served = r5Served;
      obs.publishedBeforeExpiry = true;
      obs.remainingSecAtPublish = r5Exp - nowSec;
    } finally {
      await dial.close();
    }
  });

  while (Math.floor(Date.now() / 1000) <= r5Exp + 1) await wait(100);

  // R52: Expired bearer cannot reconnect to the broker.
  await cell("R52 expired bearer cannot reconnect", async (obs) => {
    await assert.rejects(
      async () => {
        const c = await connect({ servers: fx.servers, ...r5Opts, maxReconnectAttempts: 0 });
        await c.close();
        throw new Error("unexpectedly connected");
      },
      /expir|authoriz/i,
    );
    obs.expiredBySec = Math.floor(Date.now() / 1000) - r5Exp;
  });

  // R53: Unobserved subject is refused with "did not observe" (proving runId format and registration proof are valid).
  await cell("R53 no-observation forward refuses", async (obs) => {
    const missing = r5Served.slice(0, r5Served.lastIndexOf(".") + 1) + mintLifecycleUid();
    const request = remote.remoteRunAdmissionRequest(state, proof, a.accountPublicKey, registered.processEpoch, {
      runId: mintRunId(),
      subject: missing,
    });
    await assert.rejects(
      () => post("/manager-service-authority", { idpToken, request }),
      /did not observe/,
    );
    obs.unobservedRefused = true;
  });

  // R54: Delayed first-run admission forwarded after the caller's credential expired
  // MUST be refused as expired, never admitted.
  await cell("R54 expired generation must not authorize delayed first admission", async (obs) => {
    const delayedRunId = mintRunId();
    const request = remote.remoteRunAdmissionRequest(state, proof, a.accountPublicKey, registered.processEpoch, {
      runId: delayedRunId,
      subject: r5Served,
    });
    let response: RemoteRunAdmissionResult | undefined;
    try {
      response = await post<RemoteRunAdmissionResult>("/manager-service-authority", { idpToken, request });
    } catch (e) {
      assert.match(String(e), new RegExp(`HTTP 403: generation ${r5Caller.generation} expired at ${r5Exp} \\(SPEC 13\\.15\\)$`));
      obs.refusedExpired = true;
      return;
    }
    const readerCreds = await mintCreds(a.auth, newIdentity(), "run-mediator", {
      runMediator: { endpoint: "manager", runId: delayedRunId, takeoverId: "a".repeat(16), instanceId: state.instanceId, epoch: 1 },
    });
    const readerNc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: readerCreds, tls: false }), maxReconnectAttempts: 0 });
    try {
      const stored = await readRunAdmission(await jetstreamManager(readerNc), a.space, "manager", delayedRunId);
      obs.authorizedAfterExpirySec = Math.floor(Date.now() / 1000) - r5Exp;
      obs.admissionCreated = stored.admission.provenance.kind === "issued";
      obs.admittedGeneration = stored.admission.provenance.kind === "issued" ? stored.admission.provenance.ref.generation : undefined;
      obs.revision = response.revision;
    } finally {
      await readerNc.close();
    }
    assert.fail(
      `expired caller generation ${r5Caller.generation} authorized a new durable run admission ${delayedRunId} (revision ${response.revision}) ${obs.authorizedAfterExpirySec}s after the NATS credential expired`,
    );
  });

  // R55 (SPEC 14.8 control): a run admitted while its caller's generation was live keeps renewing its
  // driver after that generation expires. Credential expiry after admission revokes nothing; only a
  // new admission needs a live generation (R54). The run is hosted by hand through the stock
  // signerless run callbacks, and its issued driver writes the status a hosted drive writes.
  await cell("R55 run admitted before its caller generation expired keeps renewing after expiry", async (obs) => {
    const hosting = remote.remoteRunHosting({
      state, owner, registrationProof: proof, accountPublicKey: a.accountPublicKey, processEpoch: registered.processEpoch,
      requestRunAdmission: (request) => post("/manager-service-authority", { idpToken, request }),
      requestRunAttempt: (request) => post("/manager-service-authority", { idpToken, request }),
      call: authority,
    });
    const ex = await post<{ token: string; exp: number }>("/exchange", {
      owner,
      actor: "runner",
      actorToken,
      ttlSec: 3,
      view: "manager-caller",
      managerInstanceId: state.instanceId,
    });
    const opts = standaloneConnectOpts({ bearer: ex.token, sentinelCreds: a.sentinelCreds, tls: false });
    const dial = await connect({ servers: fx.servers, ...opts, maxReconnectAttempts: 0 });
    const runId = mintRunId();
    let caller!: IssuedCaller;
    let admission!: RunAdmission;
    try {
      caller = await issuedUserCaller(dial, a.space, String(opts.name), { owner, actor: "runner", uid });
      const nonce = mintLifecycleUid();
      const served = epRequestSubject(a.space, {
        route: { mode: "inst", instanceId: state.instanceId },
        endpoint: "manager",
        command: "run-start",
        caller,
        nonce,
      });
      dial.publish(
        served,
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            id: nonce,
            op: {
              endpoint: "manager",
              command: "run-start",
              inputDigest: runStartCmd.inputDigest,
              outputDigest: runStartCmd.outputDigest,
            },
            class: "ephemeral",
            replyExpected: true,
            deadlineMs: 8000,
            args: { source: 'log("review");' },
            from: { id: `${owner}.runner`, name: "runner" },
          }),
        ),
      );
      await dial.flush();
      admission = await hosting.admitRun({ runId, subject: served });
    } finally {
      await dial.close();
    }
    const admittedAtSec = Math.floor(admission.admittedAt / 1000);
    assert.ok(admittedAtSec < ex.exp, `expected admission before the caller's expiry ${ex.exp}; admitted at ${admittedAtSec}`);
    assert.equal(admission.provenance.kind === "issued" ? admission.provenance.ref.generation : undefined, caller.generation);

    const takeoverId = newTakeoverId();
    const driver = newIdentity();
    const mediator = newIdentity();
    const holder = `${state.identities.supervisor.id}.${takeoverId}`;
    const pair = await hosting.issueAttempt({ runId, takeoverId, epoch: 1, fencingToken: 1, driver, mediator });
    const driverNc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: pair.driver, tls: false }), maxReconnectAttempts: 0 });
    try {
      const kv = await openRecordsBucket(driverNc, a.space);
      const specRevision = await createRunSpec(kv, "manager", runId, {
        pins: { seed: "s", startedAt: Date.now(), yieldEvery: 1, stepBudget: 1, effectCeiling: 1, languageVersion: "1" }, createdAt: Date.now(),
      });
      await writeRunStatus(kv, "manager", runId,
        { observedSpecRevision: specRevision, state: "running", holder, epoch: 1, fencingToken: 1, journalHigh: 0, at: Date.now() });
    } finally {
      await driverNc.close();
    }

    while (Math.floor(Date.now() / 1000) <= ex.exp + 1) await wait(100);
    const renewedAtSec = Math.floor(Date.now() / 1000);
    const renewed = await hosting.renewRun({ runId, holder, takeoverId, epoch: 1, fencingToken: 1, driver, mediator });
    const exps = [credsClaims(renewed.driver).exp ?? 0, credsClaims(renewed.mediator).exp ?? 0];
    obs.generation = caller.generation;
    obs.callerExp = ex.exp;
    obs.renewedAfterExpirySec = renewedAtSec - ex.exp;
    obs.renewedExp = exps;
    assert.equal(exps.filter((exp) => exp > renewedAtSec).length, 2, `expected a renewed driver and mediator that outlive the renewal; got exp ${exps.join(", ")} at ${renewedAtSec}`);

    // The renewed mediator reads the admission back: the one written under the expired generation, unrevoked.
    const mediatorNc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: renewed.mediator, tls: false }), maxReconnectAttempts: 0 });
    try {
      const view = await readRunAdmission(await jetstreamManager(mediatorNc), a.space, "manager", runId);
      obs.revoked = view.revoked !== undefined;
      assert.equal(view.revoked, undefined);
      assert.equal(view.admission.provenance.kind === "issued" ? view.admission.provenance.ref.generation : undefined, caller.generation);
    } finally {
      await mediatorNc.close();
    }
  });

  // C5a: an expired user-caller generation is refused by IssuedStore.resolve() with the expiry diagnostic,
  // never resolving as active and never refusing as unknown.
  await cell(
    "C5a expired user-caller generation refuses in IssuedStore.resolve() with the expiry diagnostic, never resolving or reporting unknown",
    async (obs) => {
      const ex = await post<{ token: string; exp: number }>("/exchange", {
        owner,
        actor: "runner",
        actorToken,
        ttlSec: 2,
        view: "manager-caller",
        managerInstanceId: state.instanceId,
      });
      const nonce = `ibxexp5a${mintLifecycleUid()}`;
      const nc = await connect({
        servers: fx.servers,
        authenticator: [credsAuthenticator(new TextEncoder().encode(a.sentinelCreds)), tokenAuthenticator(ex.token)],
        name: nonce,
        inboxPrefix: `_INBOX_${nonce}`,
        maxReconnectAttempts: 0,
      });
      let expCaller: IssuedCaller;
      try {
        expCaller = await issuedUserCaller(nc, a.space, nonce, { owner, actor: "runner", uid });
      } finally {
        await nc.close();
      }
      while (Math.floor(Date.now() / 1000) <= ex.exp + 1) await wait(100);

      let resolutionOutcome = "";
      await withIssuerSession({ servers: fx.servers, space: a.space, auth: a.auth, tls: false }, async (session) => {
        const sourceIsLive = async (s: import("@cotal-ai/core").IssuedSourceRef) => ledgerActorSourceIsLive(a.stateDir)(s);
        try {
          const res = await session.store.resolve({ space: a.space, owner, actor: "runner", uid, generation: expCaller.generation }, sourceIsLive);
          resolutionOutcome = `resolved:expiresAt=${String(res.evidence.expiresAt)}`;
        } catch (e) {
          resolutionOutcome = e instanceof Error ? e.message : String(e);
        }
      });
      obs.generation = expCaller.generation;
      obs.expectedExp = ex.exp;
      obs.resolutionOutcome = resolutionOutcome;
      assert.match(
        resolutionOutcome,
        new RegExp(`generation ${expCaller.generation} expired at ${ex.exp} \\(SPEC 13\\.15\\)`),
        `expected the expiry diagnostic for an expired user-caller generation; got: ${resolutionOutcome}`,
      );
    },
  );
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await manager?.stop().catch(() => {});
  await service?.close().catch(() => {});
  idp.closeAllConnections();
  await new Promise<void>((resolve) => idp.close(() => resolve()));
  await fx.close();
}

console.log(`\nissued-caller-expiry smoke: ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail === 0 ? 0 : 1);
