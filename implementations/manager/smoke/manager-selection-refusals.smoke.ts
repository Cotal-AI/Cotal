/**
 * Live smoke for #3959 (Part A): authenticated manager-selection refusals stay actionable, do not
 * spend the per-peer probing budget, and are bounded per authenticated principal.
 *
 * Setup: two legitimate remote managers for one owner, registered and activated through the
 * shipped authority path, plus a second owner's remote manager and an unregistered gate; the auth
 * service's public face with `--exchange-trusted-proxy`; real IdP-signed human JWTs and managed
 * agent actor-secret exchanges.
 */
const subcommand = process.argv[2];
if (subcommand === "auth-service") {
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  const values: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i]!;
    if (!value.startsWith("--")) positionals.push(value);
    else if (rest[i + 1] && !rest[i + 1]!.startsWith("--")) values[value.slice(2)] = rest[++i]!;
    else values[value.slice(2)] = true;
  }
  await registry.resolve<import("@cotal-ai/core").Command>("command", subcommand).run({ values, positionals, raw: rest });
  process.exit(0);
}

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createSpaceAuth, epAuthBucket, recordsBucket, recordStatusKey, RECORD_KINDS, mintCreds, newIdentity, mintLifecycleUid, serverConfig, setupSpaceStreams,
  standaloneConnectOpts, isReachable, remoteManagerActors, remoteManagerRegistrationProof,
} from "@cotal-ai/core";
import { authDir, userAuthStateDir, workspaceSecretStore, saveSpaceAuth } from "@cotal-ai/workspace";
import {
  cotalAuthProvider, saveIdpSession, fetchIdpJwt, grantActor, grantManagedActor, newActorToken,
  loadAuthServiceInfo, loadOwnerSecret, loadPinnedIdp, deriveOwnerForIdpSubject,
  validateUserToken, pinnedJwksResolver, spaceIssuer, type ValidatedUserToken,
  openLifecycleMappingReader, readLifecycleMappingLeader,
} from "@cotal-ai/auth";
import { Manager, type ManagerOptions } from "../src/manager.js";
import { managerClusterArtifacts } from "../src/manager-service-contract.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";
import * as remote from "../src/remote-authority.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

const here = import.meta.dirname;
const self = resolve(here, "manager-selection-refusals.smoke.ts");
const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}fsel-`));
const homeA = join(scratch, "home-a");
const homeB = join(scratch, "home-b");
const homeC = join(scratch, "home-c");
const hostRoot = join(scratch, "host");
const rootA = join(scratch, "participant-a");
const rootB = join(scratch, "participant-b");
const rootC1 = join(scratch, "participant-c1");
const rootC2 = join(scratch, "participant-c2");
const rootStopped = join(scratch, "participant-stopped");
const rootOther = join(scratch, "participant-other");
for (const dir of [homeA, homeB, homeC, hostRoot, rootA, rootB, rootC1, rootC2, rootStopped, rootOther]) {
  mkdirSync(join(dir, ".cotal"), { recursive: true });
}
process.env.COTAL_HOME = homeA;

const space = `fsel${mintLifecycleUid().slice(0, 8)}`;
const port = await freePort();
const publicPort = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const publicUrl = "https://auth.fsel.example";
const PUBLIC = `http://127.0.0.1:${publicPort}`;
const hostDir = userAuthStateDir(hostRoot, space);
const hostStore = workspaceSecretStore(hostRoot);

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ FAIL: ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, label: string, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await fn()) {
    if (Date.now() > end) throw new Error(label);
    await wait(100);
  }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

const asPeer = (ip: string) => ({ "x-forwarded-for": `10.0.0.1, ${ip}` });

let broker: ChildProcess | undefined;
let authChild: ChildProcess | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let managerA: Manager | undefined;
let managerB: Manager | undefined;
let idpServer: ReturnType<typeof createServer> | undefined;

