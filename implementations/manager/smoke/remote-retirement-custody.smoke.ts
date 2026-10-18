/**
 * Upstream Cotal#4005 Phase 1c reproduction smoke:
 * Managed lifecycles provisioned by a user-mode manager with a remoteAuthority must reach
 * terminal retirement once their seat is gone, across every manager exit and restart path:
 *
 * - (a-inproc) control: `stop()` without `withAgents` on built-in in-process `pty`
 *   (`LegacyPtyRuntime`, no `release()`): `stopOnce(false)` routes through
 *   `teardownManagedAgents(inProcess)` rather than `releaseManagedAgents()`, so the lifecycle
 *   IS retired (cannot be made red on in-process `pty`).
 * - (a) `stop()` without `withAgents` on a detachable runtime (`CustodialPtyRuntime`) releases
 *   custody via `releaseManagedAgents()`, and the seat later exits.
 * - (b) a signal (`stop()`) after a partial preservation (`preparePreservation` without
 *   `commitPreservation`, entering `stopRetainedAgentsOnExit()`).
 * - (c1) a manager killed hard (`SIGKILL`) with a live `pty` seat.
 * - (c2) a manager killed hard (`SIGKILL`) while a `pty` seat is in the in-memory `retiring` map
 *   before `prepareAgentRetirement` / `requestRetirement` reaches the host.
 * - (d) a preserved inventory (`preparePreservation` + `commitPreservation`) that is never
 *   resumed while a new manager starts on the same root.
 * - (e) an enrollment reply lost after the host committed the grant and `dm_`/`dlv_` durables
 *   before the manager wrote its first post-response slot (`enrollUserAgent`).
 * - (f) an owned, live, same-start process under an injected `EACCES` on `/proc/<pid>/stat`
 *   during `requireRuntimeReap` / `reapSeat` (must fail closed, never report `reaped`).
 * - (g1) guard: a successor manager starts while a released custodial seat is STILL ALIVE:
 *   it must not retire the live seat, and head, grant, and `dm_`/`dlv_` durables stay live.
 * - (g2) guard: a `resumePreserved` adoption (`resumePreserved` -> `commitResume` ->
 *   `finalizeResume`) keeps the adopted seat's lifecycle head active, grant unrevoked, and
 *   `dm_`/`dlv_` durables present.
 * - (g3) guard: a cross-owner delegated launch (`delegatedIntent`) executed by a `p_...`
 *   platform control manager for a distinct `u_...` user owner stays held (`prepareAgentRetirement`
 *   refused on `driveDeprovision` and on successor platform manager startup).
 */

const subcommand = process.argv[2] ?? "";
if (subcommand === "agent-bearer" || subcommand === "auth-service") {
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

if (subcommand === "seat") {
  const { CotalEndpoint } = await import("@cotal-ai/core");
  const { execFile } = await import("node:child_process");
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const e = process.env;
  const argv = JSON.parse(e.COTAL_BEARER_CMD!) as string[];
  const bearer = () =>
    new Promise<string>((resolve, reject) =>
      execFile(argv[0]!, argv.slice(1), { timeout: 15_000 }, (error, stdout) => {
        if (error) reject(new Error("seat bearer exchange refused"));
        else resolve(stdout.trim());
      }),
    );
  const endpoint = new CotalEndpoint({
    space: e.COTAL_SPACE!,
    servers: e.COTAL_SERVERS!,
    bearer,
    sentinelCreds: readFileSync(e.COTAL_SENTINEL_CREDS!, "utf8"),
    lifecycleUid: e.COTAL_LIFECYCLE_UID!,
    channels: [],
    consume: false,
    watchChannels: false,
    card: { owner: e.COTAL_OWNER!, actor: e.COTAL_ACTOR!, name: e.COTAL_NAME!, kind: "agent" },
  });
  endpoint.on("error", () => {});
  await endpoint.start();
  if (e.U4005_SEAT_PID_FILE) {
    writeFileSync(e.U4005_SEAT_PID_FILE, JSON.stringify({ pid: process.pid, uid: e.COTAL_LIFECYCLE_UID, actor: e.COTAL_ACTOR }));
  }
  const stop = () => {
    clearInterval(poller);
    void endpoint.stop().finally(() => process.exit(0));
  };
  const poller = setInterval(() => {
    if (e.U4005_SEAT_EXIT_FILE && existsSync(e.U4005_SEAT_EXIT_FILE)) {
      stop();
    }
  }, 50);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  await new Promise(() => {});
}

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import fsDefault from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager, JetStreamApiCodes, JetStreamApiError } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  CotalEndpoint,
  createSpaceAuth,
  credsClaims,
  dlvDurable,
  dlvStream,
  dmDurable,
  dmStream,
  epAuthBucket,
  eventChannel,
  headCandidate,
  isReachable,
  MANAGER_LEASE_KEY,
  managerBucket,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  parseRemoteDelegatedUserIntentExecutionResult,
  presenceBucket,
  provisionAgentDurables,
  recordsBucket,
  registry,
  remoteManagerActors,
  remoteManagerRegistrationProof,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  type Connector,
  type PlatformControlAssignment,
  type RemoteDelegatedUserIntentExecutionRequest,
  type RuntimeProvider,
  type SecretStore,
} from "@cotal-ai/core";
import {
  assertUserAuthInfo,
  authDir,
  recordMesh,
  saveSpaceAuth,
  userAuthStateDir,
  workspaceSecretStore,
} from "@cotal-ai/workspace";
import {
  authorizeDelegatedUserIntentAdmission,
  authorizeDelegatedUserIntentExecution,
  cotalAuthProvider,
  deriveOwnerForIdpSubject,
  findManagedActor,
  grantActor,
  grantManagedActor,
  loadAuthServiceInfo,
  loadCalloutAuth,
  loadOwnerSecret,
  loadPinnedIdp,
  platformControlOwner,
  saveAuthServiceInfo,
  saveIdpSession,
  startAuthService,
  type AuthServiceHandle,
  type DelegatedUserIntentRecord,
} from "@cotal-ai/auth";
import { bootToken, drainSeats, processStartToken, readRecord, recordPath, seatId, socketPath, type SeatRecord } from "@cotal-ai/seat";
import { probeRecordedProcess } from "../src/user-slot-custody.js";
import { Manager, type ManagerOptions } from "../src/manager.js";
import { requireRuntimeReap } from "../src/runtime/index.js";
import { CustodialPtyRuntime } from "../src/runtime/custodial-pty.js";
import { staticLifecycleTransport } from "../src/static-lifecycle.js";
import { managerClusterArtifacts } from "../src/manager-service-contract.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";
import * as remote from "../src/remote-authority.js";
import "@cotal-ai/runtime";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const here = import.meta.dirname;
const self = resolve(here, "remote-retirement-custody.smoke.ts");

function makeInjectedWorkspaceStore(root: string, spaceName: string): SecretStore {
  const base = workspaceSecretStore(root);
  return {
    identity: { kind: "injected", coordinate: `u4005:${spaceName}` },
    get: (k) => base.get(k),
    put: (k, v) => base.put(k, v),
    create: (k, v) => base.create(k, v),
    delete: (k) => base.delete(k),
  };
}

