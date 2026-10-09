/** Native participant-run acceptance. All policy decisions use the stock auth service and ledger.
 * The two signed-up users and their grants are disposable fixture identities, not operator state.
 * The lightweight child is a real PTY process and uses only its own minted bearer for commands.
 */
const subcommand = process.argv[2];
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
  const { readFileSync, appendFileSync } = await import("node:fs");
  const e = process.env;
  const argv = JSON.parse(e.COTAL_BEARER_CMD!) as string[];
  const bearer = () => new Promise<string>((resolve, reject) => execFile(argv[0]!, argv.slice(1), { timeout: 15_000 }, (error, stdout) => {
    if (error) reject(new Error("seat bearer exchange refused")); else resolve(stdout.trim());
  }));
  const endpoint = new CotalEndpoint({
    space: e.COTAL_SPACE!, servers: e.COTAL_SERVERS!, bearer,
    sentinelCreds: readFileSync(e.COTAL_SENTINEL_CREDS!, "utf8"), lifecycleUid: e.COTAL_LIFECYCLE_UID!,
    channels: [], consume: false, watchChannels: false,
    card: { owner: e.COTAL_OWNER!, actor: e.COTAL_ACTOR!, name: e.COTAL_NAME!, kind: "agent" },
  });
  endpoint.on("error", () => {});
  await endpoint.start();
  const seen = new Set<string>();
  const trace = (event: Record<string, unknown>) => appendFileSync(e.U4_TRACE!, JSON.stringify({ owner: e.COTAL_OWNER, actor: e.COTAL_ACTOR, uid: e.COTAL_LIFECYCLE_UID, ...event }) + "\n");
  trace({ kind: "joined" });
  const timer = setInterval(async () => {
    try {
      const pulled = await endpoint.invokeService("manager", "turn-pending", undefined, { target: { mode: "self" }, deadlineMs: 5000 });
      if (!pulled.reply.ok) return;
      for (const turn of (pulled.reply.data as { turns: Array<{ goalId: string; payload: string }> }).turns) {
        if (seen.has(turn.goalId)) continue;
        seen.add(turn.goalId);
        const payload = JSON.parse(turn.payload) as { run: string; step: string; ask?: { schema: unknown } };
        trace({ kind: "turn", goalId: turn.goalId, run: payload.run, step: payload.step });
        if (payload.ask) {
          const answered = await endpoint.invokeService("manager", "run-answer", { runId: payload.run, stepKey: payload.step, value: { estimate: 7, ready: true } }, { target: { mode: "self" }, deadlineMs: 10_000 });
          trace({ kind: "answer", ok: answered.reply.ok, run: payload.run, step: payload.step });
        } else {
          const persona = await endpoint.invokeService("manager", "define-persona", { name: `${e.COTAL_NAME}_content`, persona: "Owned content from the run's seat.", agent: "u4-seat" }, { deadlineMs: 5000 });
          trace({ kind: "persona", ok: persona.reply.ok, error: persona.reply.error?.message });
          const yielded = await endpoint.invokeService("manager", "turn-yield", { goalId: turn.goalId, status: "done", note: "native owned seat turn" }, { target: { mode: "self" }, deadlineMs: 5000 });
          trace({ kind: "yield", ok: yielded.reply.ok });
        }
      }
    } catch (error) { trace({ kind: "seat-call-refused", reason: (error instanceof Error ? error.message : String(error)).replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]").slice(0, 300) }); }
  }, 200);
  const stop = () => { clearInterval(timer); void endpoint.stop().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(() => {});
}

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint, createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, serverConfig, setupSpaceStreams,
  standaloneConnectOpts, isReachable, remoteManagerActors, remoteManagerRegistrationProof,
  eventChannel, loadAgentFile, readRunAdmission, runDriverCaller, readGoalResult,
  epCall, issuedUserCaller, resolveService, invokeCommand, type EpCaller, type Connector, type EpAttributedReply, registry,
} from "@cotal-ai/core";
import { authDir, userAuthStateDir, workspaceSecretStore, saveSpaceAuth, recordMesh, assertUserAuthInfo } from "@cotal-ai/workspace";
import {
  cotalAuthProvider, saveIdpSession, grantActor, loadAuthServiceInfo, loadOwnerSecret, loadPinnedIdp,
  deriveOwnerForIdpSubject, findActorUnified, revokeActor,
} from "@cotal-ai/auth";
import { Manager, type ManagerOptions } from "../src/manager.js";
import { managerClusterArtifacts, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";
import * as remote from "../src/remote-authority.js";
import { RunHosting } from "../src/run-hosting.js";
import "@cotal-ai/runtime";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";

const here = import.meta.dirname;
const self = resolve(here, "run-owned-agents.smoke.ts");
const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}u4-`));
const home = join(scratch, "home");
const hostRoot = join(scratch, "host");
const root = join(scratch, "participant");
for (const dir of [home, hostRoot, root]) mkdirSync(join(dir, ".cotal"), { recursive: true });
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = home;
const space = `u4${mintLifecycleUid().slice(0, 8)}`;
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const hostDir = userAuthStateDir(hostRoot, space);
const hostStore = workspaceSecretStore(hostRoot);
const tracePath = join(scratch, "seat.jsonl");
writeFileSync(tracePath, "");
let passed = 0, failed = 0;
const check = (name: string, condition: unknown): void => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}`); }
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, label: string, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await fn()) { if (Date.now() > end) throw new Error(label); await wait(100); }
}
function successful(r: EpAttributedReply): Record<string, unknown> {
  if (!r.reply.ok) throw new Error(`endpoint refused ${r.reply.error?.code}: ${r.reply.error?.message}; ${JSON.stringify(r.reply.error?.details)}`);
  return r.reply.data as Record<string, unknown>;
}
const trace = (): Array<Record<string, unknown>> => readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
let broker: ChildProcess | undefined;
let authChild: ChildProcess | undefined;
let manager: Manager | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let idpServer: ReturnType<typeof createServer> | undefined;
const endpoints: CotalEndpoint[] = [];
const connections: Awaited<ReturnType<typeof connect>>[] = [];
let adminRequests: Array<{ owner: string; actor: string; lifecycleUid: string; authorized: boolean }> = [];
let mainRun: string | undefined;
let fatal: string | undefined;
let connectorResolutions = 0, enrollments = 0;