try {
  const betterRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);
  const { betterAuth } = await import(new URL("dist/index.mjs", betterRoot).href);
  const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterRoot).href);
  const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterRoot).href);
  const { bearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterRoot).href);
  const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterRoot).href);

  let handler: ReturnType<typeof toNodeHandler>;
  idpServer = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => idpServer!.listen(0, "127.0.0.1", r));
  const address = idpServer.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const idpUrl = `${origin}/api/auth`;
  const idp = betterAuth({
    baseURL: origin,
    secret: "native-fsel-disposable-fixture-secret-123456",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
    emailAndPassword: { enabled: true },
    plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), bearer()],
  });
  handler = toNodeHandler(idp);

  const signupA = await idp.api.signUpEmail({
    body: { email: "owner-a@example.test", password: "native-fixture-password", name: "Owner A" },
  });
  assert(signupA.token && signupA.user.id);
  saveIdpSession(homeA, idpUrl, { token: signupA.token, sub: signupA.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 });

  const signupB = await idp.api.signUpEmail({
    body: { email: "owner-b@example.test", password: "native-fixture-password", name: "Owner B" },
  });
  assert(signupB.token && signupB.user.id);
  saveIdpSession(homeB, idpUrl, { token: signupB.token, sub: signupB.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 });

  const signupC = await idp.api.signUpEmail({
    body: { email: "owner-c@example.test", password: "native-fixture-password", name: "Owner C" },
  });
  assert(signupC.token && signupC.user.id);
  saveIdpSession(homeC, idpUrl, { token: signupC.token, sub: signupC.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 });

  const auth = await createSpaceAuth(space);
  saveSpaceAuth(authDir(hostRoot), auth);
  const prepared = await cotalAuthProvider.prepareServer({
    space,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store: hostStore,
    dir: hostDir,
    idpUrl,
  });
  writeFileSync(
    join(scratch, "server.conf"),
    serverConfig(auth, [auth], {
      transport: { kind: "plaintext" },
      port,
      storeDir: join(scratch, "js"),
      extraAccounts: prepared.extraAccounts,
    }),
  );
  broker = spawn("nats-server", ["-c", join(scratch, "server.conf")], { stdio: "ignore" });
  teardownOnSignal(broker, scratch);
  await until(() => isReachable(servers), "broker readiness");
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: hostStore.identity! });

  authChild = spawn(
    process.execPath,
    [
      ...process.execArgv,
      self,
      "auth-service",
      "--space",
      space,
      "--server",
      servers,
      "--exchange-public-port",
      String(publicPort),
      "--exchange-public-url",
      publicUrl,
      "--exchange-trusted-proxy",
    ],
    { cwd: hostRoot, env: process.env, stdio: "ignore" },
  );
  await until(async () => {
    if (authChild!.exitCode !== null) throw new Error("auth-service exited during boot");
    const info = loadAuthServiceInfo(hostDir);
    return !!info?.publicUrl && (await fetch(`${PUBLIC}/health`).catch(() => undefined))?.ok === true;
  }, "auth-service public face readiness");

  const info = loadAuthServiceInfo(hostDir)!;
  const verifyPublicKey = pinnedJwksResolver(`${PUBLIC}/jwks`);
  const pin = loadPinnedIdp(hostDir)!;
  const ownerSecret = (await loadOwnerSecret(hostStore, space))!;
  const owner = deriveOwnerForIdpSubject(ownerSecret, pin.issuer, signupA.user.id);
  const otherOwner = deriveOwnerForIdpSubject(ownerSecret, pin.issuer, signupB.user.id);

  grantActor(hostDir, {
    owner,
    actor: "cli",
    scope: ["spawn", "run", "supervise", "admin"],
    allowSubscribe: [">"],
    allowPublish: [">"],
    label: "owner A cli",
  });
  grantActor(hostDir, {
    owner: otherOwner,
    actor: "cli",
    scope: ["spawn", "run", "supervise", "admin"],
    allowSubscribe: [">"],
    allowPublish: [">"],
    label: "owner B cli",
  });
  grantActor(hostDir, {
    owner: otherOwner,
    actor: "cli_alt",
    scope: ["spawn", "run", "supervise", "admin"],
    allowSubscribe: [">"],
    allowPublish: [">"],
    label: "owner B cli alt",
  });
  const ownerC = deriveOwnerForIdpSubject(ownerSecret, pin.issuer, signupC.user.id);
  grantActor(hostDir, {
    owner: ownerC,
    actor: "cli",
    scope: ["spawn", "run", "supervise", "admin"],
    allowSubscribe: [">"],
    allowPublish: [">"],
    label: "owner C cli",
  });

  const AGENT = "worker_a";
  const secretA = newActorToken();
  const lifecycleA = mintLifecycleUid();
  grantManagedActor(hostDir, {
    owner,
    actor: AGENT,
    scope: ["role:worker"],
    allowSubscribe: ["general"],
    allowPublish: ["general"],
    parent: `${owner}.cli`,
    tokenHash: secretA.tokenHash,
    lifecycleUid: lifecycleA,
  });

  const VIRGIN_AGENT = "virgin_a";
  const secretVirgin = newActorToken();
  const lifecycleVirgin = mintLifecycleUid();
  grantManagedActor(hostDir, {
    owner,
    actor: VIRGIN_AGENT,
    scope: ["role:worker"],
    allowSubscribe: ["general"],
    allowPublish: ["general"],
    parent: `${owner}.cli`,
    tokenHash: secretVirgin.tokenHash,
    lifecycleUid: lifecycleVirgin,
  });

  const OTHER_AGENT = "worker_b";
  const secretOther = newActorToken();
  const lifecycleOther = mintLifecycleUid();
  grantManagedActor(hostDir, {
    owner: otherOwner,
    actor: OTHER_AGENT,
    scope: ["role:worker"],
    allowSubscribe: ["general"],
    allowPublish: ["general"],
    parent: `${otherOwner}.cli`,
    tokenHash: secretOther.tokenHash,
    lifecycleUid: lifecycleOther,
  });

  const callArgs = { store: hostStore, dir: hostDir };
  const callAuthorityFor = (homeDir: string) => async (
    request: Parameters<NonNullable<typeof cotalAuthProvider.managerServiceAuthority>>[0]["request"],
  ) => {
    const prev = process.env.COTAL_HOME;
    process.env.COTAL_HOME = homeDir;
    try {
      return await cotalAuthProvider.managerServiceAuthority!({ ...callArgs, request });
    } finally {
      process.env.COTAL_HOME = prev;
    }
  };
  const callAuthorityA = callAuthorityFor(homeA);
  const callAuthorityB = callAuthorityFor(homeB);
  const callAuthorityC = callAuthorityFor(homeC);

  const bootRemoteManager = async (
    workspaceRoot: string,
    state: ReturnType<typeof remote.loadOrCreateRemoteManagerIdentity>,
    mgrOwner: string,
    callAuth: ReturnType<typeof callAuthorityFor>,
  ): Promise<Manager> => {
    const prep = await callAuth(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
    const supervisorCreds = remote.materialCredential(prep, "supervisor", state.identities.supervisor);
    const executorCreds = remote.materialCredential(prep, "executor", state.identities.executor);
    const registered = await registerRemoteManagerAuthority({
      space,
      server: servers,
      owner: mgrOwner,
      instanceId: state.instanceId,
      serveActor: remoteManagerActors(state.instanceId).serve,
      prepareCreds: executorCreds,
      tlsRequired: false,
      evict: async (principals) => {
        // Pin homeA (bootRemoteManager boots only owner A's managers) against callAuthorityFor's global COTAL_HOME swap across await.
        const prev = process.env.COTAL_HOME;
        process.env.COTAL_HOME = homeA;
        try {
          const request = remote.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
          const result = await cotalAuthProvider.maintainRemoteManager!({ ...callArgs, request });
          return remote.remoteManagerMaintenanceResult(result, request, mgrOwner).evictions!.map((e) => e.verifiedGone);
        } finally {
          process.env.COTAL_HOME = prev;
        }
      },
    });
    const artifacts = managerClusterArtifacts();
    const contractArtifacts = [artifacts.document, artifacts.manifest];
    const activate = await callAuth(
      remote.remoteManagerAuthorityRequest(state, "cli", "activate", {
        registrationProof: remoteManagerRegistrationProof(mgrOwner, state, contractArtifacts),
        contractArtifacts,
      }),
    );
    const proof = remote.currentRegistrationProof(activate);
    const standing = remote.remoteStandingBundleRenewal({ state, owner: mgrOwner, registrationProof: proof, supervisorCreds, call: callAuth });
    const remoteAuthority: NonNullable<ManagerOptions["remoteAuthority"]> = {
      ...standing,
      owner: mgrOwner,
      actors: remoteManagerActors(state.instanceId),
      instanceId: state.instanceId,
      lifecycleUid: state.lifecycleUid,
      identities: state.identities,
      supervisorCreds,
      executorCreds,
      serveCreds: remote.materialCredential(activate, "serve", state.identities.serve),
      goalWriterCreds: remote.materialCredential(activate, "goalWriter", state.identities.goalWriter),
      sessionLedgerCreds: remote.materialCredential(activate, "sessionLedger", state.identities.sessionLedger),
      serveGrant: registered.serveGrant,
      agentBearerExchangeUrl: info.publicUrl!,
      renewExecutor: async () =>
        remote.materialCredential(
          await callAuth(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })),
          "executor",
          state.identities.executor,
        ),
      runHosting: remote.remoteRunHosting({
        state,
        owner: mgrOwner,
        registrationProof: proof,
        accountPublicKey: standing.accountPublicKey,
        processEpoch: registered.processEpoch,
        requestRunAdmission: (request) => cotalAuthProvider.requestRemoteRunAdmission!({ ...callArgs, request }),
        requestRunAttempt: (request) => cotalAuthProvider.requestRemoteRunAttempt!({ ...callArgs, request }),
        call: callAuth,
      }),
      authorizeAdmin: async (caller) => {
        const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
        const response = await cotalAuthProvider.authorizeRemoteManagerAdmin!({ ...callArgs, request });
        return remote.remoteManagerAdminAuthorized(response, request, mgrOwner);
      },
      enrollManagedAgent: async ({ target }) => {
        const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target);
        return remote.remoteManagedAgentEnrollmentMaterial(await cotalAuthProvider.enrollRemoteManagedAgent!({ ...callArgs, request }), request);
      },
      prepareAgentRetirement: async ({ target, opId }) => {
        const request = remote.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, registered.processEpoch, target, opId);
        remote.remoteManagedAgentRetirementPrepared(await cotalAuthProvider.prepareRemoteManagedAgentRetirement!({ ...callArgs, request }), request);
      },
      mintRetirementRequester: async ({ identity, target, opId, serveEpoch }) =>
        remote.materialCredential(
          await callAuth(
            remote.remoteManagerAuthorityRequest(state, "cli", "retire", {
              registrationProof: remoteManagerRegistrationProof(mgrOwner, state),
              retirement: { id: identity.id, target, opId, serveEpoch },
            }),
          ),
          "retirementRequester",
          identity,
        ),
      mintSessionServing: async () => {
        throw new Error("fixture does not request attach sessions");
      },
      validateRetainedAgent: async () => {
        throw new Error("fixture starts no retained seat");
      },
      scanGoalIndex: async () => {
        // Pin homeA for the real host goal-index scan against callAuthorityFor's global COTAL_HOME swap across await.
        const prev = process.env.COTAL_HOME;
        process.env.COTAL_HOME = homeA;
        try {
          const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
          return remote.remoteManagerGoalIndexEntries(await cotalAuthProvider.scanRemoteManagerGoalIndex!({ ...callArgs, request }), request, mgrOwner);
        } finally {
          process.env.COTAL_HOME = prev;
        }
      },
    };
    const started = new Manager({ space, servers, workspaceRoot, runtime: "pty", remoteAuthority, eventsRequired: true });
    await started.start();
    return started;
  };

  const registerCandidateManager = async (
    state: ReturnType<typeof remote.loadOrCreateRemoteManagerIdentity>,
    mgrOwner: string,
    callAuth: ReturnType<typeof callAuthorityFor>,
  ): Promise<void> => {
    const prep = await callAuth(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
    const executorCreds = remote.materialCredential(prep, "executor", state.identities.executor);
    const registered = await registerRemoteManagerAuthority({
      space,
      server: servers,
      owner: mgrOwner,
      instanceId: state.instanceId,
      serveActor: remoteManagerActors(state.instanceId).serve,
      prepareCreds: executorCreds,
      tlsRequired: false,
      evict: async () => [],
    });
    const nc = await connect({ servers, ...standaloneConnectOpts({ creds: executorCreds, tls: false }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      const records = await kvm.open(recordsBucket(space));
      await records.put(
        recordStatusKey(RECORD_KINDS.svc, ["manager", state.instanceId]),
        new TextEncoder().encode(JSON.stringify({ epoch: registered.processEpoch, state: "ready", observedSpecRevision: registered.registrationRevision })),
      );
    } finally {
      await nc.drain();
    }
  };

  const stateA = remote.loadOrCreateRemoteManagerIdentity(rootA, space);
  const stateB = remote.loadOrCreateRemoteManagerIdentity(rootB, space);
  managerA = await bootRemoteManager(rootA, stateA, owner, callAuthorityA);
  managerB = await bootRemoteManager(rootB, stateB, owner, callAuthorityA);
  const stateC1 = remote.loadOrCreateRemoteManagerIdentity(rootC1, space);
  const stateC2 = remote.loadOrCreateRemoteManagerIdentity(rootC2, space);
  await registerCandidateManager(stateC1, ownerC, callAuthorityC);
  await registerCandidateManager(stateC2, ownerC, callAuthorityC);

  // Open gate for owner A without an active Manager status record ("not registered"), plus an open
  // gate registered by owner B ("not this owner's").
  const stateStopped = remote.loadOrCreateRemoteManagerIdentity(rootStopped, space);
  const managerStopped = await bootRemoteManager(rootStopped, stateStopped, owner, callAuthorityA);
  await managerStopped.stop({ withAgents: true });
  const stateOther = remote.loadOrCreateRemoteManagerIdentity(rootOther, space);
  {
    const prep = await callAuthorityB(remote.remoteManagerAuthorityRequest(stateOther, "cli", "prepare"));
    const executorCreds = remote.materialCredential(prep, "executor", stateOther.identities.executor);
    await registerRemoteManagerAuthority({
      space,
      server: servers,
      owner: otherOwner,
      instanceId: stateOther.instanceId,
      serveActor: remoteManagerActors(stateOther.instanceId).serve,
      prepareCreds: executorCreds,
      tlsRequired: false,
      evict: async () => [],
    });
  }

  const idpJwtA = await fetchIdpJwt(idpUrl, signupA.token);
  const idpJwtB = await fetchIdpJwt(idpUrl, signupB.token);
  const sortedLive = [stateA.instanceId, stateB.instanceId].sort();
  const expectedHumanAmbiguous =
    `manager-caller selection found 2 live remote manager candidates for owner ${owner} (${sortedLive.join(", ")}); ` +
    `exactly one is required, so name one with --on <instanceId>`;
  const idpJwtC = await fetchIdpJwt(idpUrl, signupC.token);
  const sortedLiveC = [stateC1.instanceId, stateC2.instanceId].sort();
  const expectedHumanCAmbiguous =
    `manager-caller selection found 2 live remote manager candidates for owner ${ownerC} (${sortedLiveC.join(", ")}); ` +
    `exactly one is required, so name one with --on <instanceId>`;
  const expectedAgentAmbiguous =
    `manager-caller selection found 2 live remote manager candidates for owner ${owner} (${sortedLive.join(", ")}); ` +
    `exactly one is required, so name one with --manager-instance <instanceId>`;
  const expectedSelectionThrottled =
    "too many manager-caller selection refusals - name a manager instance (--on <id> or --manager-instance <id>) or start one with `cotal supervise`, then wait a minute and retry";
  const expectedPinnedSelectionThrottled =
    "too many pinned manager-caller selection refusals - check that the pinned manager instance is live and registered to you, then wait a minute and retry";

  // ---------- S1. Pinned human and agent exchanges mint, scoped to the named instance ----------
  console.log("S1) pinned human and agent exchanges mint, scoped to the named instance");
  const pinnedHuman = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller", managerInstanceId: stateA.instanceId },
    asPeer("198.51.100.1"),
  );
  let pinnedHumanValidated: ValidatedUserToken | undefined;
  if (typeof pinnedHuman.body.token === "string") {
    pinnedHumanValidated = await validateUserToken(pinnedHuman.body.token, {
      key: verifyPublicKey,
      issuer: spaceIssuer(space),
      audience: space,
    });
  }
  check(
    "S1.1 pinned human exchange mints 200 scoped to manager A",
    pinnedHuman.status === 200 &&
      pinnedHuman.body.owner === owner &&
      pinnedHuman.body.managerInstanceId === stateA.instanceId &&
      pinnedHumanValidated?.act.view === "manager-caller" &&
      pinnedHumanValidated?.act.managerInstanceId === stateA.instanceId,
    { status: pinnedHuman.status, body: pinnedHuman.body, validated: pinnedHumanValidated },
  );

  const pinnedAgent = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: AGENT, actorToken: secretA.actorToken, view: "manager-caller", managerInstanceId: stateB.instanceId },
    asPeer("198.51.100.1"),
  );
  let pinnedAgentValidated: ValidatedUserToken | undefined;
  if (typeof pinnedAgent.body.token === "string") {
    pinnedAgentValidated = await validateUserToken(pinnedAgent.body.token, {
      key: verifyPublicKey,
      issuer: spaceIssuer(space),
      audience: space,
    });
  }
  check(
    "S1.2 pinned agent exchange mints 200 scoped to manager B",
    pinnedAgent.status === 200 &&
      pinnedAgent.body.owner === owner &&
      pinnedAgent.body.managerInstanceId === stateB.instanceId &&
      pinnedAgentValidated?.act.view === "manager-caller" &&
      pinnedAgentValidated?.act.managerInstanceId === stateB.instanceId,
    { status: pinnedAgent.status, body: pinnedAgent.body, validated: pinnedAgentValidated },
  );

  // ---------- S2. Ambiguous human and agent exchanges refuse with both ids and remedy ----------
  console.log("S2) ambiguous human and agent exchanges refuse with both candidate ids and remedy");
  const ambigHuman = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller" },
    asPeer("198.51.100.2"),
  );
  check(
    "S2.1 ambiguous human exchange refuses 401 with both instance ids and --on <instanceId>",
    ambigHuman.status === 401 &&
      ambigHuman.body.token === undefined &&
      ambigHuman.body.managerInstanceId === undefined &&
      ambigHuman.body.error === expectedHumanAmbiguous,
    ambigHuman,
  );

  const ambigAgent = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: AGENT, actorToken: secretA.actorToken, view: "manager-caller" },
    asPeer("198.51.100.2"),
  );
  check(
    "S2.2 ambiguous agent exchange refuses 401 with both instance ids and --manager-instance <instanceId>",
    ambigAgent.status === 401 &&
      ambigAgent.body.token === undefined &&
      ambigAgent.body.managerInstanceId === undefined &&
      ambigAgent.body.error === expectedAgentAmbiguous,
    ambigAgent,
  );

  const ambigVirgin = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: VIRGIN_AGENT, actorToken: secretVirgin.actorToken, view: "manager-caller" },
    asPeer("198.51.100.2"),
  );
  const adminNc = await connect({
    servers,
    name: "fsel-smoke-cred-check",
    ...standaloneConnectOpts({
      creds: await mintCreds(auth, newIdentity(), "provisioner"),
      tls: false,
    }),
  });
  let mintedMapping: Awaited<ReturnType<typeof readLifecycleMappingLeader>>;
  let virginMapping: Awaited<ReturnType<typeof readLifecycleMappingLeader>>;
  try {
    const reader = await openLifecycleMappingReader(adminNc, space);
    mintedMapping = await readLifecycleMappingLeader(reader, owner, AGENT);
    virginMapping = await readLifecycleMappingLeader(reader, owner, VIRGIN_AGENT);
  } finally {
    await adminNc.close();
  }
  check(
    "S2.3 a refused agent manager-caller selection mints no root connect credential (while S1.2 minted one)",
    ambigVirgin.status === 401 &&
      virginMapping === undefined &&
      typeof mintedMapping?.mapping.currentCredentialId === "string",
    { ambigVirginStatus: ambigVirgin.status, virginMapping, mintedMapping },
  );

  // ---------- S3. >30 ambiguous agent exchanges on one peer do not mask the human's refusal ----------
  console.log("S3) >30 ambiguous agent exchanges from one peer do not mask the human's ambiguous refusal or spend the peer probing budget");
  const sharedPeer = asPeer("203.0.113.10");
  let agentFirst30 = 0;
  let agentBounded5 = 0;
  let agentMaskedPeer429 = 0;
  let lastAgentBurst: { status: number; body: Record<string, unknown> } | undefined;
  for (let i = 0; i < 35; i++) {
    const r = await post(
      `${PUBLIC}/exchange`,
      { owner, actor: AGENT, actorToken: secretA.actorToken, view: "manager-caller" },
      sharedPeer,
    );
    if (i < 29 && r.status === 401 && r.body.error === expectedAgentAmbiguous) agentFirst30++;
    if (i >= 29 && r.status === 429 && r.body.error === expectedSelectionThrottled) agentBounded5++;
    if (r.body.error === "too many refused exchanges - wait a minute and retry") agentMaskedPeer429++;
    lastAgentBurst = r;
  }
  check(
    "S3.1 35 ambiguous agent exchanges from the shared peer (after S2.2's 1st) return 29 actionable 401s + 6 principal-throttled 429s (never masked as peer 429)",
    agentFirst30 === 29 && agentBounded5 === 6 && agentMaskedPeer429 === 0,
    { agentFirst30, agentBounded5, agentMaskedPeer429, lastAgentBurst },
  );

  const humanAfterAgentFlood = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller" },
    sharedPeer,
  );
  check(
    "S3.2 human's ambiguous exchange from the same peer after 35 agent selection refusals still gets 401 with both ids and --on",
    humanAfterAgentFlood.status === 401 && humanAfterAgentFlood.body.error === expectedHumanAmbiguous,
    humanAfterAgentFlood,
  );

  const badCredOnSharedPeer = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: AGENT, actorToken: newActorToken().actorToken, view: "manager-caller" },
    sharedPeer,
  );
  check(
    "S3.3 authenticated selection refusals did not consume the peer's probing budget (first bad credential on that peer is 401, not 429)",
    badCredOnSharedPeer.status === 401 && badCredOnSharedPeer.body.error !== "too many refused exchanges - wait a minute and retry",
    badCredOnSharedPeer,
  );

  // ---------- S4. Unauthorized selections stay refused ----------
  console.log("S4) unauthorized selections stay refused with exact status and reason");
  const foreignPick = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller", managerInstanceId: stateOther.instanceId },
    asPeer("198.51.100.4"),
  );
  check(
    "S4.1 naming another owner's manager instance is refused 401 (not this owner's)",
    foreignPick.status === 401 && foreignPick.body.error === `manager instance ${stateOther.instanceId} is not this owner's`,
    foreignPick,
  );

  const stoppedPick = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller", managerInstanceId: stateStopped.instanceId },
    asPeer("198.51.100.4"),
  );
  check(
    "S4.2 naming an unregistered/stopped manager instance is refused 401 (not registered)",
    stoppedPick.status === 401 && stoppedPick.body.error === `manager instance ${stateStopped.instanceId} is not registered`,
    stoppedPick,
  );

  const malformedPick = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller", managerInstanceId: "bad/id" },
    asPeer("198.51.100.4"),
  );
  check(
    "S4.3 naming a malformed managerInstanceId is refused 401 (invalid managerInstanceId)",
    malformedPick.status === 401 &&
      malformedPick.body.error === "managerInstanceId \"bad/id\" is not a valid lifecycle token ([a-z0-9]{26,32})",
    malformedPick,
  );

  const ungrantedPeer = asPeer("198.51.100.77");
  let ungrantedCred401 = 0;
  let ungrantedSelectionReasons = 0;
  for (let i = 0; i < 30; i++) {
    const r = await post(
      `${PUBLIC}/exchange`,
      { idpToken: idpJwtA, actor: "ungranted_cli", view: "manager-caller" },
      ungrantedPeer,
    );
    if (r.status === 401 && typeof r.body.error === "string" && r.body.error.includes('actor "ungranted_cli" is not granted for this user')) {
      ungrantedCred401++;
    }
    if (typeof r.body.error === "string" && r.body.error.includes("manager-caller selection")) {
      ungrantedSelectionReasons++;
    }
  }
  const ungranted31 = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "ungranted_cli", view: "manager-caller" },
    ungrantedPeer,
  );
  check(
    "S4.4 an IdP-verified subject with an ungranted actor gets the credential refusal, spends the peer bucket (30x 401 then 429), and never receives a selection reason",
    ungrantedCred401 === 30 &&
      ungrantedSelectionReasons === 0 &&
      ungranted31.status === 429 &&
      ungranted31.body.error === "too many refused exchanges - wait a minute and retry",
    { ungrantedCred401, ungrantedSelectionReasons, ungranted31 },
  );

  // ---------- S5. Probing protection unchanged ----------
  console.log("S5) per-peer probing protection for bad credentials holds unchanged");
  const probingPeer = asPeer("203.0.113.55");
  const forgedJwt = `${idpJwtA.split(".").slice(0, 2).join(".")}.${"A".repeat(86)}`;
  const wrongActorToken = newActorToken().actorToken;
  let unthrottledBadCount = 0;
  for (let i = 0; i < 30; i++) {
    const body =
      i % 2 === 0
        ? { idpToken: forgedJwt, actor: "cli", view: "manager-caller" }
        : { owner, actor: AGENT, actorToken: wrongActorToken, view: "manager-caller" };
    const r = await post(`${PUBLIC}/exchange`, body, probingPeer);
    if (r.status === 401 && r.body.error !== "too many refused exchanges - wait a minute and retry") {
      unthrottledBadCount++;
    }
  }
  const bad31Agent = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: AGENT, actorToken: wrongActorToken, view: "manager-caller" },
    probingPeer,
  );
  const bad32Human = await post(
    `${PUBLIC}/exchange`,
    { idpToken: forgedJwt, actor: "cli", view: "manager-caller" },
    probingPeer,
  );
  check(
    "S5.1 30 bad-credential exchanges return 401, and the 31st and 32nd answer 429 and withhold their reason",
    unthrottledBadCount === 30 &&
      bad31Agent.status === 429 &&
      bad31Agent.body.error === "too many refused exchanges - wait a minute and retry" &&
      bad32Human.status === 429 &&
      bad32Human.body.error === "too many refused exchanges - wait a minute and retry",
    { unthrottledBadCount, bad31Agent, bad32Human },
  );

  const cleanPeerBad = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: AGENT, actorToken: wrongActorToken, view: "manager-caller" },
    asPeer("198.51.100.55"),
  );
  check(
    "S5.2 another peer is unaffected while the probing peer is throttled",
    cleanPeerBad.status === 401 && cleanPeerBad.body.error !== "too many refused exchanges - wait a minute and retry",
    cleanPeerBad,
  );

  const validFromThrottledPeer = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller", managerInstanceId: stateA.instanceId },
    probingPeer,
  );
  check(
    "S5.3 a valid pinned exchange from the throttled peer still mints 200",
    validFromThrottledPeer.status === 200 && validFromThrottledPeer.body.managerInstanceId === stateA.instanceId,
    validFromThrottledPeer,
  );

  const selectionFromThrottledPeer = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller" },
    probingPeer,
  );
  check(
    "S5.4 an authenticated selection refusal from a peer with a full probing budget still carries its actionable reason",
    selectionFromThrottledPeer.status === 401 && selectionFromThrottledPeer.body.error === expectedHumanAmbiguous,
    selectionFromThrottledPeer,
  );

  // Loopback face (F2): selection refusals still record into ctx.failures and are masked by the loopback 429 at 30/min.
  const loopbackHeaders = { authorization: `Bearer ${info.cap}` };
  let loopback401 = 0;
  for (let i = 0; i < 30; i++) {
    const r = await post(
      `${info.url}/exchange`,
      { idpToken: idpJwtA, actor: "cli", view: "manager-caller" },
      loopbackHeaders,
    );
    if (r.status === 401 && r.body.error === expectedHumanAmbiguous) loopback401++;
  }
  const loopback31 = await post(
    `${info.url}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller" },
    loopbackHeaders,
  );
  check(
    "S5.5 loopback selection refusals spend the loopback budget and are masked at the limit (30x 401 then 429), leaving the public face untouched",
    loopback401 === 30 &&
      loopback31.status === 429 &&
      loopback31.body.error === "too many refused exchanges - wait a minute and retry",
    { loopback401, loopback31 },
  );

  // ---------- S6. Per-principal bound on authenticated selection refusals ----------
  console.log("S6) authenticated selection refusals check the per-principal class window before selection and shed selectManagerInstance once full");
  const coreReq = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
  const { encodeUser, fmtCreds } = coreReq("@nats-io/jwt");
  const { fromPublic, fromSeed } = coreReq("@nats-io/nkeys");
  const obsIdentity = newIdentity();
  const obsJwt = await encodeUser(
    "fsel-gate-observer",
    fromPublic(obsIdentity.id),
    fromPublic(auth.account.pub),
    { pub: { allow: [">"] }, sub: { allow: [">"] } },
    { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) },
  );
  const obsCreds = new TextDecoder().decode(fmtCreds(obsJwt, fromSeed(new TextEncoder().encode(obsIdentity.seed))));
  const obsNc = await connect({
    servers,
    name: "fsel-gate-observer",
    ...standaloneConnectOpts({ creds: obsCreds, tls: false }),
  });
  let stateAGateReads = 0;
  let stateOtherGateReads = 0;
  let variedGateReads = 0;
  let unpinnedGateScans = 0;
  let ownerCGateReads = 0;
  const authBucketName = epAuthBucket(space);
  const gateTargetKeyA = `$KV.${authBucketName}.epgate.manager.${stateA.instanceId}`;
  const gateTargetKeyOther = `$KV.${authBucketName}.epgate.manager.${stateOther.instanceId}`;
  const variedGatePrefix = `$KV.${authBucketName}.epgate.manager.varyinst`;
  const gateScanFilter = `$KV.${authBucketName}.epgate.manager.>`;
  const gateTargetKeyC1 = `$KV.${authBucketName}.epgate.manager.${stateC1.instanceId}`;
  const gateTargetKeyC2 = `$KV.${authBucketName}.epgate.manager.${stateC2.instanceId}`;
  const dec = new TextDecoder();
  const gateSub = obsNc.subscribe("$JS.API.>", {
    callback: (_err, msg) => {
      const payload = dec.decode(msg.data);
      if (msg.subject.endsWith(`.epgate.manager.${stateA.instanceId}`) || payload.includes(gateTargetKeyA)) {
        stateAGateReads++;
      }
      if (msg.subject.endsWith(`.epgate.manager.${stateOther.instanceId}`) || payload.includes(gateTargetKeyOther)) {
        stateOtherGateReads++;
      }
      if (msg.subject.includes(".epgate.manager.varyinst") || payload.includes(variedGatePrefix)) {
        variedGateReads++;
      }
      if (msg.subject.startsWith("$JS.API.CONSUMER.CREATE.") && payload.includes(gateScanFilter)) {
        unpinnedGateScans++;
      }
      if (
        msg.subject.endsWith(`.epgate.manager.${stateC1.instanceId}`) ||
        payload.includes(gateTargetKeyC1) ||
        msg.subject.endsWith(`.epgate.manager.${stateC2.instanceId}`) ||
        payload.includes(gateTargetKeyC2)
      ) {
        ownerCGateReads++;
      }
    },
  });
  await obsNc.flush();

  const s6Peer = asPeer("198.51.100.88");
  const expectedOtherReason = `manager instance ${stateA.instanceId} is not this owner's`;
  let s6First30 = 0;
  for (let i = 0; i < 30; i++) {
    const r = await post(
      `${PUBLIC}/exchange`,
      { owner: otherOwner, actor: OTHER_AGENT, actorToken: secretOther.actorToken, view: "manager-caller", managerInstanceId: stateA.instanceId },
      s6Peer,
    );
    if (r.status === 401 && r.body.error === expectedOtherReason) s6First30++;
  }
  await obsNc.flush();
  const gateReadsAfter30 = stateAGateReads;
  const s6Refusal31 = await post(
    `${PUBLIC}/exchange`,
    { owner: otherOwner, actor: OTHER_AGENT, actorToken: secretOther.actorToken, view: "manager-caller", managerInstanceId: stateA.instanceId },
    s6Peer,
  );
  await obsNc.flush();
  const gateReadsAfter31 = stateAGateReads;
  check(
    "S6.1 first 30 authenticated selection refusals for one principal return 401 with the actionable reason and perform 30 gate reads",
    s6First30 === 30 && gateReadsAfter30 === 30,
    { s6First30, gateReadsAfter30 },
  );
  check(
    "S6.2 refusal 31 for that principal returns 429 with the pinned remedy and sheds selectManagerInstance (exact gate reads: 30, not 31)",
    s6Refusal31.status === 429 &&
      s6Refusal31.body.error === expectedPinnedSelectionThrottled &&
      gateReadsAfter31 === 30,
    { s6Refusal31, gateReadsAfter30, gateReadsAfter31 },
  );

  const otherPrincipalSamePeer = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtB, actor: "cli", view: "manager-caller", managerInstanceId: stateA.instanceId },
    s6Peer,
  );
  await obsNc.flush();
  const gateReadsAfterOtherPrincipal = stateAGateReads;
  check(
    "S6.3 a different principal from the same peer is not affected by the exhausted principal's selection bound (401 with reason, gate reads 31)",
    otherPrincipalSamePeer.status === 401 &&
      otherPrincipalSamePeer.body.error === expectedOtherReason &&
      gateReadsAfterOtherPrincipal === 31,
    { otherPrincipalSamePeer, gateReadsAfterOtherPrincipal },
  );

  // Keying the human bound by derivedOwner alone prevents dodging the bound across granted actors of the same owner.
  for (let i = 0; i < 29; i++) {
    await post(
      `${PUBLIC}/exchange`,
      { idpToken: idpJwtB, actor: "cli", view: "manager-caller", managerInstanceId: stateA.instanceId },
      s6Peer,
    );
  }
  await obsNc.flush();
  const gateReadsAtHuman30 = stateAGateReads;
  const variedActorHuman31 = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtB, actor: "cli_alt", view: "manager-caller", managerInstanceId: stateA.instanceId },
    s6Peer,
  );
  await obsNc.flush();
  const gateReadsAfterHuman31 = stateAGateReads;
  const ownerAHumanSamePeer = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtA, actor: "cli", view: "manager-caller" },
    s6Peer,
  );
  check(
    "S6.4 human selection bound is keyed by derived owner across granted actors (31st request as cli_alt returns 429 and sheds selection at 60 gate reads; another owner gets 401)",
    variedActorHuman31.status === 429 &&
      variedActorHuman31.body.error === expectedPinnedSelectionThrottled &&
      gateReadsAtHuman30 === 60 &&
      gateReadsAfterHuman31 === 60 &&
      ownerAHumanSamePeer.status === 401 &&
      ownerAHumanSamePeer.body.error === expectedHumanAmbiguous,
    { variedActorHuman31, gateReadsAtHuman30, gateReadsAfterHuman31, ownerAHumanSamePeer },
  );

  // (a) + R4 + R1: Fill human C's unpinned window from a known state (0 earlier refusals).
  // That human's exchange pinned to their own live manager (stateC1) still mints 200, and while the
  // unpinned window is full, unpinned 429s perform 0 gate scans and 0 gate reads.
  const s6PeerA = asPeer("198.51.100.90");
  await obsNc.flush();
  const scansBeforeS65 = unpinnedGateScans;
  const cReadsBeforeS65 = ownerCGateReads;
  let unpinned30 = 0;
  for (let i = 0; i < 30; i++) {
    const r = await post(`${PUBLIC}/exchange`, { idpToken: idpJwtC, actor: "cli", view: "manager-caller" }, s6PeerA);
    if (r.status === 401 && r.body.error === expectedHumanCAmbiguous) unpinned30++;
  }
  await obsNc.flush();
  const unpinnedScansAt30 = unpinnedGateScans - scansBeforeS65;
  const unpinnedReadsAt30 = ownerCGateReads - cReadsBeforeS65;
  const unpinned31 = await post(`${PUBLIC}/exchange`, { idpToken: idpJwtC, actor: "cli", view: "manager-caller" }, s6PeerA);
  await obsNc.flush();
  const unpinnedScansAfter31 = unpinnedGateScans - scansBeforeS65;
  const unpinnedReadsAfter31 = ownerCGateReads - cReadsBeforeS65;
  const pinnedWhileUnpinnedFull = await post(
    `${PUBLIC}/exchange`,
    { idpToken: idpJwtC, actor: "cli", view: "manager-caller", managerInstanceId: stateC1.instanceId },
    s6PeerA,
  );
  await obsNc.flush();
  const scansBefore32 = unpinnedGateScans;
  const cReadsBefore32 = ownerCGateReads;
  const unpinned32 = await post(`${PUBLIC}/exchange`, { idpToken: idpJwtC, actor: "cli", view: "manager-caller" }, s6PeerA);
  await obsNc.flush();
  const scansOn32 = unpinnedGateScans - scansBefore32;
  const readsOn32 = ownerCGateReads - cReadsBefore32;
  check(
    "S6.5 filling a human's unpinned window from zero (30x 401 then 429) leaves that human's exchange pinned to their own live manager unthrottled (mints 200)",
    unpinned30 === 30 &&
      unpinned31.status === 429 &&
      unpinned31.body.error === expectedSelectionThrottled &&
      pinnedWhileUnpinnedFull.status === 200 &&
      pinnedWhileUnpinnedFull.body.owner === ownerC &&
      pinnedWhileUnpinnedFull.body.managerInstanceId === stateC1.instanceId,
    { unpinned30, unpinned31, pinnedWhileUnpinnedFull: { status: pinnedWhileUnpinnedFull.status, error: pinnedWhileUnpinnedFull.body.error } },
  );

  // (b) Fill the pinned window with refused pinned requests; next pinned request is shed with the pinned remedy and no gate read, and an unpinned request is unaffected.
  const s6PeerB = asPeer("198.51.100.91");
  const expectedForeignOther = `manager instance ${stateOther.instanceId} is not this owner's`;
  await obsNc.flush();
  const stateOtherGateReadsBefore = stateOtherGateReads;
  let pinned30 = 0;
  for (let i = 0; i < 30; i++) {
    const r = await post(
      `${PUBLIC}/exchange`,
      { owner, actor: VIRGIN_AGENT, actorToken: secretVirgin.actorToken, view: "manager-caller", managerInstanceId: stateOther.instanceId },
      s6PeerB,
    );
    if (r.status === 401 && r.body.error === expectedForeignOther) pinned30++;
  }
  await obsNc.flush();
  const pinnedGateReadsAt30 = stateOtherGateReads - stateOtherGateReadsBefore;
  const pinned31 = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: VIRGIN_AGENT, actorToken: secretVirgin.actorToken, view: "manager-caller", managerInstanceId: stateOther.instanceId },
    s6PeerB,
  );
  await obsNc.flush();
  const pinnedGateReadsAfter31 = stateOtherGateReads - stateOtherGateReadsBefore;
  const unpinnedWhilePinnedFull = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: VIRGIN_AGENT, actorToken: secretVirgin.actorToken, view: "manager-caller" },
    s6PeerB,
  );
  check(
    "S6.6 filling a principal's pinned window (30x 401, 30 gate reads) sheds the 31st pinned request with the pinned remedy and no gate read while leaving an unpinned request unaffected",
    pinned30 === 30 &&
      pinnedGateReadsAt30 === 30 &&
      pinned31.status === 429 &&
      pinned31.body.error === expectedPinnedSelectionThrottled &&
      pinnedGateReadsAfter31 === 30 &&
      unpinnedWhilePinnedFull.status === 401 &&
      unpinnedWhilePinnedFull.body.error === expectedAgentAmbiguous,
    { pinned30, pinnedGateReadsAt30, pinned31, pinnedGateReadsAfter31, unpinnedWhilePinnedFull },
  );

  const emptyWhilePinnedFull = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: VIRGIN_AGENT, actorToken: secretVirgin.actorToken, view: "manager-caller", managerInstanceId: "" },
    s6PeerB,
  );
  check(
    "E1 present empty managerInstanceId is pinned, so the already-full pinned class returns its 429 remedy",
    emptyWhilePinnedFull.status === 429 && emptyWhilePinnedFull.body.error === expectedPinnedSelectionThrottled,
    { status: emptyWhilePinnedFull.status, error: emptyWhilePinnedFull.body.error },
  );

  // (c) N3: inside one principal's pinned window, vary managerInstanceId on every request; the 31st gets 429 with an exact gate-read count.
  const s6PeerC = asPeer("198.51.100.92");
  let varied30 = 0;
  for (let i = 0; i < 30; i++) {
    const variedId = `varyinst${String(i).padStart(24, "0")}`;
    const r = await post(
      `${PUBLIC}/exchange`,
      { owner, actor: AGENT, actorToken: secretA.actorToken, view: "manager-caller", managerInstanceId: variedId },
      s6PeerC,
    );
    if (r.status === 401 && r.body.error === `manager instance ${variedId} is unknown`) varied30++;
  }
  await obsNc.flush();
  const variedReadsAt30 = variedGateReads;
  const variedId31 = `varyinst${String(30).padStart(24, "0")}`;
  const varied31 = await post(
    `${PUBLIC}/exchange`,
    { owner, actor: AGENT, actorToken: secretA.actorToken, view: "manager-caller", managerInstanceId: variedId31 },
    s6PeerC,
  );
  await obsNc.flush();
  const variedReadsAfter31 = variedGateReads;
  gateSub.unsubscribe();
  await obsNc.close();
  check(
    "S6.7 varying managerInstanceId on every request inside one principal's pinned window still fills that window at 30 (exact gate reads: 30) and sheds the 31st with 429",
    varied30 === 30 &&
      variedReadsAt30 === 30 &&
      varied31.status === 429 &&
      varied31.body.error === expectedPinnedSelectionThrottled &&
      variedReadsAfter31 === 30,
    { varied30, variedReadsAt30, varied31, variedReadsAfter31 },
  );

  check(
    "S6.8 a full unpinned window sheds selectManagerInstance (30 gate scans and 60 gate reads across the 30 in-window refusals; 0 scans and 0 gate reads on the 31st and 32nd unpinned 429s)",
    unpinnedScansAt30 === 30 &&
      unpinnedReadsAt30 === 60 &&
      unpinnedScansAfter31 === 30 &&
      unpinnedReadsAfter31 === 60 &&
      unpinned32.status === 429 &&
      unpinned32.body.error === expectedSelectionThrottled &&
      scansOn32 === 0 &&
      readsOn32 === 0,
    { unpinnedScansAt30, unpinnedReadsAt30, unpinnedScansAfter31, unpinnedReadsAfter31, unpinned32, scansOn32, readsOn32 },
  );
} finally {
  await managerB?.stop({ withAgents: true }).catch(() => {});
  await managerA?.stop({ withAgents: true }).catch(() => {});
  await delivery?.stop().catch(() => {});
  authChild?.kill("SIGKILL");
  broker?.kill("SIGKILL");
  idpServer?.close();
  await wait(200);
  rmSync(scratch, { recursive: true, force: true });
}

const EXPECTED = 26;
console.log(`\nmanager-selection-refusals smoke: ${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED) {
  console.error(`  ✗ FAIL: expected ${EXPECTED} cells, ran ${pass + fail}`);
  process.exit(1);
}
if (fail > 0) process.exit(1);