if (subcommand === "manager-child") {
  const cfg = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as {
    mode: "sigkill-active" | "sigkill-retiring";
    space: string;
    servers: string;
    hostRoot: string;
    wsRoot: string;
    home: string;
    seatName: string;
    stateFile: string;
    seatPidFile: string;
    seatExitFile: string;
  };
  process.env.COTAL_HOME = cfg.home;
  const hostDir = userAuthStateDir(cfg.hostRoot, cfg.space);
  const hostStore = makeInjectedWorkspaceStore(cfg.hostRoot, cfg.space);
  const info = loadAuthServiceInfo(hostDir)!;
  const pin = loadPinnedIdp(hostDir)!;
  const secret = (await loadOwnerSecret(hostStore, cfg.space))!;
  const sessionRaw = JSON.parse(readFileSync(join(cfg.home, "idp-sub.json"), "utf8")) as { sub: string };
  const owner = deriveOwnerForIdpSubject(secret, pin.issuer, sessionRaw.sub);
  const callArgs = { store: hostStore, dir: hostDir };
  const callAuthority = (request: Parameters<NonNullable<typeof cotalAuthProvider.managerServiceAuthority>>[0]["request"]) =>
    cotalAuthProvider.managerServiceAuthority!({ ...callArgs, request });

  const connector: Connector = {
    kind: "connector",
    name: "u4005-seat",
    requires: ["node"],
    eventChannel,
    buildLaunch: (o) => {
      assert(o.userAuth && o.lifecycleUid);
      const env: Record<string, string> = {};
      for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "COTAL_SKIP_CONNECTOR_SEED"]) {
        if (process.env[key]) env[key] = process.env[key]!;
      }
      return {
        command: process.execPath,
        args: [...process.execArgv, self, "seat"],
        env: {
          ...env,
          COTAL_SPACE: o.space,
          COTAL_SERVERS: cfg.servers,
          COTAL_OWNER: o.userAuth.owner,
          COTAL_ACTOR: o.userAuth.actor,
          COTAL_NAME: o.name,
          COTAL_LIFECYCLE_UID: o.lifecycleUid,
          COTAL_SENTINEL_CREDS: o.userAuth.sentinelCredsPath,
          COTAL_BEARER_CMD: JSON.stringify(o.userAuth.bearerCmd),
          U4005_SEAT_PID_FILE: cfg.seatPidFile,
          U4005_SEAT_EXIT_FILE: cfg.seatExitFile,
        },
      };
    },
  };
  registry.register(connector);

  const state = remote.loadOrCreateRemoteManagerIdentity(cfg.wsRoot, cfg.space);
  const prep = await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
  const supervisorCreds = remote.materialCredential(prep, "supervisor", state.identities.supervisor);
  const executorCreds = remote.materialCredential(prep, "executor", state.identities.executor);
  const registered = await registerRemoteManagerAuthority({
    space: cfg.space,
    server: cfg.servers,
    owner,
    instanceId: state.instanceId,
    serveActor: remoteManagerActors(state.instanceId).serve,
    prepareCreds: executorCreds,
    tlsRequired: false,
    evict: async (principals) => {
      const request = remote.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
      const result = await cotalAuthProvider.maintainRemoteManager!({ ...callArgs, request });
      return remote.remoteManagerMaintenanceResult(result, request, owner).evictions!.map((e) => e.verifiedGone);
    },
  });
  const artifacts = managerClusterArtifacts();
  const contractArtifacts = [artifacts.document, artifacts.manifest];
  const activate = await callAuthority(
    remote.remoteManagerAuthorityRequest(state, "cli", "activate", {
      registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts),
      contractArtifacts,
    }),
  );
  const proof = remote.currentRegistrationProof(activate);
  const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: callAuthority });
  const remoteAuthority: NonNullable<ManagerOptions["remoteAuthority"]> = {
    ...standing,
    owner,
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
        await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })),
        "executor",
        state.identities.executor,
      ),
    authorizeAdmin: async (caller) => {
      const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
      const response = await cotalAuthProvider.authorizeRemoteManagerAdmin!({ ...callArgs, request });
      return remote.remoteManagerAdminAuthorized(response, request, owner);
    },
    enrollManagedAgent: async ({ target }) => {
      const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target);
      return remote.remoteManagedAgentEnrollmentMaterial(await cotalAuthProvider.enrollRemoteManagedAgent!({ ...callArgs, request }), request);
    },
    prepareAgentRetirement: async ({ target, opId }) => {
      if (cfg.mode === "sigkill-retiring") {
        const retiringMap = (mgr as unknown as { retiring: Map<string, { opId: string; target: { lifecycleUid: string } }> }).retiring;
        const hold = retiringMap.get(cfg.seatName);
        writeFileSync(
          cfg.stateFile,
          JSON.stringify({
            phase: "retiring-in-memory",
            managerPid: process.pid,
            lifecycleUid: target.lifecycleUid,
            retiringMapHasSeat: hold !== undefined && hold.target.lifecycleUid === target.lifecycleUid,
            opId,
          }),
        );
        await new Promise(() => {});
      }
      const request = remote.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, registered.processEpoch, target, opId);
      remote.remoteManagedAgentRetirementPrepared(await cotalAuthProvider.prepareRemoteManagedAgentRetirement!({ ...callArgs, request }), request);
    },
    mintRetirementRequester: async ({ identity, target, opId, serveEpoch }) =>
      remote.materialCredential(
        await callAuthority(
          remote.remoteManagerAuthorityRequest(state, "cli", "retire", {
            registrationProof: remoteManagerRegistrationProof(owner, state),
            retirement: { id: identity.id, target, opId, serveEpoch },
          }),
        ),
        "retirementRequester",
        identity,
      ),
    mintSessionServing: async () => {
      throw new Error("unused");
    },
    validateRetainedAgent: async (a) => {
      const request = remote.remoteRetainedAgentValidationRequest(state, "cli", proof, registered.processEpoch, { owner: a.owner, actor: a.actor, lifecycleUid: a.lifecycleUid }, a.actorToken, a.sentinelCreds);
      return remote.retainedAgentAuthority(await cotalAuthProvider.validateRemoteRetainedAgent!({ ...callArgs, request }), request);
    },
    scanGoalIndex: async () => {
      const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
      return remote.remoteManagerGoalIndexEntries(await cotalAuthProvider.scanRemoteManagerGoalIndex!({ ...callArgs, request }), request, owner);
    },
  };

  const mgr = new Manager({ space: cfg.space, servers: cfg.servers, workspaceRoot: cfg.wsRoot, runtime: "pty", remoteAuthority, eventsRequired: true });
  await mgr.start();
  const started = await mgr.startAgent({ name: cfg.seatName, agent: "u4005-seat" });
  if (!started.ok) throw new Error(`manager-child startAgent failed: ${started.error}`);
  const managedRow = (mgr as unknown as { agents: Map<string, { lifecycleUid: string; handle: { pid?: number } }> }).agents.get(cfg.seatName)!;
  if (cfg.mode === "sigkill-active") {
    writeFileSync(
      cfg.stateFile,
      JSON.stringify({
        phase: "active",
        managerPid: process.pid,
        seatPid: managedRow.handle.pid,
        lifecycleUid: managedRow.lifecycleUid,
      }),
    );
  } else {
    writeFileSync(cfg.seatExitFile, "exit");
  }
  await new Promise(() => {});
}

// Main smoke runner
for (const key of Object.keys(process.env)) {
  if (key.startsWith("COTAL_") || key.startsWith("JCODE_COTAL_")) delete process.env[key];
}

const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}u4005-`));
const home = join(scratch, "home");
const hostRoot = join(scratch, "host");
const seatRoot = mkdtempSync(join(tmpdir(), "s"));
for (const dir of [home, hostRoot]) mkdirSync(join(dir, ".cotal"), { recursive: true });
process.env.COTAL_HOME = home;
process.env.COTAL_SEAT_ROOT = seatRoot;

const space = `u4005${mintLifecycleUid().slice(0, 8)}`;
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const hostDir = userAuthStateDir(hostRoot, space);
const hostStore = makeInjectedWorkspaceStore(hostRoot, space);

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, label: string, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timeout waiting for: ${label}`);
    await wait(100);
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.lastIndexOf(") ");
    if (after >= 0 && stat.slice(after + 2, after + 3) === "Z") return false;
    return true;
  } catch {
    return false;
  }
}

interface CellAssertionRecord {
  cell: string;
  kind: "setup" | "repro" | "contract" | "guard";
  name: string;
  passed: boolean;
  detail?: unknown;
}

const records: CellAssertionRecord[] = [];
let setupPass = 0;
let setupFail = 0;
let reproPass = 0;
let reproFail = 0;
let contractPass = 0;
let contractFail = 0;
let guardPass = 0;
let guardFail = 0;

function checkSetup(cell: string, name: string, condition: boolean, detail?: unknown): void {
  records.push({ cell, kind: "setup", name, passed: condition, detail });
  if (condition) {
    setupPass++;
    console.log(`  ✓ [${cell}:setup] ${name}`);
  } else {
    setupFail++;
    console.error(`  ✗ FAIL [${cell}:setup] ${name}`, detail ?? "");
  }
}

function checkRepro(cell: string, name: string, condition: boolean, detail?: unknown): void {
  records.push({ cell, kind: "repro", name, passed: condition, detail });
  if (condition) {
    reproPass++;
    console.log(`  ✓ [${cell}:repro] ${name}`);
  } else {
    reproFail++;
    console.error(`  ✗ FAIL [${cell}:repro] ${name}`, detail ?? "");
  }
}