try {
  // Native Better Auth users and sessions. No guessed JWT, callout rule copy or artificial issuance.
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
  const idp = betterAuth({ baseURL: origin, secret: "native-u4-disposable-fixture-secret-123456", database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }), emailAndPassword: { enabled: true }, plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), bearer()] });
  handler = toNodeHandler(idp);
  const signup = await idp.api.signUpEmail({ body: { email: "owner-a@example.test", password: "native-fixture-password", name: "Fixture owner A" } });
  assert(signup.token && signup.user.id);
  saveIdpSession(home, idpUrl, { token: signup.token, sub: signup.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const auth = await createSpaceAuth(space);
  saveSpaceAuth(authDir(hostRoot), auth);
  const prepared = await cotalAuthProvider.prepareServer({ space, operatorSeed: auth.operator.seed, account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store: hostStore, dir: hostDir, idpUrl });
  writeFileSync(join(scratch, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(scratch, "js"), extraAccounts: prepared.extraAccounts }));
  broker = spawn("nats-server", ["-c", join(scratch, "server.conf")], { stdio: "ignore" });
  teardownOnSignal(broker, scratch);
  await until(() => isReachable(servers), "broker readiness");
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: hostStore.identity! });
  let authOutput = "";
  authChild = spawn(process.execPath, [...process.execArgv, self, "auth-service", "--space", space, "--server", servers, "--exchange-public-port", "0"], { cwd: hostRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [authChild.stdout, authChild.stderr]) stream!.on("data", (d) => { authOutput += d.toString(); });
  await until(async () => {
    if (authChild!.exitCode !== null) throw new Error("stock auth service exited during boot");
    const info = loadAuthServiceInfo(hostDir);
    return !!info?.publicUrl && (await fetch(`${info.url}/health`).catch(() => undefined))?.ok === true;
  }, "stock auth service readiness");
  const info = loadAuthServiceInfo(hostDir)!;
  const pin = loadPinnedIdp(hostDir)!;
  const secret = (await loadOwnerSecret(hostStore, space))!;
  const owner = deriveOwnerForIdpSubject(secret, pin.issuer, signup.user.id);
  const signupB = await idp.api.signUpEmail({ body: { email: "owner-b@example.test", password: "native-fixture-password", name: "Fixture owner B" } });
  const otherOwner = deriveOwnerForIdpSubject(secret, pin.issuer, signupB.user.id);
  const row = grantActor(hostDir, { owner, actor: "cli", scope: ["spawn", "run", "supervise", "admin"], allowSubscribe: [">"], allowPublish: [">"], label: "disposable native U4 operator" });
  grantActor(hostDir, { owner: otherOwner, actor: "cli", scope: ["spawn", "run", "admin"], allowSubscribe: [], allowPublish: [], label: "disposable native U4 other owner" });
  recordMesh({ space, server: servers, root, mode: "user", policy: { events: "required" }, userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
  const connector: Connector = { kind: "connector", name: "u4-seat", requires: ["node"], eventChannel,
    buildLaunch: (o) => {
      assert(o.userAuth && o.lifecycleUid);
      const env: Record<string, string> = {};
      for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "COTAL_SKIP_CONNECTOR_SEED"]) if (process.env[key]) env[key] = process.env[key]!;
      return { command: process.execPath, args: [...process.execArgv, self, "seat"], env: { ...env, COTAL_SPACE: o.space, COTAL_SERVERS: servers, COTAL_OWNER: o.userAuth.owner, COTAL_ACTOR: o.userAuth.actor, COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: o.lifecycleUid, COTAL_SENTINEL_CREDS: o.userAuth.sentinelCredsPath, COTAL_BEARER_CMD: JSON.stringify(o.userAuth.bearerCmd), U4_TRACE: tracePath } };
    },
  };
  registry.register(connector);
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", "owned.md"), "---\nname: owned\nagent: u4-seat\ncapabilities: [spawn]\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\nNative owned seat.\n");
  const state = remote.loadOrCreateRemoteManagerIdentity(root, space);
  const callArgs = { store: hostStore, dir: hostDir };
  const callAuthority = (request: Parameters<NonNullable<typeof cotalAuthProvider.managerServiceAuthority>>[0]["request"]) => cotalAuthProvider.managerServiceAuthority!({ ...callArgs, request });
  const prep = await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
  const supervisorCreds = remote.materialCredential(prep, "supervisor", state.identities.supervisor);
  const executorCreds = remote.materialCredential(prep, "executor", state.identities.executor);
  const registered = await registerRemoteManagerAuthority({ space, server: servers, owner, instanceId: state.instanceId, serveActor: remoteManagerActors(state.instanceId).serve, prepareCreds: executorCreds, tlsRequired: false,
    evict: async (principals) => {
      const request = remote.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
      const result = await cotalAuthProvider.maintainRemoteManager!({ ...callArgs, request });
      return remote.remoteManagerMaintenanceResult(result, request, owner).evictions!.map((e) => e.verifiedGone);
    },
  });
  const artifacts = managerClusterArtifacts();
  const contractArtifacts = [artifacts.document, artifacts.manifest];
  const activate = await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts), contractArtifacts }));
  const proof = remote.currentRegistrationProof(activate);
  const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: callAuthority });
  const remoteAuthority: NonNullable<ManagerOptions["remoteAuthority"]> = {
    ...standing, owner, actors: remoteManagerActors(state.instanceId), instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, identities: state.identities,
    supervisorCreds, executorCreds, serveCreds: remote.materialCredential(activate, "serve", state.identities.serve), goalWriterCreds: remote.materialCredential(activate, "goalWriter", state.identities.goalWriter), sessionLedgerCreds: remote.materialCredential(activate, "sessionLedger", state.identities.sessionLedger), serveGrant: registered.serveGrant,
    agentBearerExchangeUrl: info.publicUrl!,
    renewExecutor: async () => remote.materialCredential(await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
    runHosting: remote.remoteRunHosting({ state, owner, registrationProof: proof, accountPublicKey: standing.accountPublicKey, processEpoch: registered.processEpoch,
      requestRunAdmission: (request) => cotalAuthProvider.requestRemoteRunAdmission!({ ...callArgs, request }),
      requestRunAttempt: (request) => cotalAuthProvider.requestRemoteRunAttempt!({ ...callArgs, request }), call: callAuthority,
    }),
    authorizeAdmin: async (caller) => {
      const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
      const response = await cotalAuthProvider.authorizeRemoteManagerAdmin!({ ...callArgs, request });
      const authorized = remote.remoteManagerAdminAuthorized(response, request, owner);
      adminRequests.push({ ...caller, authorized });
      return authorized;
    },
    enrollManagedAgent: async ({ target }) => {
      enrollments++;
      const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target);
      return remote.remoteManagedAgentEnrollmentMaterial(await cotalAuthProvider.enrollRemoteManagedAgent!({ ...callArgs, request }), request);
    },
    prepareAgentRetirement: async ({ target, opId }) => {
      const request = remote.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, registered.processEpoch, target, opId);
      remote.remoteManagedAgentRetirementPrepared(await cotalAuthProvider.prepareRemoteManagedAgentRetirement!({ ...callArgs, request }), request);
    },
    mintRetirementRequester: async ({ identity, target, opId, serveEpoch }) => remote.materialCredential(await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "retire", { registrationProof: remoteManagerRegistrationProof(owner, state), retirement: { id: identity.id, target, opId, serveEpoch } })), "retirementRequester", identity),
    mintSessionServing: async () => { throw new Error("fixture does not request attach sessions"); },
    validateRetainedAgent: async () => { throw new Error("fixture starts no retained seat"); },
    scanGoalIndex: async () => {
      const request = { v: 1 as const, kind: "manager-goal-index-scan" as const, space, actor: "cli", instanceId: state.instanceId, managerLifecycleUid: state.lifecycleUid, requestId: `scan${mintLifecycleUid()}`, registrationProof: proof, serveEpoch: registered.processEpoch, identities: remote.publicIdentities(state) };
      return remote.remoteManagerGoalIndexEntries(await cotalAuthProvider.scanRemoteManagerGoalIndex!({ ...callArgs, request }), request, owner);
    },
  };
  manager = new Manager({ space, servers, workspaceRoot: root, runtime: "pty", remoteAuthority, eventsRequired: true });
  await manager.start();
  const connectorBoundary = manager as unknown as { resolveConnector: (agent: string) => Promise<Connector> };
  const resolveConnector = connectorBoundary.resolveConnector.bind(manager);
  connectorBoundary.resolveConnector = async (agent) => { connectorResolutions++; return resolveConnector(agent); };
  const view = { ...callArgs, space, actor: "cli", view: "manager-caller", managerInstanceId: state.instanceId };
  const material = await cotalAuthProvider.userCredentials(view);
  const controlOpts = standaloneConnectOpts({ ...material, tls: false });
  const controlNc = await connect({ servers, ...controlOpts, maxReconnectAttempts: 0 });
  connections.push(controlNc);
  const caller = await issuedUserCaller(controlNc, space, controlOpts.name as string, { owner, actor: "cli", uid: row.lifecycleUid! });
  const controlService = await resolveService(controlNc, space, "manager", caller, { instanceId: state.instanceId });
  const endpoint = { invokeService: (_endpoint: string, command: string, args?: Record<string, unknown>, opts: { deadlineMs?: number } = {}) => invokeCommand(controlNc, space, controlService, command, args, { deadlineMs: opts.deadlineMs ?? 10_000, ...(command === "run-answer" ? { target: { mode: "self" as const } } : {}) }) };
  const observer = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "observer"), channels: [], consume: false, registerPresence: false, watchPresence: true, watchChannels: false, card: { name: "native-roster-observer", kind: "endpoint" } });
  observer.on("error", () => {}); endpoints.push(observer); await observer.start();
  const hosting = (manager as unknown as { runHosting: RunHosting }).runHosting;
  const start = async (source: string) => String(successful(await endpoint.invokeService("manager", "run-start", { source, file: "native-u4.cotal.js" }, { deadlineMs: 20_000 })).runId);
  const status = async (runId: string) => successful(await endpoint.invokeService("manager", "run-status", { runId }, { deadlineMs: 10_000 }));
  const program = `const seat = await spawn("owned"); await turn(seat, { name: "work", deadline: "20s" }); const answer = await ask(seat, { name: "estimate", schema: { estimate: "number", ready: "boolean" }, deadline: "20s" }); log("estimate", answer.estimate); await checkpoint("hold", "Inspect the native seat", { timeout: "1m" });`;
  mainRun = await start(program);
  await until(() => trace().some((e) => e.kind === "answer" && e.ok === true && e.run === mainRun), "native turn/ask answer", 40_000);
  const derived = runDriverCaller(mainRun, owner);
  const mapped = hosting.admittedCaller(derived);
  const slots = (hosting as unknown as { runs: Map<string, { mediatorNc: Awaited<ReturnType<typeof connect>>; mediatorCreds: string }> }).runs;
  const slot = slots.get(mainRun)!;
  const admission = await readRunAdmission(await jetstreamManager(slot.mediatorNc), space, "manager", mainRun);
  check("U4-1 native admitted run spawns, turns and receives the seat's typed answer", trace().some((e) => e.kind === "yield" && e.ok === true) && trace().some((e) => e.kind === "answer" && e.ok === true));
  check("U4-1 caller attribution is the stock issued admission, not fixture-selected run authority", admission.admission.caller.owner === caller.owner && admission.admission.caller.actor === caller.actor && admission.admission.caller.uid === caller.uid && admission.admission.provenance.kind === "issued");
  check("U4-2 live run driver maps to admitted owner actor and lifecycle", mapped?.owner === owner && mapped.actor === "cli" && mapped.uid === row.lifecycleUid);
  check("U4-2 outside a held run has no admitted-caller mapping", hosting.admittedCaller(runDriverCaller("unheld-run", owner)) === undefined && hosting.admittedCaller({ owner, actor: "cli", uid: row.lifecycleUid! }) === undefined);
  check("U4-2 native admin seam resolves the admitted ledger row, never synthetic actor", adminRequests.some((r) => r.owner === owner && r.actor === "cli" && r.lifecycleUid === row.lifecycleUid && r.authorized) && !adminRequests.some((r) => r.actor === derived.actor));
  const native = trace().find((e) => e.kind === "joined")!;
  const managed = (successful(await endpoint.invokeService("manager", "ps")) as unknown as Array<{ name: string; id: string; lifecycleUid: string; spawner: string }>).find((a) => a.name === "owned");
  check("U4-1 spawned lifecycle and caller attribution match the actual native process", managed?.id === `${owner}.owned` && managed.lifecycleUid === native.uid && managed.spawner === `${owner}.${derived.actor}`);
  const defined = loadAgentFile(join(root, ".cotal", "agents", "owned_content.md"));
  check("U4-7 run-driven seat writes content through stock self-persona writer", trace().some((e) => e.kind === "persona" && e.ok === true) && defined.owner === `${owner}.owned` && defined.capabilities === undefined);
  const unknown = await endpoint.invokeService("manager", "define-persona", { name: "injected", persona: "x", capabilities: ["admin"], owner: `${otherOwner}.cli` }).catch((e: unknown) => ({ reply: { ok: false, error: { message: String(e) } } }));
  check("U4-7 unknown persona policy and owner fields refuse before writer", !unknown.reply.ok && !existsSync(join(root, ".cotal", "agents", "injected.md")));
  const foreign = await endpoint.invokeService("manager", "define-persona", { name: "owned_content", persona: "take over another actor's content" });
  check("U4-3 another actor cannot redefine known owned persona", !foreign.reply.ok && /not authorized/.test(foreign.reply.error?.message ?? "") && loadAgentFile(join(root, ".cotal", "agents", "owned_content.md")).owner === `${owner}.owned`);
  // B authenticates its own genuine session. Its admin row does not confer admin at A's manager.
  saveIdpSession(home, idpUrl, { token: signupB.token, sub: signupB.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const bMaterial = await cotalAuthProvider.userCredentials({ ...callArgs, space, actor: "cli" });
  saveIdpSession(home, idpUrl, { token: signup.token, sub: signup.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const bEndpoint = new CotalEndpoint({ space, servers, ...bMaterial, lifecycleUid: findActorUnified(hostDir, otherOwner, "cli")!.lifecycleUid, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { owner: otherOwner, actor: "cli", name: "fixture-other-owner", kind: "endpoint" } });
  bEndpoint.on("error", () => {}); endpoints.push(bEndpoint); await bEndpoint.start();
  const bPersona = await bEndpoint.invokeService("manager", "define-persona", { name: "b_content", persona: "B's content", agent: "u4-seat" });
  check("U4-3 native other-owner persona remains stamped under its authenticated principal", bPersona.reply.ok && loadAgentFile(join(root, ".cotal", "agents", "b_content.md")).owner === `${otherOwner}.cli`);
  const aChangesB = await endpoint.invokeService("manager", "define-persona", { name: "b_content", persona: "A cannot replace B" });
  check("U4-3 admitted owner cannot replace another owner's known persona", !aChangesB.reply.ok && /not authorized/.test(aChangesB.reply.error?.message ?? ""));
  grantActor(hostDir, { ...row, owner, actor: "cli", scope: ["spawn", "run", "supervise"], lifecycleUid: row.lifecycleUid });
  const beforeForeign = { connectorResolutions, enrollments };
  const foreignPersonaRun = await start('await spawn("b_content"); await checkpoint("foreign-hold", "Inspect refused foreign content", { timeout: "1m" });');
  let foreignRunStatus: Record<string, unknown>;
  await until(async () => {
    foreignRunStatus = await status(foreignPersonaRun);
    return ((foreignRunStatus.journal as Array<{ effect?: string; state?: string }>).some((e) => e.effect === "spawn" && e.state === "settled")) || trace().some((e) => e.kind === "joined" && e.actor === "b_content");
  }, "foreign persona spawn reached its real terminal");
  const foreignRows = successful(await endpoint.invokeService("manager", "ps")) as unknown as Array<{ name: string; id: string; spawner: string }>;
  const foreignLive = foreignRows.find((a) => a.name === "b_content");
  const foreignEntry = (foreignRunStatus!.journal as Array<{ effect?: string; state?: string; status?: string; errorCode?: string }>).find((e) => e.effect === "spawn" && e.state === "settled");
  const namedRefusal = await endpoint.invokeService("manager", "spawn", { name: "b_content", events: true });
  check("U4-3 admitted non-admin run cannot spawn another owner's known persona", foreignLive === undefined && foreignEntry?.status === "failed" && foreignEntry.errorCode === "L4000" && !namedRefusal.reply.ok && namedRefusal.reply.error?.message === 'no persona "b_content"');
  if (foreignLive !== undefined) {
    check("U4 blocker witness is a live run-owned seat from B's unchanged persona", foreignLive.id === `${owner}.b_content` && foreignLive.spawner === `${owner}.${runDriverCaller(foreignPersonaRun, owner).actor}` && loadAgentFile(join(root, ".cotal", "agents", "b_content.md")).owner === `${otherOwner}.cli` && !findActorUnified(hostDir, owner, "cli")!.scope.includes("admin"));
    console.log("U4_PRODUCT_BLOCKER: non-admin A run launched B-owned b_content as A's managed seat; B's persona owner is unchanged and the native row attributes the spawn to A's run driver.");
    throw new Error("U4-CROSS-OWNER-PERSONA-SPAWN: admitted non-admin run launched another owner's known persona");
  }
  const directForeign = await manager.startAgent({ name: "b_content", config: join(root, ".cotal", "agents", "b_content.md") }, `${owner}.cli`);
  check("U4 persona direct config path refuses foreign content without owner disclosure", !directForeign.ok && directForeign.error === 'no persona "b_content"');
  const held = manager as unknown as { agents: Map<string, unknown>; reserved: Set<string>; goalAcceptances: Map<string, { name: string }> };
  check("U4 persona foreign refusal precedes connector enrollment goal acceptance and reservation", connectorResolutions === beforeForeign.connectorResolutions && enrollments === beforeForeign.enrollments && !held.agents.has("b_content") && !held.reserved.has("b_content") && ![...held.goalAcceptances.values()].some((a) => a.name === "b_content"));
  const sameOwnerDefined = await endpoint.invokeService("manager", "define-persona", { name: "a_content", persona: "A's private content", agent: "u4-seat" });
  check("U4 persona same-principal definition stays launchable to its admitted non-admin run", sameOwnerDefined.reply.ok);
  const sameOwnerRun = await start('await spawn("a_content");');
  await until(async () => ["completed", "failed"].includes(((await status(sameOwnerRun)).status as { state: string }).state), "same-owner persona native run");
  check("U4 persona admitted caller mapping permits its own private content", ((await status(sameOwnerRun)).status as { state?: string }).state === "completed" && trace().some((e) => e.kind === "joined" && e.actor === "a_content"));
  writeFileSync(join(root, ".cotal", "agents", "a_config.md"), `---\nname: a_config\nagent: u4-seat\nowner: ${owner}.cli\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\nNative direct owner content.\n`);
  const directOwn = await manager.startAgent({ name: "a_config", config: join(root, ".cotal", "agents", "a_config.md") }, `${owner}.cli`);
  if (directOwn.ok) await until(() => trace().some((e) => e.kind === "joined" && e.actor === "a_config"), "direct same-principal child presence");
  check("U4 persona direct same-principal config stays launchable", directOwn.ok && trace().some((e) => e.kind === "joined" && e.actor === "a_config"));
  writeFileSync(join(root, ".cotal", "agents", "shared.md"), "---\nname: shared\nagent: u4-seat\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\nUnowned operator content.\n");
  const sharedRun = await start('await spawn("shared");');
  await until(async () => ((await status(sharedRun)).status as { state?: string }).state === "completed", "unowned shared persona native run");
  check("U4 persona non-admin admitted run may launch unowned operator content", trace().some((e) => e.kind === "joined" && e.actor === "shared"));
  grantActor(hostDir, { ...row, owner, actor: "cli", scope: ["spawn", "run", "supervise", "admin"], lifecycleUid: row.lifecycleUid });
  const adminRun = await start('await spawn("b_content");');
  await until(async () => ["completed", "failed"].includes(((await status(adminRun)).status as { state: string }).state), "current admin native persona run");
  check("U4 persona current native admin may launch a foreign card without changing its owner", ((await status(adminRun)).status as { state?: string }).state === "completed" && trace().some((e) => e.kind === "joined" && e.actor === "b_content") && loadAgentFile(join(root, ".cotal", "agents", "b_content.md")).owner === `${otherOwner}.cli`);
  grantActor(hostDir, { ...row, owner, actor: "cli", scope: ["spawn", "run", "supervise"], lifecycleUid: row.lifecycleUid });
  const demoted = await endpoint.invokeService("manager", "spawn", { name: "b_content", events: true });
  check("U4 persona demoted current admin loses foreign spawn on its next served call", !demoted.reply.ok && demoted.reply.error?.message === 'no persona "b_content"');
  grantActor(hostDir, { ...row, owner, actor: "cli", scope: ["spawn", "run", "supervise", "admin"], lifecycleUid: row.lifecycleUid });
  const bSpawn = await bEndpoint.invokeService("manager", "spawn", { name: "owned", events: true });
  check("U4-3 cross-owner event arming refuses by current admin gate before enrollment", !bSpawn.reply.ok && /admin/.test(bSpawn.reply.error?.message ?? ""));
  const target = { mode: "any" as const, owner, actor: "owned", lifecycleUid: native.uid as string };
  for (const command of ["turn", "despawn"] as const) {
    const refused = await bEndpoint.invokeService("manager", command, command === "turn" ? { payload: "foreign turn", deadlineMs: 1000 } : { graceful: true }, { target });
    check(`U4-3 other owner's actor cannot ${command} the known native seat`, !refused.reply.ok && refused.reply.error?.code === "permission-denied" && /admin/.test(refused.reply.error.message));
  }
  const wrong = await endpoint.invokeService("manager", "run-start", { source: `await spawn("owned", { placement: { endpoint: "manager", instanceId: "${mintLifecycleUid()}" }, cwd: "${root}" });` }, { deadlineMs: 10_000 });
  check("U4-4 wrong placement refuses before run acceptance by instance name", !wrong.reply.ok && wrong.reply.error?.code === "unimplemented" && /own instance/.test(wrong.reply.error.message));
  await until(async () => ((await status(mainRun!)).journal as Array<{ step?: string }>).some((e) => e.step === "/checkpoint:hold#0"), "native checkpoint recorded");
  successful(await endpoint.invokeService("manager", "run-answer", { runId: mainRun, stepKey: "/checkpoint:hold#0", value: "release" }));
  await until(async () => ((await status(mainRun!)).status as { state?: string } | undefined)?.state === "completed", "run completion", 30_000);
  await until(() => !observer.getRoster().some((p) => p.card.id === `${owner}.owned` && p.status !== "offline"), "native seat leaves roster", 20_000);
  const after = successful(await endpoint.invokeService("manager", "ps")) as unknown as Array<{ name: string }>;
  check("U4-5 completed run releases its native seat without operator intervention", !after.some((a) => a.name === "owned"));
  check("U4-2 completed run no longer maps an admitted caller", hosting.admittedCaller(derived) === undefined);
  // A placed run uses only the participant registration. The auth host sees no workflow source.
  writeFileSync(join(root, ".cotal", "agents", "placed.md"), "---\nname: placed\nagent: u4-seat\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\nNative placed seat.\n");
  const placedRun = await start(`await spawn("placed", { placement: { endpoint: "manager", instanceId: "${state.instanceId}" }, cwd: "${root}" }); await checkpoint("placed-hold", "Inspect placed seat", { timeout: "1m" });`);
  await until(async () => ((await status(placedRun)).journal as Array<{ step?: string }>).some((e) => e.step === "/checkpoint:placed-hold#0"), "placed native spawn settled");
  const placedSlot = slots.get(placedRun)!;
  const mediatorJwt = placedSlot.mediatorCreds.split("\n").find((line) => line.split(".").length === 3)!;
  const mediatorClaims = JSON.parse(Buffer.from(mediatorJwt.split(".")[1]!, "base64url").toString("utf8")) as { nats: { pub: { allow: string[] } } };
  check("U4-4 native placed spawn uses its registered participant instance", trace().some((e) => e.kind === "joined" && e.actor === "placed") && mediatorClaims.nats.pub.allow.some((s) => s.includes(`.ep.inst.manager.${state.instanceId}.spawn.`)));
  successful(await endpoint.invokeService("manager", "run-answer", { runId: placedRun, stepKey: "/checkpoint:placed-hold#0", value: "release" }));
  await until(async () => ((await status(placedRun)).status as { state?: string }).state === "completed", "placed run completed");
  check("U4-5 native placed seat leaves managed status after successful run", !(successful(await endpoint.invokeService("manager", "ps")) as unknown as Array<{ name: string }>).some((a) => a.name === "placed"));
  // A retained native run's next host admin question reads the live actor row, not its old bearer.
  const revocationRun = await start('await checkpoint("grant-hold", "Inspect live grant", { timeout: "1m" });');
  const revokedCaller = runDriverCaller(revocationRun, owner);
  const managerGate = manager as unknown as { epAdminReach(c: EpCaller): Promise<boolean> };
  check("U4-6 retained run admin reach starts from actual admitted actor ledger row", await managerGate.epAdminReach(revokedCaller));
  grantActor(hostDir, { ...row, owner, actor: "cli", scope: ["spawn", "run", "supervise"], lifecycleUid: row.lifecycleUid });
  check("U4-6 narrowed live grant demotes the next run-driven admin call", await managerGate.epAdminReach(revokedCaller) === false);
  grantActor(hostDir, { ...row, owner, actor: "cli", scope: ["spawn", "run", "supervise", "admin"], lifecycleUid: row.lifecycleUid });
  check("U4-6 restored exact incarnation regains only its current admin scope", await managerGate.epAdminReach(revokedCaller));
  revokeActor(hostDir, owner, "cli");
  check("U4-6 revoked admitted actor refuses admin at next host call", await managerGate.epAdminReach(revokedCaller).then((v) => v === false, () => true));
  grantActor(hostDir, { ...row, owner, actor: "cli", scope: ["spawn", "run", "supervise", "admin"], lifecycleUid: mintLifecycleUid() });
  check("U4-6 re-grant cannot authorize a predecessor run caller lifecycle", await managerGate.epAdminReach(revokedCaller) === false);
  grantActor(hostDir, { ...row, owner, actor: "cli", scope: ["spawn", "run", "supervise", "admin"], lifecycleUid: row.lifecycleUid });
  await until(async () => ((await status(revocationRun)).journal as Array<{ step?: string }>).some((e) => e.step === "/checkpoint:grant-hold#0"), "revocation run checkpoint");
  successful(await endpoint.invokeService("manager", "run-answer", { runId: revocationRun, stepKey: "/checkpoint:grant-hold#0", value: "release" }));
  await until(async () => ((await status(revocationRun)).status as { state?: string }).state === "completed", "revocation run released");
  console.log("U4_DEPENDENCY: true managed-seat run-start requires U1, which is not in this base; native control uses the admitted interactive user path.");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.log(`U4 native seat trace: ${JSON.stringify(trace()).slice(0, 2400)}`);
  failed++;
  console.error(`  ✗ FAIL: U4 native fixture completed all requested cells: ${fatal.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]").slice(0, 500)}`);
} finally {
  for (const connection of connections) await connection.close();
  for (const endpoint of endpoints.reverse()) await endpoint.stop().catch(() => {});
  await manager?.stop({ withAgents: true }).catch(() => {});
  if (authChild) await killAndAwaitExit(authChild).catch(() => {});
  await delivery?.stop().catch(() => {});
  if (broker) await killAndAwaitExit(broker).catch(() => {});
  if (idpServer) await new Promise<void>((r) => idpServer!.close(() => r()));
  if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome;
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`RUN OWNED AGENTS SMOKE (${passed} passed, ${failed} failed)`);
process.exitCode = failed === 0 && !fatal ? 0 : 1;
