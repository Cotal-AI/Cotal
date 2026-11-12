/** Live device approvals and a real no-execution Manager, with isolated operator/service stores.
 * Run with tsx. Requires nats-server on PATH. No Cloud, OS services, or external stores. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { toNodeHandler } from "better-auth/node";
import { mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams, type RemoteManagerAuthorityRequest, type RemoteManagerAuthorityMaterial } from "@cotal-ai/core";
import { spaceKey } from "@cotal-ai/workspace";
import { killAndAwaitExit } from "@cotal-ai/smoke-kit";
import { Manager, remoteManagerClient as client, registerRemoteManagerAuthority, managerClusterArtifacts, type ManagerOptions } from "../../manager/dist/index.js";
import { startAuthService, fetchIdpJwt, requireIdpSession, revokeIdpSession, loadIdpSession, IdpSessionRejectedError } from "../src/index.js";
import { remoteManagerRegistrationProof } from "../src/authority-client.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { approveDevice } from "./_device-approval.js";
import { bootDeliveryDaemon } from "../../manager/smoke/_boot-delivery.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, label: string, timeout = 35_000) {
  const end = Date.now() + timeout;
  while (!check() && Date.now() < end) await wait(100);
  assert.ok(check(), label);
}
const root = mkdtempSync(join(tmpdir(), "login-service-stores-"));
const home = join(root, "operator");
mkdirSync(home);
let handler: ReturnType<typeof toNodeHandler> | undefined;
const http = createServer((req, res) => handler!(req, res));
const children = new Set<ChildProcess>();
let fx: Awaited<ReturnType<typeof startHostedAuthFixture>> | undefined;
let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let manager: Manager | undefined;
const originalError = console.error;
let renewalErrors = 0;
// Keep only the classified timer failure, never authority material or session tokens.
console.error = (...args: unknown[]) => {
  if (args.some((v) => typeof v === "string" && v.includes("remote manager all-duty renewal:"))) {
    if (args.some((v) => String(v).includes("rejected the cached session (expired or revoked)"))) renewalErrors++;
    originalError("Manager remote manager all-duty renewal: refused (private service session)");
  } else originalError(...args);
};
try {
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`, base = `${origin}/api/auth`;
  const auth = betterAuth({ baseURL: origin, secret: "smoke-only-better-auth-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [jwt({ jwt: { issuer: origin, audience: origin, expirationTime: "1s" } }), deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id) => id === "cotal-cli" }), bearer()],
  });
  handler = toNodeHandler(auth);
  const signup = await auth.api.signUpEmail({ body: { email: "human@example.test", password: "correct-horse-battery", name: "Human" }, returnHeaders: true });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  let mixedLoginExit: number | null | undefined;
  async function login(store?: string, mixed = false) {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), COTAL_SKIP_CONNECTOR_SEED: "1" };
    delete env.COTAL_HOME;
    if (store) Object.assign(env, { COTAL_HOME: store });
    const child = spawn(process.execPath, ["--import", "tsx", resolve("bin/cotal.ts"), "login", "--idp", base, "--no-browser", "--plain"], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let output = "", approved = false;
    let approval: Promise<void> | undefined;
    const absorb = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
      const code = /user_code=([^\s\u001b]+)/.exec(output)?.[1];
      if (code && !approved) { approved = true; approval = approveDevice({ base, origin, cookie }, decodeURIComponent(code)); approval.catch(() => {}); }
    };
    child.stdout!.on("data", absorb); child.stderr!.on("data", absorb);
    const deadline = setTimeout(() => child.kill("SIGTERM"), 30_000);
    try {
      const code = await new Promise<number | null>((r, reject) => { child.once("error", reject); child.once("exit", r); });
      await approval;
      assert.ok(approved, "real CLI emitted a device approval prompt");
      if (mixed) mixedLoginExit = code;
      else assert.equal(code, 0, "real cotal login completed after real device approval");
      return output;
    } finally { clearTimeout(deadline); await killAndAwaitExit(child, "SIGKILL"); children.delete(child); }
  }
  await login();
  const operatorStore = join(home, ".cotal");
  const operatorSession = requireIdpSession(operatorStore, base);
  fx = await startHostedAuthFixture("login-stores", 1);
  const a = fx.accounts[0]!;
  const unitDir = join(home, ".config", "systemd", "user"), key = spaceKey(a.space);
  const serviceHome = join(unitDir, "cotal-service", key);
  mkdirSync(serviceHome, { recursive: true });
  const envPath = join(serviceHome, `cotal-manager@${key}.env`);
  const workspaceRoot = join(root, "workspace"); mkdirSync(workspaceRoot);
  const render = (file: string, values: Record<string, string>) => readFileSync(resolve("bin/smoke/fixtures", file), "utf8").replace(/@([A-Z_]+)@/g, (_, name: string) => { assert.ok(name in values); return values[name]!; });
  writeFileSync(envPath, render("pre-cut-manager-unit.env", { PATH: process.env.PATH!, SPACE: a.space, SERVER: fx.servers, STATE_DIR: serviceHome }), { mode: 0o600 });
  const unit = render("pre-cut-manager-unit.service", { MESH: a.space, ROOT: workspaceRoot, WORKING_DIRECTORY: workspaceRoot, ENVIRONMENT_FILE: envPath, ENTRY: `${process.execPath} --import tsx ${resolve("bin/cotal.ts")}` });
  writeFileSync(join(unitDir, `cotal-manager@${key}.service`), unit, { mode: 0o600 });
  assert.ok(unit.includes("# installed by `cotal service install`") && unit.includes(`# cotal-mesh: ${a.space}`) && unit.includes(`# cotal-root: ${workspaceRoot}`) && /ExecStart=.* supervise\n/.test(unit));
  await login(serviceHome);
  const serviceSession = requireIdpSession(serviceHome, base);
  assert.notEqual(operatorSession.token, serviceSession.token, "two device grants issued independent sessions");
  console.log("PASS real CLI device approvals persisted independent operator and service sessions");
  const state = client.loadOrCreateRemoteManagerIdentity(workspaceRoot, a.space);
  const assignment = { v: 1 as const, space: a.space, accountPublicKey: a.accountPublicKey, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, assignmentRevision: 1, state: "assigned" as const };
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, platformControl: { observeAssignment: async () => assignment }, standingRenewableTtlSeconds: 20 });
  let renewed = 0, refused = 0;
  // This host callback proves the private session at the real IdP before calling the actual
  // platform authority. It is not the provider HTTP discovery path: the hosted fixture keeps
  // its unrelated pinned IdP, and no JWT is submitted to that fixture's bridge.
  const door = async (request: any): Promise<any> => {
    try { await fetchIdpJwt(base, requireIdpSession(serviceHome, base).token); }
    catch (e) { if (request.operation === "renewStandingBundle" && e instanceof IdpSessionRejectedError && e.message.includes("rejected the cached session (expired or revoked)")) refused++; throw e; }
    const result = await service!.platformControlAuthority!({ v: 1, kind: "platform-control-authority", space: a.space, accountPublicKey: a.accountPublicKey, assignmentRevision: 1, request });
    if (request.operation === "renewStandingBundle") renewed++;
    return result;
  };
  const prepared = await door(client.remoteManagerAuthorityRequest(state, "cli", "prepare"));
  const registered = await registerRemoteManagerAuthority({ space: a.space, server: fx.servers, owner: prepared.owner, instanceId: state.instanceId, serveActor: prepared.actors.serve, prepareCreds: client.materialCredential(prepared, "executor", state.identities.executor), tlsRequired: false, evict: async (principals) => {
    const request = client.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
    return client.remoteManagerMaintenanceResult(await door(request), request, prepared.owner).evictions!.map((e) => e.verifiedGone);
  } });
  const artifacts = managerClusterArtifacts(), contractArtifacts = [artifacts.document, artifacts.manifest];
  const active = await door(client.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof: remoteManagerRegistrationProof(prepared.owner, state, contractArtifacts), contractArtifacts }));
  const proof = client.currentRegistrationProof(active), supervisorCreds = client.materialCredential(prepared, "supervisor", state.identities.supervisor);
  const remote: NonNullable<ManagerOptions["remoteAuthority"]> = {
    ...client.remoteStandingBundleRenewal({ state, owner: prepared.owner, registrationProof: proof, supervisorCreds, call: (request: RemoteManagerAuthorityRequest) => door(request) as Promise<RemoteManagerAuthorityMaterial> }),
    owner: prepared.owner, actors: active.actors, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, identities: state.identities, supervisorCreds,
    executorCreds: client.materialCredential(prepared, "executor", state.identities.executor), serveCreds: client.materialCredential(active, "serve", state.identities.serve), goalWriterCreds: client.materialCredential(active, "goalWriter", state.identities.goalWriter), sessionLedgerCreds: client.materialCredential(active, "sessionLedger", state.identities.sessionLedger), serveGrant: registered.serveGrant,
    renewExecutor: async () => client.materialCredential(await door(client.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
    scanGoalIndex: async () => { const request = client.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch); return client.remoteManagerGoalIndexEntries(await door(request), request, prepared.owner); },
    mintSessionServing: async (args) => client.materialCredential(await door(client.remoteManagerAuthorityRequest(state, "cli", "session", { registrationProof: remoteManagerRegistrationProof(prepared.owner, state), session: { id: args.identity.id, endpoint: args.endpoint, sessionId: args.sessionId, epoch: args.epoch, exp: args.exp } })), "sessionServing", args.identity),
    mintRetirementRequester: async (args) => client.materialCredential(await door(client.remoteManagerAuthorityRequest(state, "cli", "retire", { registrationProof: remoteManagerRegistrationProof(prepared.owner, state), retirement: { id: args.identity.id, target: args.target, opId: args.opId, serveEpoch: args.serveEpoch } })), "retirementRequester", args.identity),
    prepareAgentRetirement: async (args) => { await door(client.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, registered.processEpoch, args.target, args.opId)); },
    validateRetainedAgent: async (args) => { const request = client.remoteRetainedAgentValidationRequest(state, "cli", proof, registered.processEpoch, args, args.actorToken, args.sentinelCreds); return client.retainedAgentAuthority(await door(request), request); },
    authorizeParticipation: async (caller) => { const request = client.remoteManagerParticipationAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller); return client.remoteManagerParticipationAuthorized(await door(request), request, prepared.owner); },
    authorizeAdmin: async (caller) => { const request = client.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller); return client.remoteManagerAdminAuthorized(await door(request), request, prepared.owner); },
    agentBearerExchangeUrl: service.url,
  };
  manager = new Manager({ space: a.space, servers: fx.servers, workspaceRoot, pooled: true, execution: "none", remoteAuthority: remote });
  await manager.start();
  assert.ok((await service.platformControlReadiness!(state.instanceId)).reply.ok, "real Manager status readiness");
  console.log("PASS real broker/auth-service/Manager readiness with 20s standing TTL");
  await until(() => renewed > 0, "real Manager timer renewed before revocation");
  // Seed a second real device session before adding its per-instance local override.
  // Neither the unit nor its private store may be interpreted through that drop-in.
  const skippedKey = spaceKey(`${a.space}-overridden`);
  const skippedHome = join(unitDir, "cotal-service", skippedKey);
  mkdirSync(skippedHome, { recursive: true });
  await login(skippedHome);
  const skippedEnv = join(skippedHome, `cotal-manager@${skippedKey}.env`);
  writeFileSync(skippedEnv, render("pre-cut-manager-unit.env", { PATH: process.env.PATH!, SPACE: `${a.space}-overridden`, SERVER: fx.servers, STATE_DIR: skippedHome }), { mode: 0o600 });
  const skippedService = `cotal-manager@${skippedKey}.service`;
  writeFileSync(join(unitDir, skippedService), render("pre-cut-manager-unit.service", { MESH: `${a.space}-overridden`, ROOT: workspaceRoot, WORKING_DIRECTORY: workspaceRoot, ENVIRONMENT_FILE: skippedEnv, ENTRY: `${process.execPath} --import tsx ${resolve("bin/cotal.ts")}` }), { mode: 0o600 });
  const dropin = join(unitDir, `${skippedService}.d`);
  mkdirSync(dropin);
  writeFileSync(join(dropin, "telemetry-off.conf"), "[Service]\nEnvironment=DO_NOT_TRACK=1\n", { mode: 0o600 });
  const skippedBefore = readFileSync(join(skippedHome, "idp-sessions.json"), "utf8");
  // The independent seed login can refresh the proven service, so revoke its
  // current handle before testing the mixed default-home reapproval.
  await revokeIdpSession(base, requireIdpSession(serviceHome, base).token);
  await until(() => refused > 0 && renewalErrors > 0, "real Manager timer logged refusal after service session revocation");
  const successes = renewed;
  const receipt = await login(undefined, true);
  // Collect both real CLI outcomes before asserting, so unchanged code proves the
  // independent logout defect even when login aborts before its complete report.
  const mixedFailures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) mixedFailures.push(message); };
  check(mixedLoginExit === 0, "mixed-unit login exits successfully");
  check(requireIdpSession(serviceHome, base).token === requireIdpSession(operatorStore, base).token, "proven sibling received approved session despite skipped unit");
  check(readFileSync(join(skippedHome, "idp-sessions.json"), "utf8") === skippedBefore, "skipped service store remains byte-for-byte unchanged after login");
  const completeLoginReport = receipt.includes("Signed in") && receipt.includes("Account") && receipt.includes("Subject") && receipt.includes("Provider") && receipt.includes("Next") && receipt.includes("cotal sync");
  check(completeLoginReport, "mixed-unit login prints complete account and next-step report");
  check(receipt.includes(skippedService) && /overrid|skipp/i.test(receipt) && /\blogs?\b/i.test(receipt), "mixed-unit login names skipped service and points to its own log remedy");
  console.log(`OBSERVED mixed-unit login exit=${mixedLoginExit}; proven-refreshed=${requireIdpSession(serviceHome, base).token === requireIdpSession(operatorStore, base).token}; complete-report=${completeLoginReport}`);
  const logoutEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), COTAL_SKIP_CONNECTOR_SEED: "1" };
  delete logoutEnv.COTAL_HOME;
  // Run logout after the renewal check below, keeping the refreshed session alive meanwhile.
  const logout = async () => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("bin/cotal.ts"), "logout", "--idp", base, "--plain"], { env: logoutEnv, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let output = "";
    child.stdout!.on("data", chunk => { output += chunk.toString(); });
    child.stderr!.on("data", chunk => { output += chunk.toString(); });
    const deadline = setTimeout(() => child.kill("SIGTERM"), 30_000);
    try {
      const code = await new Promise<number | null>((r, reject) => { child.once("error", reject); child.once("exit", r); });
      check(code === 0, "mixed-unit logout exits successfully");
      check(!loadIdpSession(operatorStore, base), "real logout clears source operator session despite skipped unit");
      check(!loadIdpSession(serviceHome, base), "real logout clears proven shared service session");
      check(readFileSync(join(skippedHome, "idp-sessions.json"), "utf8") === skippedBefore, "skipped service store remains byte-for-byte unchanged after logout");
      check(output.includes("Next"), "mixed-unit logout prints complete report");
      check(output.includes(skippedService) && /overrid|skipp/i.test(output) && /\blogs?\b/i.test(output), "mixed-unit logout names skipped service and points to its own log remedy");
      console.log(`OBSERVED mixed-unit logout exit=${code}; source-cleared=${!loadIdpSession(operatorStore, base)}`);
    } finally { clearTimeout(deadline); await killAndAwaitExit(child, "SIGKILL"); children.delete(child); }
    assert.deepEqual(mixedFailures, [], "real mixed-unit login/logout regression");
  };
  if (mixedFailures.length) { await logout(); }

  assert.ok(receipt.includes(`Signed in cotal-manager@${key}.service with the same approval.`), "login names the refreshed Manager service");
  assert.equal(receipt.includes(requireIdpSession(operatorStore, base).token), false, "receipt does not print the approved token");
  assert.notEqual(requireIdpSession(operatorStore, base).token, operatorSession.token);
  const priorRefusals = refused, priorErrors = renewalErrors;
  await until(() => renewed > successes || refused > priorRefusals && renewalErrors > priorErrors, "real Manager timer runs after default-home reapproval");
  if (process.argv.includes("--observe-baseline")) {
    assert.equal(renewed, successes, "default-home approval never restores private service authority");
    assert.ok(refused > priorRefusals && renewalErrors > priorErrors);
    console.log("PASS observed baseline: real Manager renewal remains refused after default-home device reapproval");
  } else {
    assert.ok(renewed > successes, "default-home reapproval must restore installed service Manager renewal (known baseline defect: private session remains rejected)");
    assert.equal(requireIdpSession(serviceHome, base).token, requireIdpSession(operatorStore, base).token, "service received the approved operator session");
    await wait(500);
    assert.ok((await service.platformControlReadiness!(state.instanceId)).reply.ok, "same Manager answers real status after session refresh");
    console.log("PASS default-home approval refreshed the service store and real Manager renewal");
  }
  await logout();
  console.log("PASS real CLI mixed proven/per-instance-drop-in login and logout");
} finally {
  for (const child of children) await killAndAwaitExit(child, "SIGKILL");
  try { await manager?.stop({ withAgents: true }); } finally {
    try { await service?.close(); } finally {
      try { await delivery?.stop(); } finally { await fx?.close(); }
    }
  }
  console.error = originalError;
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}