function checkGuard(cell: string, name: string, condition: boolean, detail?: unknown): void {
  records.push({ cell, kind: "guard", name, passed: condition, detail });
  if (condition) {
    guardPass++;
    console.log(`  ✓ [${cell}:guard] ${name}`);
  } else {
    guardFail++;
    console.error(`  ✗ FAIL [${cell}:guard] ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

function checkContract(cell: string, name: string, condition: boolean, detail?: unknown): void {
  records.push({ cell, kind: "contract", name, passed: condition, detail });
  if (condition) {
    contractPass++;
    console.log(`  ✓ [${cell}:contract] ${name}`);
  } else {
    contractFail++;
    console.error(`  ✗ RED [${cell}:contract] ${name}`, detail ?? "");
  }
}

let broker: ChildProcess | undefined;
let authService: AuthServiceHandle | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let idpServer: ReturnType<typeof createServer> | undefined;
let inspectNc: Awaited<ReturnType<typeof connect>> | undefined;
let supNc: Awaited<ReturnType<typeof connect>> | undefined;

try {
  const betterRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);
  const { betterAuth } = await import(new URL("dist/index.mjs", betterRoot).href);
  const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterRoot).href);
  const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterRoot).href);
  const { bearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterRoot).href);
  const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterRoot).href);

  let handler!: ReturnType<typeof toNodeHandler>;
  idpServer = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => idpServer!.listen(0, "127.0.0.1", r));
  const address = idpServer.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const idpUrl = `${origin}/api/auth`;
  const idp = betterAuth({
    baseURL: origin,
    secret: "u4005-disposable-fixture-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
    emailAndPassword: { enabled: true },
    plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), bearer()],
  });
  handler = toNodeHandler(idp);
  const signup = await idp.api.signUpEmail({
    body: { email: "owner-u4005@example.test", password: "native-fixture-password", name: "Fixture Owner" },
  });
  assert(signup.token && signup.user.id);
  saveIdpSession(home, idpUrl, { token: signup.token, sub: signup.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  writeFileSync(join(home, "idp-sub.json"), JSON.stringify({ sub: signup.user.id }));

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
    serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(scratch, "js"), extraAccounts: prepared.extraAccounts }),
  );
  broker = spawn("nats-server", ["-c", join(scratch, "server.conf")], { stdio: "ignore" });
  teardownOnSignal(broker, scratch);
  await until(() => isReachable(servers), "broker readiness");

  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provCreds });
  inspectNc = await connect({ servers, ...standaloneConnectOpts({ creds: provCreds, tls: false }), maxReconnectAttempts: 0 });
  const jsm = await jetstreamManager(inspectNc);
  const kvm = new Kvm(inspectNc);
  const recordsKv = await kvm.open(recordsBucket(space));
  const authKv = await kvm.open(epAuthBucket(space));
  const supCreds = await mintCreds(auth, newIdentity(), "supervisor");
  supNc = await connect({ servers, ...standaloneConnectOpts({ creds: supCreds, tls: false }), maxReconnectAttempts: 0 });
  const managerKv = await new Kvm(supNc).open(managerBucket(space));
  const lifecycleTransport = staticLifecycleTransport(recordsKv, authKv);

  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: hostStore.identity! });
  let currentPlatformAssignment: PlatformControlAssignment | null = null;
  authService = await startAuthService({
    context: { accountPublicKey: auth.account.pub, lifecycleUid: mintLifecycleUid() },
    space,
    servers,
    stateDir: hostDir,
    store: hostStore,
    storeIdentity: hostStore.identity!,
    publicFace: { port: 0, trustedProxy: false },
    platformControl: { observeAssignment: async () => currentPlatformAssignment },
  });
  saveAuthServiceInfo(hostDir, {
    url: authService.url,
    pid: process.pid,
    cap: authService.cap,
    ...(authService.publicUrl !== undefined ? { publicUrl: authService.publicUrl } : {}),
  });

  const info = loadAuthServiceInfo(hostDir)!;
  const pin = loadPinnedIdp(hostDir)!;
  const secret = (await loadOwnerSecret(hostStore, space))!;
  const calloutAuth = (await loadCalloutAuth(hostStore, space))!;
  const owner = deriveOwnerForIdpSubject(secret, pin.issuer, signup.user.id);
  const platformOwner = platformControlOwner(secret, space, auth.account.pub);
  grantActor(hostDir, {
    owner,
    actor: "cli",
    scope: ["spawn", "run", "supervise", "admin"],
    allowSubscribe: [">"],
    allowPublish: [">"],
    label: "disposable u4005 operator",
  });

  const custodialProvider: RuntimeProvider = {
    kind: "runtime",
    name: "custodial-pty",
    available: () => true,
    create: () => new CustodialPtyRuntime(seatRoot),
  };
  registry.register(custodialProvider);

  const seatControls = new Map<string, { pidFile: string; exitFile: string }>();
  const connector: Connector = {
    kind: "connector",
    name: "u4005-seat",
    requires: ["node"],
    eventChannel,
    buildLaunch: (o) => {
      assert(o.userAuth && o.lifecycleUid);
      const ctl = seatControls.get(o.name) ?? {
        pidFile: join(scratch, `${o.name}.pid.json`),
        exitFile: join(scratch, `${o.name}.exit`),
      };
      seatControls.set(o.name, ctl);
      const env: Record<string, string> = {};
      for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "COTAL_SKIP_CONNECTOR_SEED"]) {
        if (process.env[key]) env[key] = process.env[key]!;
      }
      return {
        command: process.execPath,
        args: [...process.execArgv, self, "seat"],
        env: {
          ...env,
          COTAL_SPACE: o.space,
          COTAL_SERVERS: servers,
          COTAL_OWNER: o.userAuth.owner,
          COTAL_ACTOR: o.userAuth.actor,
          COTAL_NAME: o.name,
          COTAL_LIFECYCLE_UID: o.lifecycleUid,
          COTAL_SENTINEL_CREDS: o.userAuth.sentinelCredsPath,
          COTAL_BEARER_CMD: JSON.stringify(o.userAuth.bearerCmd),
          U4005_SEAT_PID_FILE: ctl.pidFile,
          U4005_SEAT_EXIT_FILE: ctl.exitFile,
        },
      };
    },
  };
  registry.register(connector);

  const prepareCounts = new Map<string, number>();
  const retireCounts = new Map<string, number>();
  const countKey = (actor: string, uid: string) => `${actor}:${uid}`;

  async function inspectLifecycleState(actor: string, uid: string, targetOwner = owner) {
    const head = await headCandidate(lifecycleTransport, targetOwner, actor);
    const grant = findManagedActor(hostDir, targetOwner, actor);
    const consumerPresent = async (stream: string, durable: string): Promise<boolean> => {
      try {
        await jsm.consumers.info(stream, durable);
        return true;
      } catch (e) {
        if (e instanceof JetStreamApiError && e.code === JetStreamApiCodes.ConsumerNotFound) return false;
        throw e;
      }
    };
    const dmPresent = await consumerPresent(dmStream(space), dmDurable(targetOwner, actor, uid));
    const dlvPresent = await consumerPresent(dlvStream(space), dlvDurable(targetOwner, actor, uid));
    const prepareRetirementCalls = prepareCounts.get(countKey(actor, uid)) ?? 0;
    const retireCalls = retireCounts.get(countKey(actor, uid)) ?? 0;
    return {
      headState: head?.mapping.state,
      headUid: head?.mapping.lifecycleUid,
      headOp: head?.mapping.op,
      grantUnrevoked: grant !== undefined && grant.lifecycleUid === uid,
      dmPresent,
      dlvPresent,
      prepareRetirementCalls,
      retireCalls,
    };
  }

  function createWorkspaceRoot(label: string, seatNames: string[]): string {
    const ws = join(scratch, `ws-${label}`);
    mkdirSync(join(ws, ".cotal", "agents"), { recursive: true });
    recordMesh({
      space,
      server: servers,
      root: ws,
      mode: "user",
      policy: { events: "required" },
      userAuth: assertUserAuthInfo(prepared.publicAuth),
      ts: new Date().toISOString(),
    });
    for (const seatName of seatNames) {
      writeFileSync(
        join(ws, ".cotal", "agents", `${seatName}.md`),
        `---
name: ${seatName}
agent: u4005-seat
role: worker
subscribe: []
allowSubscribe: []
allowPublish: []
---
Seat ${seatName}.
`,
      );
    }
    return ws;
  }

  const callArgs = { store: hostStore, dir: hostDir };
  const callAuthority = (request: Parameters<NonNullable<typeof cotalAuthProvider.managerServiceAuthority>>[0]["request"]) =>
    cotalAuthProvider.managerServiceAuthority!({ ...callArgs, request });

  async function bootRemoteManagerOnRoot(
    wsRoot: string,
    runtime: "pty" | "custodial-pty",
    resumeAttemptId?: string,
    onAfterHostEnrollmentCommit?: (material: { actor: string; lifecycleUid: string }) => void,
  ) {
    const state = remote.loadOrCreateRemoteManagerIdentity(wsRoot, space);
    const prep = await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
    const supervisorCreds = remote.materialCredential(prep, "supervisor", state.identities.supervisor);
    const executorCreds = remote.materialCredential(prep, "executor", state.identities.executor);
    const registered = await registerRemoteManagerAuthority({
      space,
      server: servers,
      owner,
      instanceId: state.instanceId,
      serveActor: remoteManagerActors(state.instanceId).serve,
      prepareCreds: executorCreds,
      tlsRequired: false,
      evict: async (principals) => {
        const request = remote.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
        const result = await cotalAuthProvider.maintainRemoteManager!({ ...callArgs, request });
        return remote.remoteManagerMaintenanceResult(result, request, owner).evictions!.map((e) => e.verifiedGone);
      },
    });
    const artifacts = managerClusterArtifacts();
    const contractArtifacts = [artifacts.document, artifacts.manifest];
    const activate = await callAuthority(
      remote.remoteManagerAuthorityRequest(state, "cli", "activate", {
        registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts),
        contractArtifacts,
      }),
    );
    const proof = remote.currentRegistrationProof(activate);
    const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: callAuthority });
    const remoteAuthority: NonNullable<ManagerOptions["remoteAuthority"]> = {
      ...standing,
      owner,
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
          await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })),
          "executor",
          state.identities.executor,
        ),
      authorizeAdmin: async (caller) => {
        const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
        const response = await cotalAuthProvider.authorizeRemoteManagerAdmin!({ ...callArgs, request });
        return remote.remoteManagerAdminAuthorized(response, request, owner);
      },
      enrollManagedAgent: async ({ target }) => {
        const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target);
        const material = remote.remoteManagedAgentEnrollmentMaterial(
          await cotalAuthProvider.enrollRemoteManagedAgent!({ ...callArgs, request }),
          request,
        );
        onAfterHostEnrollmentCommit?.(material);
        return material;
      },
      prepareAgentRetirement: async ({ target, opId }) => {
        const k = countKey(target.actor, target.lifecycleUid);
        prepareCounts.set(k, (prepareCounts.get(k) ?? 0) + 1);
        const request = remote.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, registered.processEpoch, target, opId);
        remote.remoteManagedAgentRetirementPrepared(await cotalAuthProvider.prepareRemoteManagedAgentRetirement!({ ...callArgs, request }), request);
      },
      mintRetirementRequester: async ({ identity, target, opId, serveEpoch }) => {
        const k = countKey(target.actor, target.lifecycleUid);
        retireCounts.set(k, (retireCounts.get(k) ?? 0) + 1);
        return remote.materialCredential(
          await callAuthority(
            remote.remoteManagerAuthorityRequest(state, "cli", "retire", {
              registrationProof: remoteManagerRegistrationProof(owner, state),
              retirement: { id: identity.id, target, opId, serveEpoch },
            }),
          ),
          "retirementRequester",
          identity,
        );
      },
      mintSessionServing: async () => {
        throw new Error("unused");
      },
      validateRetainedAgent: async (a) => {
        const request = remote.remoteRetainedAgentValidationRequest(state, "cli", proof, registered.processEpoch, { owner: a.owner, actor: a.actor, lifecycleUid: a.lifecycleUid }, a.actorToken, a.sentinelCreds);
        return remote.retainedAgentAuthority(await cotalAuthProvider.validateRemoteRetainedAgent!({ ...callArgs, request }), request);
      },
      scanGoalIndex: async () => {
        const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
        return remote.remoteManagerGoalIndexEntries(await cotalAuthProvider.scanRemoteManagerGoalIndex!({ ...callArgs, request }), request, owner);
      },
    };
    const mgr = new Manager({
      space,
      servers,
      workspaceRoot: wsRoot,
      runtime,
      remoteAuthority,
      eventsRequired: true,
      ...(resumeAttemptId ? { resumeAttemptId } : {}),
    });
    await mgr.start();
    return { mgr, state };
  }

  /** Boot a platform-control manager (`remoteAuthority.owner === platformOwner = p_...`) that
   *  executes delegated user intents for the distinct human user `owner = u_...` via the shipped
   *  `authorizeDelegatedUserIntentExecution` + `activateManagedLifecycle` + `grantManagedActor` +
   *  `provisionAgentDurables` stack (SPEC §13.16). */
  async function bootPlatformControlManagerOnRoot(
    wsRoot: string,
    runtime: "pty" | "custodial-pty",
    getAdmittedIntent: () => DelegatedUserIntentRecord | null,
  ) {
    const state = remote.loadOrCreateRemoteManagerIdentity(wsRoot, space);
    currentPlatformAssignment = {
      v: 1,
      space,
      accountPublicKey: auth.account.pub,
      instanceId: state.instanceId,
      lifecycleUid: state.lifecycleUid,
      assignmentRevision: 1,
      state: "assigned",
    };
    const callPlatform = <R extends Parameters<NonNullable<AuthServiceHandle["platformControlAuthority"]>>[0]["request"]>(request: R) =>
      authService!.platformControlAuthority!({
        v: 1,
        kind: "platform-control-authority",
        space,
        accountPublicKey: auth.account.pub,
        assignmentRevision: 1,
        request,
      });
    const prep = await callPlatform(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
    const supervisorCreds = remote.materialCredential(prep, "supervisor", state.identities.supervisor);
    const executorCreds = remote.materialCredential(prep, "executor", state.identities.executor);
    const registered = await registerRemoteManagerAuthority({
      space,
      server: servers,
      owner: platformOwner,
      instanceId: state.instanceId,
      serveActor: remoteManagerActors(state.instanceId).serve,
      prepareCreds: executorCreds,
      tlsRequired: false,
      evict: async (principals) => {
        const request = remote.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
        const result = await callPlatform(request);
        return remote.remoteManagerMaintenanceResult(result, request, platformOwner).evictions!.map((e) => e.verifiedGone);
      },
    });
    const artifacts = managerClusterArtifacts();
    const contractArtifacts = [artifacts.document, artifacts.manifest];
    const activate = await callPlatform(
      remote.remoteManagerAuthorityRequest(state, "cli", "activate", {
        registrationProof: remoteManagerRegistrationProof(platformOwner, state, contractArtifacts),
        contractArtifacts,
      }),
    );
    const proof = remote.currentRegistrationProof(activate);
    const standing = remote.remoteStandingBundleRenewal({ state, owner: platformOwner, registrationProof: proof, supervisorCreds, call: callPlatform });
    const remoteAuthority: NonNullable<ManagerOptions["remoteAuthority"]> = {
      ...standing,
      owner: platformOwner,
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
          await callPlatform(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })),
          "executor",
          state.identities.executor,
        ),
      authorizeAdmin: async (caller) => {
        const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
        const response = await callPlatform(request);
        return remote.remoteManagerAdminAuthorized(response, request, platformOwner);
      },
      executeDelegatedUserIntent: async (exec) => {
        if (exec.operation !== "launch") throw new Error("unexpected delegated operation in guard fixture");
        const execReq: RemoteDelegatedUserIntentExecutionRequest = {
          v: 1,
          kind: "manager-delegated-user-intent-execution",
          space,
          actor: "cli",
          accountPublicKey: auth.account.pub,
          assignmentRevision: currentPlatformAssignment!.assignmentRevision,
          instanceId: state.instanceId,
          managerLifecycleUid: state.lifecycleUid,
          requestId: `exec${mintLifecycleUid()}`,
          registrationProof: proof,
          serveEpoch: registered.processEpoch,
          identities: remote.publicIdentities(state),
          intentId: exec.intentId,
          execute: { operation: "launch", target: exec.target },
        };
        const decision = await authorizeDelegatedUserIntentExecution({
          request: execReq,
          space,
          accountPublicKey: auth.account.pub,
          platformOwner,
          intent: getAdmittedIntent(),
          observeAssignment: async () => currentPlatformAssignment,
          observeManagerGate: authService!.observeManagerGate!,
          proofSecret: auth.account.signingSeed!,
          now: Date.now(),
        });
        assert.equal(decision.operation, "launch");
        const target = decision.target as import("@cotal-ai/core").DelegatedUserLaunchTarget;
        const lifecycleUid = mintLifecycleUid();
        await authService!.activateManagedLifecycle!({
          owner: decision.owner,
          actor: target.actor,
          lifecycleUid,
        });
        const row = grantManagedActor(hostDir, {
          owner: decision.owner,
          actor: target.actor,
          scope: target.capabilities ?? [],
          allowSubscribe: target.allowSubscribe ?? [],
          allowPublish: target.allowPublish ?? [],
          ...(target.role !== undefined ? { role: target.role } : {}),
          ...(target.label !== undefined ? { label: target.label } : {}),
          parent: decision.parent,
          lifecycleUid,
          tokenHash: decision.tokenHash!,
        });
        const provIdentity = newIdentity();
        const provisioner = new CotalEndpoint({
          space,
          servers,
          channels: [],
          creds: await mintCreds(auth, provIdentity, "provisioner"),
          card: { id: provIdentity.id, name: "provisioner", role: "provisioner", kind: "endpoint" },
          registerPresence: false,
          watchPresence: false,
          watchChannels: false,
          consume: false,
        });
        await provisioner.start();
        try {
          await provisionAgentDurables(
            provisioner,
            { owner: decision.owner, actor: target.actor, lifecycleUid },
            { subscribe: target.subscribe ?? [], allowSubscribe: row.allowSubscribe, role: row.role },
          );
        } finally {
          await provisioner.stop();
        }
        const rawResult = {
          v: 1 as const,
          kind: "manager-delegated-user-intent-execution" as const,
          operation: "launch" as const,
          space,
          instanceId: state.instanceId,
          managerLifecycleUid: state.lifecycleUid,
          requestId: execReq.requestId,
          serveEpoch: registered.processEpoch,
          intentId: exec.intentId,
          material: {
            owner: decision.owner,
            actor: target.actor,
            lifecycleUid,
            sentinelCreds: calloutAuth.sentinelCreds,
            subscribe: target.subscribe ?? [],
            allowSubscribe: row.allowSubscribe,
            allowPublish: row.allowPublish,
            agentBearerExchangeUrl: info.publicUrl!,
          },
        };
        return parseRemoteDelegatedUserIntentExecutionResult(rawResult, execReq);
      },
      prepareAgentRetirement: async ({ target }) => {
        const k = countKey(target.actor, target.lifecycleUid);
        prepareCounts.set(k, (prepareCounts.get(k) ?? 0) + 1);
        throw new Error("platform control manager must never call prepareAgentRetirement for a delegated launch");
      },
      mintRetirementRequester: async ({ identity, target, opId, serveEpoch }) => {
        const k = countKey(target.actor, target.lifecycleUid);
        retireCounts.set(k, (retireCounts.get(k) ?? 0) + 1);
        return remote.materialCredential(
          await callPlatform(
            remote.remoteManagerAuthorityRequest(state, "cli", "retire", {
              registrationProof: remoteManagerRegistrationProof(platformOwner, state),
              retirement: { id: identity.id, target, opId, serveEpoch },
            }),
          ),
          "retirementRequester",
          identity,
        );
      },
      mintSessionServing: async () => {
        throw new Error("unused");
      },
      validateRetainedAgent: async (a) => {
        const request = remote.remoteRetainedAgentValidationRequest(state, "cli", proof, registered.processEpoch, { owner: a.owner, actor: a.actor, lifecycleUid: a.lifecycleUid }, a.actorToken, a.sentinelCreds);
        return remote.retainedAgentAuthority(await callPlatform(request), request);
      },
      scanGoalIndex: async () => {
        const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
        return remote.remoteManagerGoalIndexEntries(await callPlatform(request), request, platformOwner);
      },
    };
    const mgr = new Manager({
      space,
      servers,
      workspaceRoot: wsRoot,
      runtime,
      remoteAuthority,
      eventsRequired: true,
    });
    await mgr.start();
    return { mgr, state, remoteAuthority };
  }

  const onlyCell = process.env.U4005_ONLY_CELL;
  const shouldRunCell = (c: string) => !onlyCell || onlyCell === c;

  // =========================================================================
  // Control (a-inproc): stop() without withAgents on built-in in-process pty
  // =========================================================================
  console.log("\n=== Cell (a-inproc): stop() without withAgents on in-process pty (LegacyPtyRuntime) ===");
  if (shouldRunCell("cell-a-inproc-pty")) {
    const cell = "cell-a-inproc-pty";
    const seatName = "seat_a_inproc";
    const ws = createWorkspaceRoot("a-inproc", [seatName]);
    const { mgr } = await bootRemoteManagerOnRoot(ws, "pty");
    const started = await mgr.startAgent({ name: seatName, agent: "u4005-seat" });
    checkSetup(cell, "seat_a_inproc spawned on in-process pty manager", started.ok, started.error);
    const ctl = seatControls.get(seatName)!;
    await until(() => existsSync(ctl.pidFile), "seat_a_inproc pid file");
    const { pid: seatPid, uid } = JSON.parse(readFileSync(ctl.pidFile, "utf8")) as { pid: number; uid: string };
    const before = await inspectLifecycleState(seatName, uid);
    checkSetup(
      cell,
      "seat_a_inproc active before stop()",
      before.headState === "active" && before.grantUnrevoked && before.dmPresent && before.dlvPresent,
      before,
    );
    await mgr.stop(); // without withAgents; LegacyPtyRuntime has no release(), so stopOnce routes through teardownManagedAgents(inProcess)
    await until(() => !pidAlive(seatPid), "seat_a_inproc process exit");
    await until(async () => (await inspectLifecycleState(seatName, uid)).headState === "retired", "seat_a_inproc retirement settle");
    const after = await inspectLifecycleState(seatName, uid);
    checkSetup(
      cell,
      "in-process pty stop() without withAgents routes through teardownManagedAgents(inProcess) and retires the lifecycle (cannot be made red on LegacyPtyRuntime)",
      after.headState === "retired" &&
        !after.grantUnrevoked &&
        !after.dmPresent &&
        !after.dlvPresent &&
        after.prepareRetirementCalls === 1 &&
        after.retireCalls === 1,
      after,
    );
  }

  // =========================================================================
  // Cell (a): stop() without withAgents releases custody (releaseManagedAgents),
  // and the seat later exits
  // =========================================================================
  console.log("\n=== Cell (a): stop() without withAgents releases custody (releaseManagedAgents), and seat later exits ===");
  if (shouldRunCell("cell-a-release-custody")) {
    const cell = "cell-a-release-custody";
    const seatName = "seat_a";
    const ws = createWorkspaceRoot("a-release", [seatName]);
    const { mgr: mgr1 } = await bootRemoteManagerOnRoot(ws, "custodial-pty");
    const started = await mgr1.startAgent({ name: seatName, agent: "u4005-seat" });
    checkSetup(cell, "seat_a spawned on custodial-pty manager", started.ok, started.error);
    const ctl = seatControls.get(seatName)!;
    await until(() => existsSync(ctl.pidFile), "seat_a pid file");
    const { pid: seatPid, uid } = JSON.parse(readFileSync(ctl.pidFile, "utf8")) as { pid: number; uid: string };
    const before = await inspectLifecycleState(seatName, uid);
    checkSetup(
      cell,
      "seat_a provisioned with active head, grant, and dm_/dlv_ durables",
      before.headState === "active" && before.grantUnrevoked && before.dmPresent && before.dlvPresent,
      before,
    );

    await mgr1.stop(); // without withAgents -> releaseManagedAgents()
    checkSetup(cell, "releaseManagedAgents leaves detached seat_a process alive after manager.stop()", pidAlive(seatPid), { seatPid });

    // Now the released seat later exits on its own
    writeFileSync(ctl.exitFile, "exit");
    await until(() => !pidAlive(seatPid), "seat_a process exit after custody release");

    const afterSeatExit = await inspectLifecycleState(seatName, uid);
    checkRepro(cell, "after released seat_a exits: lifecycle head is still active", afterSeatExit.headState === "active", afterSeatExit);
    checkRepro(cell, "after released seat_a exits: grant is still unrevoked", afterSeatExit.grantUnrevoked === true, afterSeatExit);
    checkRepro(
      cell,
      "after released seat_a exits: dm_ and dlv_ durables are still present",
      afterSeatExit.dmPresent === true && afterSeatExit.dlvPresent === true,
      afterSeatExit,
    );
    checkRepro(
      cell,
      "after released seat_a exits: no retirement was requested (prepare=0, retire=0)",
      afterSeatExit.prepareRetirementCalls === 0 && afterSeatExit.retireCalls === 0,
      afterSeatExit,
    );

    // Start a successor manager on the same root to observe whether startup reconciles
    // the dead released seat
    const { mgr: mgr2 } = await bootRemoteManagerOnRoot(ws, "custodial-pty");
    const afterReconcile = await inspectLifecycleState(seatName, uid);
    await mgr2.stop();

    checkContract(cell, "after seat_a exit + manager start: lifecycle head reaches retired", afterReconcile.headState === "retired", afterReconcile);
    checkContract(cell, "after seat_a exit + manager start: managed grant is revoked", !afterReconcile.grantUnrevoked, afterReconcile);
    checkContract(
      cell,
      "after seat_a exit + manager start: dm_ and dlv_ durables are removed",
      !afterReconcile.dmPresent && !afterReconcile.dlvPresent,
      afterReconcile,
    );
    checkContract(
      cell,
      "after seat_a exit + manager start: retirement was requested (prepare>=1, retire>=1)",
      afterReconcile.prepareRetirementCalls >= 1 && afterReconcile.retireCalls >= 1,
      afterReconcile,
    );
  }

  // =========================================================================
  // Cell (b): signal / stop() after a partial preservation (stopRetainedAgentsOnExit)
  // =========================================================================
  console.log("\n=== Cell (b): signal after partial preservation (stopRetainedAgentsOnExit) ===");
  if (shouldRunCell("cell-b-partial-preservation-signal")) {
    const cell = "cell-b-partial-preservation-signal";
    const seatName = "seat_b";
    const ws = createWorkspaceRoot("b-partial", [seatName]);
    const { mgr: mgr1 } = await bootRemoteManagerOnRoot(ws, "pty");
    const started = await mgr1.startAgent({ name: seatName, agent: "u4005-seat" });
    checkSetup(cell, "seat_b spawned on manager", started.ok, started.error);
    const ctl = seatControls.get(seatName)!;
    await until(() => existsSync(ctl.pidFile), "seat_b pid file");
    const { pid: seatPid, uid } = JSON.parse(readFileSync(ctl.pidFile, "utf8")) as { pid: number; uid: string };

    const plan = await mgr1.preparePreservation("partial-attempt-b");
    checkSetup(cell, "preparePreservation fences manager in preserving state without stopping seat_b", plan.ok && plan.state === "prepared" && pidAlive(seatPid), plan);

    // Signal arrives after partial preservation (before commitPreservation) ->
    // stopOnce calls stopRetainedAgentsOnExit()
    await mgr1.stop();
    await until(() => !pidAlive(seatPid), "seat_b stopped by stopRetainedAgentsOnExit");

    const afterStop = await inspectLifecycleState(seatName, uid);
    checkRepro(cell, "after stopRetainedAgentsOnExit: lifecycle head is still active", afterStop.headState === "active", afterStop);
    checkRepro(cell, "after stopRetainedAgentsOnExit: grant is still unrevoked", afterStop.grantUnrevoked === true, afterStop);
    checkRepro(
      cell,
      "after stopRetainedAgentsOnExit: dm_ and dlv_ durables are still present",
      afterStop.dmPresent === true && afterStop.dlvPresent === true,
      afterStop,
    );
    checkRepro(
      cell,
      "after stopRetainedAgentsOnExit: no retirement was requested (prepare=0, retire=0)",
      afterStop.prepareRetirementCalls === 0 && afterStop.retireCalls === 0,
      afterStop,
    );

    // A new manager starts on the same root without resuming the partial preservation
    const { mgr: mgr2 } = await bootRemoteManagerOnRoot(ws, "pty");
    const afterReconcile = await inspectLifecycleState(seatName, uid);
    await mgr2.stop();

    checkContract(cell, "after partial-preservation exit + new manager start: lifecycle head reaches retired", afterReconcile.headState === "retired", afterReconcile);
    checkContract(cell, "after partial-preservation exit + new manager start: managed grant is revoked", !afterReconcile.grantUnrevoked, afterReconcile);
    checkContract(
      cell,
      "after partial-preservation exit + new manager start: dm_ and dlv_ durables are removed",
      !afterReconcile.dmPresent && !afterReconcile.dlvPresent,
      afterReconcile,
    );
    checkContract(
      cell,
      "after partial-preservation exit + new manager start: retirement was requested (prepare>=1, retire>=1)",
      afterReconcile.prepareRetirementCalls >= 1 && afterReconcile.retireCalls >= 1,
      afterReconcile,
    );
  }

  // =========================================================================
  // Cell (c1): manager killed hard (SIGKILL) with a live pty seat
  // =========================================================================
  console.log("\n=== Cell (c1): manager killed hard (SIGKILL) with a live pty seat ===");
  if (shouldRunCell("cell-c1-sigkill-active-pty")) {
    const cell = "cell-c1-sigkill-active-pty";
    const seatName = "seat_c1";
    const ws = createWorkspaceRoot("c1-sigkill", [seatName]);
    const stateFile = join(scratch, "c1-state.json");
    const seatPidFile = join(scratch, "c1-seat-pid.json");
    const seatExitFile = join(scratch, "c1-seat.exit");
    const cfgFile = join(scratch, "c1-cfg.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        mode: "sigkill-active",
        space,
        servers,
        hostRoot,
        wsRoot: ws,
        home,
        seatName,
        stateFile,
        seatPidFile,
        seatExitFile,
      }),
    );
    const child = spawn(process.execPath, [...process.execArgv, self, "manager-child", cfgFile], {
      cwd: ws,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await until(() => existsSync(stateFile) && existsSync(seatPidFile), "manager-child c1 active state");
    const { seatPid, lifecycleUid: uid } = JSON.parse(readFileSync(stateFile, "utf8")) as {
      managerPid: number;
      seatPid: number;
      lifecycleUid: string;
    };
    const before = await inspectLifecycleState(seatName, uid);
    checkSetup(
      cell,
      "seat_c1 active on child manager before SIGKILL",
      before.headState === "active" && before.grantUnrevoked && before.dmPresent && before.dlvPresent,
      before,
    );

    await killAndAwaitExit(child, "SIGKILL");
    await until(() => !pidAlive(seatPid), "seat_c1 pty child exit after manager SIGKILL");

    const afterKill = await inspectLifecycleState(seatName, uid);
    checkRepro(cell, "after manager SIGKILL + pty seat exit: lifecycle head is still active", afterKill.headState === "active", afterKill);
    checkRepro(cell, "after manager SIGKILL + pty seat exit: grant is still unrevoked", afterKill.grantUnrevoked === true, afterKill);
    checkRepro(
      cell,
      "after manager SIGKILL + pty seat exit: dm_ and dlv_ durables are still present",
      afterKill.dmPresent === true && afterKill.dlvPresent === true,
      afterKill,
    );
    checkRepro(
      cell,
      "after manager SIGKILL + pty seat exit: no retirement was requested (prepare=0, retire=0)",
      afterKill.prepareRetirementCalls === 0 && afterKill.retireCalls === 0,
      afterKill,
    );

    // Clear expired/dead manager lease key so successor manager on same instanceId
    // can boot without waiting 10s TTL
    const mgrState = remote.loadOrCreateRemoteManagerIdentity(ws, space);
    await managerKv.purge(`${MANAGER_LEASE_KEY}.${mgrState.instanceId}`).catch(() => {});
    const { mgr: mgr2 } = await bootRemoteManagerOnRoot(ws, "pty");
    const afterReconcile = await inspectLifecycleState(seatName, uid);
    await mgr2.stop();

    checkContract(cell, "after manager SIGKILL + new manager start: lifecycle head reaches retired", afterReconcile.headState === "retired", afterReconcile);
    checkContract(cell, "after manager SIGKILL + new manager start: managed grant is revoked", !afterReconcile.grantUnrevoked, afterReconcile);
    checkContract(
      cell,
      "after manager SIGKILL + new manager start: dm_ and dlv_ durables are removed",
      !afterReconcile.dmPresent && !afterReconcile.dlvPresent,
      afterReconcile,
    );
    checkContract(
      cell,
      "after manager SIGKILL + new manager start: retirement was requested (prepare>=1, retire>=1)",
      afterReconcile.prepareRetirementCalls >= 1 && afterReconcile.retireCalls >= 1,
      afterReconcile,
    );
  }

  // =========================================================================
  // Cell (c2): manager killed hard (SIGKILL) while in-memory `retiring` map holds seat
  // =========================================================================
  console.log("\n=== Cell (c2): manager killed hard (SIGKILL) while in-memory retiring map holds pty seat ===");
  if (shouldRunCell("cell-c2-sigkill-retiring-map-lost")) {
    const cell = "cell-c2-sigkill-retiring-map-lost";
    const seatName = "seat_c2";
    const ws = createWorkspaceRoot("c2-sigkill-retiring", [seatName]);
    const stateFile = join(scratch, "c2-state.json");
    const seatPidFile = join(scratch, "c2-seat-pid.json");
    const seatExitFile = join(scratch, "c2-seat.exit");
    const cfgFile = join(scratch, "c2-cfg.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        mode: "sigkill-retiring",
        space,
        servers,
        hostRoot,
        wsRoot: ws,
        home,
        seatName,
        stateFile,
        seatPidFile,
        seatExitFile,
      }),
    );
    const child = spawn(process.execPath, [...process.execArgv, self, "manager-child", cfgFile], {
      cwd: ws,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await until(() => existsSync(stateFile) && existsSync(seatPidFile), "manager-child c2 retiring-in-memory state");
    const { pid: seatPid } = JSON.parse(readFileSync(seatPidFile, "utf8")) as { pid: number; uid: string };
    const retiringState = JSON.parse(readFileSync(stateFile, "utf8")) as {
      phase: string;
      lifecycleUid: string;
      retiringMapHasSeat: boolean;
      opId: string;
    };
    const uid = retiringState.lifecycleUid;
    checkSetup(
      cell,
      "seat_c2 exited and entered manager's in-memory retiring map before SIGKILL",
      retiringState.phase === "retiring-in-memory" && retiringState.retiringMapHasSeat === true && !pidAlive(seatPid),
      retiringState,
    );

    await killAndAwaitExit(child, "SIGKILL");

    const afterKill = await inspectLifecycleState(seatName, uid);
    checkRepro(cell, "after SIGKILL losing in-memory retiring map: lifecycle head is still active", afterKill.headState === "active", afterKill);
    checkRepro(cell, "after SIGKILL losing in-memory retiring map: grant is still unrevoked", afterKill.grantUnrevoked === true, afterKill);
    checkRepro(
      cell,
      "after SIGKILL losing in-memory retiring map: dm_ and dlv_ durables are still present",
      afterKill.dmPresent === true && afterKill.dlvPresent === true,
      afterKill,
    );
    checkRepro(
      cell,
      "after SIGKILL losing in-memory retiring map: no retirement reached host (prepare=0, retire=0)",
      afterKill.prepareRetirementCalls === 0 && afterKill.retireCalls === 0,
      afterKill,
    );

    const mgrState = remote.loadOrCreateRemoteManagerIdentity(ws, space);
    await managerKv.purge(`${MANAGER_LEASE_KEY}.${mgrState.instanceId}`).catch(() => {});
    const { mgr: mgr2 } = await bootRemoteManagerOnRoot(ws, "pty");
    const afterReconcile = await inspectLifecycleState(seatName, uid);
    await mgr2.stop();

    checkContract(cell, "after SIGKILL losing retiring map + new manager start: lifecycle head reaches retired", afterReconcile.headState === "retired", afterReconcile);
    checkContract(cell, "after SIGKILL losing retiring map + new manager start: managed grant is revoked", !afterReconcile.grantUnrevoked, afterReconcile);
    checkContract(
      cell,
      "after SIGKILL losing retiring map + new manager start: dm_ and dlv_ durables are removed",
      !afterReconcile.dmPresent && !afterReconcile.dlvPresent,
      afterReconcile,
    );
    checkContract(
      cell,
      "after SIGKILL losing retiring map + new manager start: retirement was requested (prepare>=1, retire>=1)",
      afterReconcile.prepareRetirementCalls >= 1 && afterReconcile.retireCalls >= 1,
      afterReconcile,
    );
  }

  // =========================================================================
  // Cell (d): preserved inventory never resumed while a new manager starts
  // =========================================================================
  console.log("\n=== Cell (d): preserved inventory never resumed while a new manager starts ===");
  if (shouldRunCell("cell-d-unresumed-inventory")) {
    const cell = "cell-d-unresumed-inventory";
    const seatName = "seat_d";
    const ws = createWorkspaceRoot("d-unresumed", [seatName]);
    const { mgr: mgr1 } = await bootRemoteManagerOnRoot(ws, "pty");
    const started = await mgr1.startAgent({ name: seatName, agent: "u4005-seat" });
    checkSetup(cell, "seat_d spawned on manager1", started.ok, started.error);
    const ctl = seatControls.get(seatName)!;
    await until(() => existsSync(ctl.pidFile), "seat_d pid file");
    const { pid: seatPid, uid } = JSON.parse(readFileSync(ctl.pidFile, "utf8")) as { pid: number; uid: string };

    let persistedInventory = false;
    const preserved = await mgr1.preserveState({
      attemptId: "preserve-d",
      persistInventory: async (inv) => {
        persistedInventory = inv.agents.some((a) => a.name === seatName);
      },
    });
    checkSetup(
      cell,
      "preserveState completes (preparePreservation + commitPreservation) and stops seat_d",
      preserved.ok && preserved.state === "preserved" && persistedInventory && !pidAlive(seatPid),
      preserved,
    );
    await mgr1.stop();
    const afterPreserveStop = await inspectLifecycleState(seatName, uid);

    checkRepro(cell, "after unresumed preservation stop (before manager2): lifecycle head is still active", afterPreserveStop.headState === "active", afterPreserveStop);
    checkRepro(cell, "after unresumed preservation stop (before manager2): grant is still unrevoked", afterPreserveStop.grantUnrevoked === true, afterPreserveStop);
    checkRepro(
      cell,
      "after unresumed preservation stop (before manager2): dm_ and dlv_ durables are still present",
      afterPreserveStop.dmPresent === true && afterPreserveStop.dlvPresent === true,
      afterPreserveStop,
    );
    checkRepro(
      cell,
      "after unresumed preservation stop (before manager2): no retirement was requested (prepare=0, retire=0)",
      afterPreserveStop.prepareRetirementCalls === 0 && afterPreserveStop.retireCalls === 0,
      afterPreserveStop,
    );

    // Start a new manager on the same root without resuming the preserved inventory
    const { mgr: mgr2 } = await bootRemoteManagerOnRoot(ws, "pty");
    const afterNewManager = await inspectLifecycleState(seatName, uid);
    await mgr2.stop();

    checkContract(cell, "after unresumed preservation + new manager start: lifecycle head reaches retired", afterNewManager.headState === "retired", afterNewManager);
    checkContract(cell, "after unresumed preservation + new manager start: managed grant is revoked", !afterNewManager.grantUnrevoked, afterNewManager);
    checkContract(
      cell,
      "after unresumed preservation + new manager start: dm_ and dlv_ durables are removed",
      !afterNewManager.dmPresent && !afterNewManager.dlvPresent,
      afterNewManager,
    );
    checkContract(
      cell,
      "after unresumed preservation + new manager start: retirement was requested (prepare>=1, retire>=1)",
      afterNewManager.prepareRetirementCalls >= 1 && afterNewManager.retireCalls >= 1,
      afterNewManager,
    );
  }

  // =========================================================================
  // Cell (e): enrollment reply lost after host committed grant and durables
  // =========================================================================
  console.log("\n=== Cell (e): enrollment reply lost after host committed grant and durables ===");
  if (shouldRunCell("cell-e-enrollment-reply-loss")) {
    const cell = "cell-e-enrollment-reply-loss";
    const seatName = "seat_e_reply_loss";
    const ws = createWorkspaceRoot("e-reply-loss", [seatName]);
    let committedUid = "";
    const { mgr: mgr1 } = await bootRemoteManagerOnRoot(ws, "pty", undefined, (material) => {
      if (material.actor === seatName && !committedUid) {
        committedUid = material.lifecycleUid;
        throw new Error("simulated lost enrollment response after host commit");
      }
    });
    const started = await mgr1.startAgent({ name: seatName, agent: "u4005-seat" });
    checkSetup(
      cell,
      "startAgent reports post-commit enrollment response loss without launching seat process",
      !started.ok &&
        /simulated lost enrollment response/.test(started.error ?? "") &&
        committedUid.length > 0 &&
        !existsSync(join(scratch, `${seatName}.pid.json`)),
      { started, committedUid },
    );
    await mgr1.stop();

    const afterLoss = await inspectLifecycleState(seatName, committedUid);
    checkRepro(cell, "after lost enrollment reply: host managed grant is still unrevoked", afterLoss.grantUnrevoked === true, afterLoss);
    checkRepro(
      cell,
      "after lost enrollment reply: dm_ and dlv_ durables are still present",
      afterLoss.dmPresent === true && afterLoss.dlvPresent === true,
      afterLoss,
    );
    checkRepro(
      cell,
      "after lost enrollment reply: no retirement was requested (prepare=0, retire=0)",
      afterLoss.prepareRetirementCalls === 0 && afterLoss.retireCalls === 0,
      afterLoss,
    );

    const { mgr: mgr2 } = await bootRemoteManagerOnRoot(ws, "pty");
    const afterReconcile = await inspectLifecycleState(seatName, committedUid);
    await mgr2.stop();
    const slotEntry =
      (await recordsKv.get(`mgrslot.${owner}.${owner}-${seatName}`)) ??
      (await recordsKv.get(`mgrslot.${owner}.${seatName}`));

    checkContract(
      cell,
      "after lost enrollment reply + manager2 start: durable mgrslot custody record exists",
      slotEntry !== null && slotEntry.operation === "PUT",
      slotEntry ? { key: slotEntry.key, revision: slotEntry.revision } : null,
    );
    checkContract(
      cell,
      "after lost enrollment reply + manager2 start: lifecycle head reaches retired",
      afterReconcile.headState === "retired",
      afterReconcile,
    );
    checkContract(
      cell,
      "after lost enrollment reply + manager2 start: managed grant is revoked",
      !afterReconcile.grantUnrevoked,
      afterReconcile,
    );
    checkContract(
      cell,
      "after lost enrollment reply + manager2 start: dm_ and dlv_ durables are removed",
      !afterReconcile.dmPresent && !afterReconcile.dlvPresent,
      afterReconcile,
    );
  }

  // =========================================================================
  // Cell (f): owned live same-start process under injected EACCES on /proc/<pid>/stat
  // =========================================================================
  console.log("\n=== Cell (f): owned live process under injected EACCES on /proc/<pid>/stat during requireRuntimeReap ===");
  if (shouldRunCell("cell-f-unreadable-reap")) {
    const cell = "cell-f-unreadable-reap";
    const unreadableRoot = mkdtempSync(join(tmpdir(), "u4005-unreadable-"));
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    const pid = sleeper.pid ?? 0;
    const realReadFileSync = fsDefault.readFileSync;
    try {
      const startToken = pid > 0 ? processStartToken(pid) : undefined;
      const boot = bootToken();
      const id = seatId();
      const recFile = recordPath(unreadableRoot, id);
      mkdirSync(join(unreadableRoot, id), { recursive: true, mode: 0o700 });
      const rec: SeatRecord = {
        version: 1,
        id,
        name: "owned-live-unreadable",
        socket: socketPath(unreadableRoot, id),
        token: "unreadable-probe-token",
        custodianPid: pid,
        custodianStart: startToken ?? "",
        childPid: pid,
        childStart: startToken ?? "",
        bootId: boot,
      };
      writeFileSync(recFile, JSON.stringify(rec) + "\n", { mode: 0o600 });
      const recordBefore = readRecord(recFile);
      const aliveBefore = pidAlive(pid);
      checkSetup(
        cell,
        "owned live process has readable startToken, bootToken, and custody record before EACCES injection",
        pid > 0 && aliveBefore && Boolean(startToken) && Boolean(boot) && recordBefore?.childStart === startToken,
        { pid, aliveBefore, startToken, boot },
      );

      const targetStatPath = `/proc/${pid}/stat`;
      let injectedReads = 0;
      let unfixedTokenDuringEacces: string | undefined = "not-checked";
      let probeUnderEacces: ReturnType<typeof probeRecordedProcess> | undefined;
      let drainUnderEacces: Awaited<ReturnType<typeof drainSeats>> = [];
      let reapOutcome: string | undefined;
      let reapError: string | undefined;
      try {
        fsDefault.readFileSync = ((
          path: Parameters<typeof realReadFileSync>[0],
          ...rest: unknown[]
        ) => {
          if (String(path) === targetStatPath) {
            injectedReads++;
            throw Object.assign(new Error(`EACCES: permission denied, open '${targetStatPath}'`), { code: "EACCES" });
          }
          return (realReadFileSync as (...a: unknown[]) => unknown)(path, ...rest);
        }) as typeof realReadFileSync;
        syncBuiltinESMExports();
        unfixedTokenDuringEacces = processStartToken(pid);
        probeUnderEacces = probeRecordedProcess({ pid, startToken: startToken ?? "", bootId: boot ?? "" });
        drainUnderEacces = await drainSeats(unreadableRoot);
        try {
          const result = await requireRuntimeReap(new CustodialPtyRuntime(unreadableRoot), { kind: "pty", id });
          reapOutcome = result.outcome;
        } catch (e) {
          reapError = (e as Error).message;
        }
      } finally {
        fsDefault.readFileSync = realReadFileSync;
        syncBuiltinESMExports();
      }

      const aliveAfter = pidAlive(pid);
      const recordAfter = existsSync(recFile) ? readRecord(recFile) : undefined;
      checkRepro(
        cell,
        "injected EACCES on /proc/<pid>/stat was hit while owned process remained alive",
        injectedReads > 0 && aliveAfter,
        { injectedReads, aliveAfter },
      );
      checkRepro(
        cell,
        "two-valued processStartToken(pid) collapses EACCES to undefined even while owned process is alive",
        unfixedTokenDuringEacces === undefined && recordBefore !== undefined,
        { unfixedTokenDuringEacces, recordBeforeChildStart: recordBefore?.childStart },
      );
      checkContract(
        cell,
        "under EACCES on /proc/<pid>/stat: probeRecordedProcess returns unknown rather than proved-dead",
        probeUnderEacces?.state === "unknown",
        probeUnderEacces,
      );
      checkContract(
        cell,
        "under EACCES on /proc/<pid>/stat: drainSeats reports state refused rather than childless or drained",
        drainUnderEacces.length === 1 && drainUnderEacces[0]?.state === "refused",
        drainUnderEacces,
      );
      checkContract(
        cell,
        "under EACCES on /proc/<pid>/stat: requireRuntimeReap refuses on unknown process liveness while process is alive",
        reapOutcome !== "reaped" && reapError !== undefined && /process liveness is unknown/.test(reapError),
        { reapOutcome, reapError, aliveAfter },
      );
      checkContract(
        cell,
        "under EACCES on /proc/<pid>/stat: custody record is retained on disk while process is alive",
        recordAfter !== undefined,
        { recordExistsAfter: recordAfter !== undefined, aliveAfter },
      );
    } finally {
      fsDefault.readFileSync = realReadFileSync;
      syncBuiltinESMExports();
      try {
        if (pid > 0) process.kill(-pid, "SIGKILL");
      } catch {
        // ignore
      }
      await killAndAwaitExit(sleeper, "SIGKILL").catch(() => {});
      rmSync(unreadableRoot, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // Guard (g1): successor manager starts while released custodial seat is STILL ALIVE
  // =========================================================================
  console.log("\n=== Guard (g1): successor manager starts while released custodial seat is still alive ===");
  if (shouldRunCell("cell-g1-released-live-kept")) {
    const cell = "cell-g1-released-live-kept";
    const seatName = "seat_g1";
    const ws = createWorkspaceRoot("g1-released-live", [seatName]);
    const { mgr: mgr1 } = await bootRemoteManagerOnRoot(ws, "custodial-pty");
    const started = await mgr1.startAgent({ name: seatName, agent: "u4005-seat" });
    checkSetup(cell, "seat_g1 spawned on custodial-pty manager1", started.ok, started.error);
    const ctl = seatControls.get(seatName)!;
    await until(() => existsSync(ctl.pidFile), "seat_g1 pid file");
    const { pid: seatPid, uid } = JSON.parse(readFileSync(ctl.pidFile, "utf8")) as { pid: number; uid: string };

    await mgr1.stop(); // without withAgents -> releaseManagedAgents() leaves seat_g1 alive
    checkSetup(cell, "seat_g1 remains alive after manager1.stop()", pidAlive(seatPid), { seatPid });

    // Start successor manager2 while seat_g1 is still alive
    const { mgr: mgr2 } = await bootRemoteManagerOnRoot(ws, "custodial-pty");
    const mgr2Diag = mgr2.userReconcileDiagnostics();
    const whileLive = await inspectLifecycleState(seatName, uid);

    checkGuard(
      cell,
      "while released seat_g1 is alive: startup reconciliation entered released-live adoption guard (adoptedReleasedCount>=1)",
      mgr2Diag.adoptedReleasedCount >= 1,
      mgr2Diag,
    );
    checkGuard(cell, "while released seat_g1 is alive: process is still running after manager2.start()", pidAlive(seatPid), { seatPid });
    checkGuard(cell, "while released seat_g1 is alive: lifecycle head stays active", whileLive.headState === "active" && whileLive.headUid === uid, whileLive);
    checkGuard(cell, "while released seat_g1 is alive: managed grant stays unrevoked", whileLive.grantUnrevoked === true, whileLive);
    checkGuard(
      cell,
      "while released seat_g1 is alive: dm_ and dlv_ durables stay present",
      whileLive.dmPresent === true && whileLive.dlvPresent === true,
      whileLive,
    );
    checkGuard(
      cell,
      "while released seat_g1 is alive: no retirement requested (prepare=0, retire=0)",
      whileLive.prepareRetirementCalls === 0 && whileLive.retireCalls === 0,
      whileLive,
    );

    // Clean up seat_g1 and manager2
    writeFileSync(ctl.exitFile, "exit");
    await until(() => !pidAlive(seatPid), "seat_g1 exit cleanup");
    await mgr2.stop();
  }

  // =========================================================================
  // Guard (g2): resumePreserved adoption keeps active head, grant, and durables
  // =========================================================================
  console.log("\n=== Guard (g2): resumePreserved adoption keeps active head, grant, and durables ===");
  if (shouldRunCell("cell-g2-resume-preserved-adopted")) {
    const cell = "cell-g2-resume-preserved-adopted";
    const seatName = "seat_g2";
    const ws = createWorkspaceRoot("g2-resume-adopted", [seatName]);
    const { mgr: mgr1 } = await bootRemoteManagerOnRoot(ws, "pty");
    const started = await mgr1.startAgent({ name: seatName, agent: "u4005-seat" }, `${owner}.cli`);
    checkSetup(cell, "seat_g2 spawned on manager1", started.ok, started.error);
    const ctl = seatControls.get(seatName)!;
    await until(() => existsSync(ctl.pidFile), "seat_g2 initial pid file");
    const { pid: seatPid1, uid } = JSON.parse(readFileSync(ctl.pidFile, "utf8")) as { pid: number; uid: string };

    let savedInventory: import("@cotal-ai/manager").ManagerResumeInventory | undefined;
    const preserved = await mgr1.preserveState({
      attemptId: "resume-g2",
      persistInventory: async (inv) => {
        savedInventory = inv;
      },
    });
    checkSetup(
      cell,
      "preserveState stops seat_g2 and captures resume inventory",
      preserved.ok && preserved.state === "preserved" && savedInventory !== undefined && !pidAlive(seatPid1),
      preserved,
    );
    await mgr1.stop();
    rmSync(ctl.pidFile, { force: true });
    // Clear the SIGKILLed predecessor's stale presence row so resumePreserved does not wait 30s TTL
    const presCreds = await mintCreds(auth, newIdentity(), "operator", { principal: { owner, actor: seatName } });
    const presNc = await connect({ servers, ...standaloneConnectOpts({ creds: presCreds, tls: false }), maxReconnectAttempts: 0 });
    try {
      const presKv = await new Kvm(presNc).open(presenceBucket(space));
      await presKv.delete(`${owner}.${seatName}`);
    } finally {
      await presNc.close().catch(() => {});
    }

    // Start successor manager2 fenced for resumeAttemptId "resume-g2"
    const { mgr: mgr2 } = await bootRemoteManagerOnRoot(ws, "pty", "resume-g2");
    const ops = mgr2 as unknown as {
      opResumePreserved: (args: unknown) => Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>;
      opCommitResume: (args: unknown) => Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>;
      opFinalizeResume: (args: unknown) => Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>;
    };
    const resumed = await ops.opResumePreserved({ attemptId: "resume-g2", inventory: savedInventory });
    const committed = await ops.opCommitResume({ attemptId: "resume-g2" });
    const token = (committed.data as { durableCommitToken?: string } | undefined)?.durableCommitToken;
    const finalized = await ops.opFinalizeResume({ attemptId: "resume-g2", durableCommitToken: token });
    let seatPid2 = 0;
    let resumedUid = "";
    if (resumed.ok) {
      await until(() => existsSync(ctl.pidFile), "seat_g2 resumed pid file");
      const parsed = JSON.parse(readFileSync(ctl.pidFile, "utf8")) as { pid: number; uid: string };
      seatPid2 = parsed.pid;
      resumedUid = parsed.uid;
    }

    const mgr2Diag = mgr2.userReconcileDiagnostics();
    const afterAdopt = await inspectLifecycleState(seatName, uid);
    checkGuard(
      cell,
      "after resumePreserved adoption: startup deferral and post-adoption skip guards both fired (deferred>=1, adoptedSkip>=1)",
      mgr2Diag.deferredForResumeCount >= 1 && mgr2Diag.adoptedResumeSkipCount >= 1,
      mgr2Diag,
    );
    checkGuard(
      cell,
      "resumePreserved -> commitResume -> finalizeResume succeeds and launches replacement process at retained uid",
      resumed.ok && committed.ok && finalized.ok && pidAlive(seatPid2) && resumedUid === uid,
      { resumed, committed, finalized, seatPid2, resumedUid, uid },
    );
    checkGuard(cell, "after resumePreserved adoption: lifecycle head stays active at retained uid", afterAdopt.headState === "active" && afterAdopt.headUid === uid, afterAdopt);
    checkGuard(cell, "after resumePreserved adoption: managed grant stays unrevoked", afterAdopt.grantUnrevoked === true, afterAdopt);
    checkGuard(
      cell,
      "after resumePreserved adoption: dm_ and dlv_ durables stay present",
      afterAdopt.dmPresent === true && afterAdopt.dlvPresent === true,
      afterAdopt,
    );
    checkGuard(
      cell,
      "after resumePreserved adoption: no retirement requested (prepare=0, retire=0)",
      afterAdopt.prepareRetirementCalls === 0 && afterAdopt.retireCalls === 0,
      afterAdopt,
    );

    await mgr2.stop({ withAgents: true });
    await until(() => !pidAlive(seatPid2), "seat_g2 stop cleanup");
  }

  // =========================================================================
  // Guard (g3): cross-owner delegated launch (p_... holder, u_... user owner) stays held
  // =========================================================================
  console.log("\n=== Guard (g3): cross-owner delegated launch (p_... holder, u_... user owner) stays held ===");
  if (shouldRunCell("cell-g3-delegated-launch-held")) {
    const cell = "cell-g3-delegated-launch-held";
    const seatName = "seat_g3_delegated";
    const ws = createWorkspaceRoot("g3-delegated", [seatName]);
    checkSetup(
      cell,
      "platform control holder (p_...) and user target owner (u_...) are distinct principals",
      platformOwner.startsWith("p_") && owner.startsWith("u_") && platformOwner !== owner,
      { platformOwner, owner },
    );

    let admittedIntent: DelegatedUserIntentRecord | null = null;
    const { mgr: mgr1, state: mgr1State, remoteAuthority: mgr1Auth } = await bootPlatformControlManagerOnRoot(
      ws,
      "pty",
      () => admittedIntent,
    );
    admittedIntent = await authorizeDelegatedUserIntentAdmission({
      request: {
        v: 1,
        kind: "delegated-user-intent",
        space,
        accountPublicKey: auth.account.pub,
        instanceId: mgr1State.instanceId,
        actor: "cli",
        requestId: `admit${mintLifecycleUid()}`,
        intent: {
          operation: "launch",
          target: {
            actor: seatName,
            role: "worker",
            subscribe: [],
            allowSubscribe: [],
            allowPublish: [eventChannel({ owner, actor: seatName })],
          },
        },
      },
      space,
      accountPublicKey: auth.account.pub,
      owner,
      dir: hostDir,
      observeAssignment: async () => currentPlatformAssignment,
      observeManagerGate: authService.observeManagerGate!,
      observeLaunchRecord: async () => null,
      observeAliasRecords: async () => [],
      platformOwner,
      now: Date.now(),
    });
    const started = await mgr1.startAgent({
      name: seatName,
      agent: "u4005-seat",
      delegatedIntent: { intentId: admittedIntent.intentId, owner, parent: admittedIntent.parent },
    });
    const ctl = seatControls.get(seatName)!;
    await until(() => existsSync(ctl.pidFile), "seat_g3_delegated pid file");
    const { pid: seatPid, uid } = JSON.parse(readFileSync(ctl.pidFile, "utf8")) as { pid: number; uid: string };
    checkSetup(
      cell,
      "seat_g3_delegated launched via delegatedIntent on p_... platform manager while enrolled under u_... user owner",
      started.ok && mgr1Auth.owner === platformOwner && admittedIntent.owner === owner,
      { started, managerOwner: mgr1Auth.owner, targetOwner: admittedIntent.owner, uid },
    );

    // Stop manager1 withAgents: driveDeprovision refuses prepareAgentRetirement for a.delegated
    await mgr1.stop({ withAgents: true });
    await until(() => !pidAlive(seatPid), "seat_g3_delegated process exit");

    // Start successor platform manager2 on same root: reconciliation under platformOwner must leave delegated lifecycle held
    const { mgr: mgr2, remoteAuthority: mgr2Auth } = await bootPlatformControlManagerOnRoot(
      ws,
      "pty",
      () => admittedIntent,
    );
    const mgr2Diag = mgr2.userReconcileDiagnostics();
    const afterRestart = await inspectLifecycleState(seatName, uid, owner);
    await mgr2.stop();
    const supClaims = credsClaims(mgr2Auth.supervisorCreds) as { nats?: { pub?: { allow?: string[] } } };
    const supPubAllow = supClaims.nats?.pub?.allow ?? [];
    const mgrslotGrants = supPubAllow.filter((r) => r.includes("mgrslot"));
    const recordsConsumerGrants = supPubAllow.filter((r) => r.includes("CONSUMER.") && r.includes(`KV_${recordsBucket(space)}`));

    checkGuard(
      cell,
      "platform supervisor credential confines mgrslot KV grants to mgrslot.<platformOwner>.* and carries no records-stream consumer grant",
      mgrslotGrants.length === 2 &&
        mgrslotGrants.every((r) => r.endsWith(`.mgrslot.${platformOwner}.*`)) &&
        recordsConsumerGrants.length === 0,
      { mgrslotGrants, recordsConsumerGrants },
    );
    checkGuard(
      cell,
      "after cross-owner delegated seat exit + platform manager2 start: startup reconciliation entered delegated-hold guard (heldDelegatedSlotCount>=1)",
      mgr2Diag.heldDelegatedSlotCount >= 1,
      mgr2Diag,
    );
    checkGuard(
      cell,
      "after cross-owner delegated seat exit + platform manager2 start: lifecycle head under user owner stays active",
      mgr2Auth.owner === platformOwner && afterRestart.headState === "active" && afterRestart.headUid === uid,
      afterRestart,
    );
    checkGuard(
      cell,
      "after cross-owner delegated seat exit + platform manager2 start: user managed grant stays unrevoked",
      afterRestart.grantUnrevoked === true,
      afterRestart,
    );
    checkGuard(
      cell,
      "after cross-owner delegated seat exit + platform manager2 start: user dm_ and dlv_ durables stay present",
      afterRestart.dmPresent === true && afterRestart.dlvPresent === true,
      afterRestart,
    );
    checkGuard(
      cell,
      "after cross-owner delegated seat exit + platform manager2 start: prepareAgentRetirement and retire are never called (prepare=0, retire=0)",
      afterRestart.prepareRetirementCalls === 0 && afterRestart.retireCalls === 0,
      afterRestart,
    );
  }

  const summary = {
    space,
    counts: {
      setupPass,
      setupFail,
      reproPass,
      reproFail,
      guardPass,
      guardFail,
      contractPass,
      contractFail,
      totalAssertions: records.length,
    },
    records,
  };
  if (process.env.U4005_SUMMARY_OUT) {
    writeFileSync(process.env.U4005_SUMMARY_OUT, JSON.stringify(summary, null, 2) + "\n");
  }
  console.log(
    `\nU4005 SUMMARY: setup=${setupPass}/${setupPass + setupFail} repro=${reproPass}/${reproPass + reproFail} guard=${guardPass}/${guardPass + guardFail} redContract=${contractFail}/${contractPass + contractFail} (total=${records.length})`,
  );
} finally {
  await inspectNc?.close().catch(() => {});
  await supNc?.close().catch(() => {});
  await delivery?.stop().catch(() => {});
  await authService?.close().catch(() => {});
  if (broker) await killAndAwaitExit(broker);
  if (idpServer) await new Promise<void>((r) => idpServer!.close(() => r()));
  rmSync(scratch, { recursive: true, force: true });
  rmSync(seatRoot, { recursive: true, force: true });
}

if (setupFail > 0 || reproFail > 0 || guardFail > 0 || contractFail > 0) {
  process.exit(1);
}
